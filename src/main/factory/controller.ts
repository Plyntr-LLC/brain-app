import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StreamEvent } from '../ai-cli'
import { buildBrief, type BriefPhase } from './brief.ts'
import { auditTurn, commitRun, diffText, gitTop, headSha, isClean, isGitRepo, numstat, porcelain } from './git-audit.ts'
import { realish } from './paths.ts'
import {
  acquireLock,
  activeRunFor,
  holdsLock,
  listRuns,
  loadRun,
  releaseLock,
  saveRun,
  TERMINAL_PHASES,
  type RunPhase,
  type RunRecord,
  type VerifyRow
} from './run-store.ts'
import { triage } from './triage.ts'
import { checkTripwire } from './tripwire.ts'

/**
 * Factory run controller. Owns triage, phases, verify, review, and commit. The model only does
 * the current phase brief; it never picks tier, pushes, or decides what is next.
 */

export type FactoryEvent = { runId: string; kind: 'run'; run: RunRecord } | { runId: string; kind: 'stream'; ev: StreamEvent }

export type Driver = {
  warm: (o: { tabId: string; brainPath: string; workRepo: string; resumeId?: string }) => Promise<{ sessionId: string }>
  prompt: (o: { tabId: string; brainPath: string; text: string; onEvent: (ev: StreamEvent) => void }) => Promise<string>
  cancel: (tabId: string) => void
  close: (tabId: string) => void
}

export type ScriptResult = { code: number; out: string }

export type FactoryDeps = {
  driver: Driver
  emit: (e: FactoryEvent) => void
  /** Child env for verify scripts (shims first, no ANTHROPIC_API_KEY). */
  env: (repo: string) => NodeJS.ProcessEnv
  runScript?: (repo: string, script: string, env: NodeJS.ProcessEnv) => Promise<ScriptResult>
}

type Live = { run: RunRecord; gen: number; warm: boolean; busy: Promise<void> | null }

let deps: FactoryDeps | null = null
const live = new Map<string, Live>()

export function configureFactory(next: FactoryDeps): void {
  deps = next
}

function need(): FactoryDeps {
  if (!deps) throw new Error('Factory is not set up yet.')
  return deps
}

/** Test hook: forget in-memory runs, as an app restart would. */
export function dropMemory(): void {
  live.clear()
}

function titleOf(task: string): string {
  const first = String(task || '').trim().split('\n')[0].trim()
  return first.length > 72 ? first.slice(0, 69).trimEnd() + '...' : first
}

function persist(state: Live): RunRecord {
  state.run = saveRun(state.run)
  need().emit({ runId: state.run.id, kind: 'run', run: state.run })
  return state.run
}

function setPhase(state: Live, phase: RunPhase, patch: Partial<RunRecord> = {}): RunRecord {
  state.run = { ...state.run, ...patch, phase }
  return persist(state)
}

function stale(state: Live, gen: number): boolean {
  return state.gen !== gen || live.get(state.run.id) !== state
}

function track(state: Live, work: Promise<void>): void {
  const p = work.catch((e) => {
    if (state.run.phase === 'paused' || TERMINAL_PHASES.includes(state.run.phase)) return
    setPhase(state, 'failed', { error: String((e as Error)?.message || e).slice(0, 400), resumePhase: state.run.resumePhase || 'build' })
  })
  state.busy = p.finally(() => {
    if (state.busy === p) state.busy = null
  })
}

export function triageTask(text: string, hints?: { files?: number; lines?: number }) {
  return triage(text, hints)
}

export type StartInput = { task: string; workRepo: string; brainPath: string; proceedCritical?: boolean }
export type StartResult =
  | { ok: true; run: RunRecord }
  | { ok: false; error: string; needsProceed?: boolean; runId?: string }

export function startRun(input: StartInput): StartResult {
  const task = String(input.task || '').trim()
  if (!task) return { ok: false, error: 'Say what to change first.' }
  const brainPath = String(input.brainPath || '').trim()
  if (!brainPath || !existsSync(brainPath)) return { ok: false, error: 'Open a brain folder first.' }
  const picked = String(input.workRepo || '').trim()
  if (!picked || !existsSync(picked)) return { ok: false, error: 'Choose a work repo folder.' }
  if (!isGitRepo(picked)) return { ok: false, error: 'That folder is not a git repo. Factory commits to a git repo.' }
  const workRepo = gitTop(picked)
  if (realish(workRepo) === realish(brainPath)) {
    return { ok: false, error: 'The work repo is the brain itself. Pick the code repo the change belongs in.' }
  }
  const held = activeRunFor(workRepo)
  if (held) return { ok: false, error: `Factory is already running on this repo: ${held.title}`, runId: held.runId }
  if (!isClean(workRepo)) return { ok: false, error: 'This repo has uncommitted changes. Commit or stash them, then start again.' }
  const t = triage(task)
  if (t.risk === 'critical' && !input.proceedCritical) {
    return { ok: false, needsProceed: true, error: `Critical risk: ${t.reasons.filter((r) => r.startsWith('Critical')).join(' ')} Proceed at T1 to continue.` }
  }
  const id = 'run-' + randomUUID().slice(0, 12)
  const now = Date.now()
  const run: RunRecord = {
    id,
    title: titleOf(task),
    task,
    brainPath,
    workRepo,
    tier: t.size === 'T0' ? 'T0' : 'T1',
    risk: t.risk,
    triage: { size: t.size, original: t.original, capped: t.capped, reasons: t.reasons },
    phase: 'triage',
    base: headSha(workRepo),
    acpTab: 'factory-' + id,
    createdAt: now,
    updatedAt: now
  }
  saveRun(run)
  const lock = acquireLock(workRepo, { runId: id, title: run.title })
  if (!lock.ok) {
    saveRun({ ...run, phase: 'abandoned', error: 'Another run holds this repo.' })
    return { ok: false, error: `Factory is already running on this repo: ${lock.title}`, runId: lock.runId }
  }
  const state: Live = { run, gen: 0, warm: false, busy: null }
  live.set(id, state)
  persist(state)
  track(state, buildStep(state, 'build'))
  return { ok: true, run: state.run }
}

async function buildStep(state: Live, phase: BriefPhase, note?: string): Promise<void> {
  const d = need()
  const gen = state.gen
  const run = state.run
  setPhase(state, phase === 'review' ? 'review' : 'build', { error: undefined, tripwire: undefined, note, diff: phase === 'review' ? undefined : run.diff })
  let brainBefore: Record<string, string> = {}
  try {
    brainBefore = porcelain(run.brainPath)
  } catch {
    brainBefore = {}
  }
  if (!state.warm) {
    const w = await d.driver.warm({ tabId: run.acpTab, brainPath: run.brainPath, workRepo: run.workRepo, resumeId: run.grokSessionId })
    if (stale(state, gen)) return
    state.warm = true
    state.run = { ...state.run, grokSessionId: w.sessionId }
    persist(state)
  }
  const brief = buildBrief({
    role: phase === 'review' ? 'self-check' : 'builder',
    tier: state.run.tier,
    phase,
    workRepo: run.workRepo,
    brainPath: run.brainPath,
    task: run.task,
    note
  })
  await d.driver.prompt({
    tabId: run.acpTab,
    brainPath: run.brainPath,
    text: brief,
    onEvent: (ev) => {
      if (!stale(state, gen)) d.emit({ runId: run.id, kind: 'stream', ev })
    }
  })
  if (stale(state, gen)) return
  await afterTurn(state, phase, brainBefore)
}

async function afterTurn(state: Live, phase: BriefPhase, brainBefore: Record<string, string>): Promise<void> {
  const run = state.run
  const audit = auditTurn({ brainPath: run.brainPath, workRepo: run.workRepo, brainBefore, base: run.base })
  // Brain writes are shown, never reverted. They stay on the run for every later screen.
  const brain = [...new Set([...(run.audit?.brain || []), ...audit.brain])].sort()
  state.run = { ...state.run, audit: { brain, work: audit.work } }
  const trip = checkTripwire(state.run.tier, audit.work)
  if (trip.trip) {
    setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: trip.suggest }, resumePhase: 'upgrade' })
    return
  }
  if (!audit.work.length) {
    setPhase(state, 'failed', { error: 'This turn changed no files in the work repo.', resumePhase: 'build' })
    return
  }
  if (phase === 'review') state.run = { ...state.run, selfChecked: true }
  await verifyStep(state)
}

function scriptsOf(repo: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts || {}
  } catch {
    return {}
  }
}

function defaultRunScript(repo: string, script: string, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', script], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (d: Buffer) => {
      out += String(d)
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, out: String(e.message || e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
  })
}

function tail(text: string, n = 20): string {
  return String(text || '').trimEnd().split('\n').slice(-n).join('\n')
}

async function verifyStep(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  setPhase(state, 'verify', { verify: [] })
  const scripts = scriptsOf(state.run.workRepo)
  const wanted = state.run.tier === 'T0' ? ['typecheck'] : ['typecheck', 'test']
  const rows: VerifyRow[] = []
  const env = d.env(state.run.workRepo)
  for (const script of wanted) {
    if (!scripts[script]) {
      rows.push({ script, status: 'skipped' })
      continue
    }
    const res = await (d.runScript || defaultRunScript)(state.run.workRepo, script, env)
    if (stale(state, gen)) return
    rows.push(res.code === 0 ? { script, status: 'pass' } : { script, status: 'fail', tail: tail(res.out) })
    state.run = { ...state.run, verify: [...rows] }
    persist(state)
  }
  const failed = rows.find((r) => r.status === 'fail')
  if (failed) {
    setPhase(state, 'failed', {
      verify: rows,
      error: `npm run ${failed.script} failed.`,
      resumePhase: 'build',
      note: `Verify failed: npm run ${failed.script}.\n${tail(failed.tail || '', 8)}`
    })
    return
  }
  state.run = { ...state.run, verify: rows }
  if (state.run.tier === 'T1' && !state.run.selfChecked) {
    await buildStep(state, 'review')
    return
  }
  finishReview(state)
}

function finishReview(state: Live): void {
  let diff = ''
  try {
    diff = diffText(state.run.workRepo, state.run.base)
  } catch (e) {
    diff = `Could not read the diff: ${String((e as Error).message || e)}`
  }
  setPhase(state, 'review', { diff, resumePhase: 'review' })
}

function liveFor(id: string): Live {
  const hit = live.get(id)
  if (hit) return hit
  const run = restoreRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  return live.get(id)!
}

/** After an app restart: the run comes back paused, same tier, work repo, Grok session, and lock. */
export function restoreRun(id: string): RunRecord | null {
  const have = live.get(id)
  if (have) return have.run
  const run = loadRun(id)
  if (!run) return null
  const state: Live = { run, gen: 0, warm: false, busy: null }
  live.set(id, state)
  if (TERMINAL_PHASES.includes(run.phase)) return run
  if (!holdsLock(run.workRepo, run.id)) {
    const lock = acquireLock(run.workRepo, { runId: run.id, title: run.title })
    if (!lock.ok) {
      state.run = { ...run, phase: 'abandoned', error: `Another run took this repo: ${lock.title}` }
      return persist(state)
    }
  }
  if (run.phase === 'paused') return run
  const resumePhase: RunPhase = run.phase === 'failed' ? run.resumePhase || 'build' : run.phase
  state.run = { ...run, phase: 'paused', resumePhase }
  return persist(state)
}

export function getRun(id: string): RunRecord | null {
  return live.get(id)?.run || loadRun(id)
}

/** Every run on disk; live ones reload paused. */
export function listFactoryRuns(): RunRecord[] {
  return listRuns().map((r) => (TERMINAL_PHASES.includes(r.phase) ? r : restoreRun(r.id) || r))
}

export function pauseRun(id: string): RunRecord {
  const state = liveFor(id)
  if (TERMINAL_PHASES.includes(state.run.phase) || state.run.phase === 'paused') return state.run
  state.gen++
  try {
    need().driver.cancel(state.run.acpTab)
  } catch {
    /* not warm */
  }
  const from = state.run.phase
  const resumePhase: RunPhase = from === 'failed' ? state.run.resumePhase || 'build' : from === 'triage' ? 'build' : from
  return setPhase(state, 'paused', { resumePhase })
}

/** A closed Factory tab pauses its run and lets go of the Grok tab. The lock stays. */
export function detachRun(id: string): RunRecord | null {
  if (!live.has(id) && !loadRun(id)) return null
  const run = pauseRun(id)
  const state = live.get(id)
  if (state) state.warm = false
  try {
    need().driver.close(run.acpTab)
  } catch {
    /* */
  }
  return run
}

export function resumeRun(id: string): RunRecord {
  const state = liveFor(id)
  const run = state.run
  if (TERMINAL_PHASES.includes(run.phase)) return run
  if (state.busy && run.phase !== 'paused') return run
  const target: RunPhase = run.phase === 'paused' || run.phase === 'failed' ? run.resumePhase || 'build' : run.phase
  state.gen++
  if (target === 'upgrade') return setPhase(state, 'upgrade')
  if (target === 'review' && run.diff) return setPhase(state, 'review')
  if (target === 'verify' || target === 'review') {
    track(state, verifyStep(state))
    return state.run
  }
  const note =
    run.phase === 'failed' && run.note
      ? run.note
      : 'Resumed after a pause. Check what is already done in the work repo, then finish the task.'
  track(state, buildStep(state, 'build', note))
  return state.run
}

export type Decision = 'upgrade' | 'trim' | 'stop'

export function decideRun(id: string, choice: Decision): RunRecord {
  const state = liveFor(id)
  const run = state.run
  if (run.phase !== 'upgrade') throw new Error('This run is not waiting on a tier decision.')
  if (choice === 'stop') return pauseRun(id)
  state.gen++
  if (choice === 'upgrade') {
    if (run.tier !== 'T0' || run.tripwire?.suggest !== 'T1') throw new Error('T2 is not in this version. Trim or stop.')
    state.run = { ...run, tier: 'T1' }
    const trip = checkTripwire('T1', run.audit?.work || [])
    if (trip.trip) return setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: null } })
    track(state, verifyStep(state))
    return state.run
  }
  const note = `Over the ${run.tier} limit: ${(run.tripwire?.reasons || []).join(' ')}`
  track(state, buildStep(state, 'trim', note))
  return state.run
}

export function commitRunNow(id: string): RunRecord {
  const state = liveFor(id)
  const run = state.run
  if (run.phase !== 'review') throw new Error('Commit is only offered after review.')
  const rows = numstat(run.workRepo, run.base)
  const trip = checkTripwire(run.tier, rows)
  if (trip.trip) return setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: trip.suggest }, audit: { brain: run.audit?.brain || [], work: rows } })
  setPhase(state, 'commit')
  try {
    const sha = commitRun(run.workRepo, rows.map((r) => r.path), run.title)
    releaseLock(run.workRepo, run.id)
    try {
      need().driver.close(run.acpTab)
    } catch {
      /* */
    }
    return setPhase(state, 'done', { commitSha: sha, audit: { brain: run.audit?.brain || [], work: rows } })
  } catch (e) {
    return setPhase(state, 'review', { error: `Commit failed: ${String((e as Error).message || e).slice(0, 300)}` })
  }
}

export function abandonRun(id: string): RunRecord {
  const state = liveFor(id)
  state.gen++
  try {
    need().driver.cancel(state.run.acpTab)
    need().driver.close(state.run.acpTab)
  } catch {
    /* */
  }
  releaseLock(state.run.workRepo, state.run.id)
  return setPhase(state, 'abandoned')
}

/** Test hook: wait until the run's current async step settles. */
export async function settle(id: string): Promise<RunRecord | null> {
  for (let i = 0; i < 200; i++) {
    const state = live.get(id)
    if (!state?.busy) return state?.run || null
    await state.busy
  }
  return live.get(id)?.run || null
}
