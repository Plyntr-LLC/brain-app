import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGrokLine, resolveBin, type StreamEvent } from '../ai-cli'
import type { Tier } from '../../shared/factory.ts'
import { buildBrief, type BriefPhase } from './brief.ts'
import { publish as gitPublish, publishBlock, type PublishTarget } from './gates.ts'
import { auditTurn, commitRun, currentBranch, diffText, gitTop, headSha, isClean, isGitRepo, numstat, porcelain } from './git-audit.ts'
import { OPUS_PLAN_TIMEOUT_MS, OPUS_REVIEW_TIMEOUT_MS, planPrompt, runOpus, strictNeeded, strictPrompt, verdict, type SpawnFn } from './opus.ts'
import { realish } from './paths.ts'
import { detectProfile, readProfile } from './profile.ts'
import {
  acquireLock,
  activeRunFor,
  holdsLock,
  listRuns,
  loadRun,
  releaseLock,
  runTextPath,
  saveRun,
  saveRunText,
  TERMINAL_PHASES,
  type RunPhase,
  type RunRecord,
  type VerifyRow
} from './run-store.ts'
import { triage, type Size } from './triage.ts'
import { llmTriage, mergeTriage } from './triage-llm.ts'
import { checkTripwire } from './tripwire.ts'
import { runVoice } from './voice.ts'

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
  /** Grok reasoning effort on the Factory session (plan high, xhigh after an Opus plan). */
  setEffort?: (tabId: string, effort: string) => Promise<void>
}

export type ScriptResult = { code: number; out: string }

export type FactoryDeps = {
  driver: Driver
  emit: (e: FactoryEvent) => void
  /** Child env for verify scripts (shims first, no ANTHROPIC_API_KEY). */
  env: (repo: string) => NodeJS.ProcessEnv
  runScript?: (repo: string, script: string, env: NodeJS.ProcessEnv) => Promise<ScriptResult>
  /** Fixture hooks. Defaults: resolveBin, node spawn, real git push. */
  grokBin?: () => string | null
  claudeBin?: () => string | null
  spawnTriage?: SpawnFn
  spawnOpus?: SpawnFn
  spawnVoice?: SpawnFn
  voiceCheckPath?: string
  publish?: (workRepo: string, t: PublishTarget) => Promise<{ ok: boolean; out: string }>
}

type Live = { run: RunRecord; gen: number; warm: boolean; busy: Promise<void> | null; abort?: AbortController }

export const STRICT_MISSING = 'Opus reviewer not found (claude CLI). Commit is your call.'
export const VOICE_HOLD = 'Voice check said REJECT. Fix the copy before Commit.'
const NO_VERDICT = 'Reviewer did not end with PASS or FAIL.'

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
    return { ok: false, needsProceed: true, error: `Critical risk: ${t.reasons.filter((r) => r.startsWith('Critical')).join(' ')} Proceed at ${asTier(t.size)} to continue.` }
  }
  const id = 'run-' + randomUUID().slice(0, 12)
  const now = Date.now()
  const run: RunRecord = {
    id,
    title: titleOf(task),
    task,
    brainPath,
    workRepo,
    tier: asTier(t.size),
    risk: t.risk,
    triage: { size: t.size, original: t.original, capped: t.capped, reasons: t.reasons },
    phase: 'triage',
    resumePhase: 'triage',
    profile: readProfile(workRepo),
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
  track(state, triageStep(state))
  return { ok: true, run: state.run }
}

function asTier(size: Size | string): Tier {
  return size === 'T0' ? 'T0' : size === 'T1' ? 'T1' : 'T2'
}

/** Grok low one-shot, raise-only. Critical raised by the model waits for a Proceed click. */
async function triageStep(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  const run = state.run
  setPhase(state, 'triage', { resumePhase: 'triage', error: undefined })
  const rules = triage(run.task)
  const res = await llmTriage({
    task: run.task,
    rules,
    cwd: run.brainPath,
    env: d.env(run.brainPath),
    bin: (d.grokBin || (() => resolveBin('grok')))(),
    parseLine: parseGrokLine,
    spawnFn: d.spawnTriage
  })
  if (stale(state, gen)) return
  const m = mergeTriage(rules, res.llm, res.why)
  const tier = asTier(m.size)
  const up = (a: Tier, b: Tier) => (Number(b.slice(1)) > Number(a.slice(1)) ? b : a)
  state.run = {
    ...state.run,
    tier: up(state.run.tier, tier),
    risk: m.risk,
    triage: {
      size: m.size,
      original: m.original,
      capped: m.capped,
      reasons: m.reasons,
      llm: res.llm ? { size: res.llm.size, risk: res.llm.risk, reason: res.llm.reason } : { skipped: res.why }
    }
  }
  if (m.risk === 'critical' && rules.risk !== 'critical') {
    setPhase(state, 'triage', { needsProceed: true, resumePhase: 'triage' })
    return
  }
  await afterTriage(state)
}

async function afterTriage(state: Live): Promise<void> {
  if (state.run.tier === 'T2') await planStep(state)
  else await buildStep(state, 'build')
}

async function ensureWarm(state: Live, gen: number): Promise<boolean> {
  if (state.warm) return true
  const run = state.run
  const w = await need().driver.warm({ tabId: run.acpTab, brainPath: run.brainPath, workRepo: run.workRepo, resumeId: run.grokSessionId })
  if (stale(state, gen)) return false
  state.warm = true
  state.run = { ...state.run, grokSessionId: w.sessionId }
  persist(state)
  return true
}

async function setEffort(state: Live, effort: string): Promise<void> {
  try {
    await need().driver.setEffort?.(state.run.acpTab, effort)
  } catch {
    /* the session keeps its effort; the brief still carries the phase */
  }
}

function snap(repo: string): Record<string, string> {
  try {
    return porcelain(repo)
  } catch {
    return {}
  }
}

/** T2 plan turn on the builder (Grok high). Not afterTurn: a plan turn changes no work files by design. */
async function planStep(state: Live, o: { note?: string; previous?: boolean } = {}): Promise<void> {
  const d = need()
  const gen = state.gen
  const prev = state.run.plan
  const plan = { text: '', by: 'grok' as const, status: 'waiting' as const, rejects: prev?.rejects || 0, reasons: prev?.reasons || [] }
  setPhase(state, 'plan', { plan, resumePhase: 'plan', error: undefined, needsProceed: undefined, note: o.note })
  const run = state.run
  const brainBefore = snap(run.brainPath)
  if (!(await ensureWarm(state, gen))) return
  await setEffort(state, 'high')
  if (stale(state, gen)) return
  const brief = buildBrief({
    role: 'planner',
    tier: 'T2',
    phase: 'plan',
    workRepo: run.workRepo,
    brainPath: run.brainPath,
    task: run.task,
    note: o.note,
    previousPlanPath: o.previous ? runTextPath(run.id, 'plan') : undefined
  })
  const text = await d.driver.prompt({
    tabId: run.acpTab,
    brainPath: run.brainPath,
    text: brief,
    onEvent: (ev) => {
      if (!stale(state, gen)) d.emit({ runId: run.id, kind: 'stream', ev })
    }
  })
  if (stale(state, gen)) return
  const audit = auditTurn({ brainPath: run.brainPath, workRepo: run.workRepo, brainBefore, base: run.base })
  const brain = [...new Set([...(state.run.audit?.brain || []), ...audit.brain])].sort()
  state.run = { ...state.run, audit: { brain, work: audit.work } }
  const body = String(text || '').trim()
  if (!body) {
    setPhase(state, 'failed', { error: 'The plan turn returned no plan.', resumePhase: 'plan' })
    return
  }
  saveRunText(run.id, 'plan', body)
  setPhase(state, 'plan', { plan: { ...plan, text: body.slice(0, 8000) } })
}

/** Second reject: Opus 5.5 medium writes the plan. Missing, timeout, or non-zero exit pauses. */
async function opusPlan(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  const prev = state.run.plan!
  setPhase(state, 'plan', { plan: { ...prev, text: '' }, resumePhase: 'plan', error: undefined })
  const run = state.run
  const abort = new AbortController()
  state.abort = abort
  const res = await runOpus({
    cwd: run.workRepo,
    prompt: planPrompt({ task: run.task, workRepo: run.workRepo, plans: [runTextPath(run.id, 'plan')], reasons: prev.reasons }),
    env: d.env(run.workRepo),
    bin: (d.claudeBin || (() => resolveBin('claude')))(),
    timeoutMs: OPUS_PLAN_TIMEOUT_MS,
    spawnFn: d.spawnOpus,
    signal: abort.signal
  })
  if (state.abort === abort) state.abort = undefined
  if (stale(state, gen)) return
  const why = !res.found
    ? 'Opus planner not found (claude CLI).'
    : res.code !== 0
      ? `Opus plan did not finish (exit ${res.code}).`
      : !res.text.trim()
        ? 'Opus returned no plan.'
        : ''
  if (why) {
    setPhase(state, 'paused', { plan: prev, resumePhase: 'plan', error: `${why} Paused.` })
    return
  }
  const body = res.text.trim()
  saveRunText(run.id, 'plan', body)
  setPhase(state, 'plan', { plan: { ...prev, text: body.slice(0, 8000), by: 'opus', status: 'waiting' } })
}

async function buildStep(state: Live, phase: BriefPhase, note?: string): Promise<void> {
  const d = need()
  const gen = state.gen
  const run = state.run
  const inReview = phase === 'review' || phase === 'fix'
  // Any turn that can change files clears the last strict and voice results: the pipeline runs again.
  setPhase(state, inReview ? 'review' : 'build', {
    error: undefined,
    tripwire: undefined,
    note,
    diff: inReview ? undefined : run.diff,
    strict: undefined,
    voice: undefined,
    resumePhase: inReview ? 'review' : 'build'
  })
  const brainBefore = snap(run.brainPath)
  if (!(await ensureWarm(state, gen))) return
  if (state.run.tier === 'T2') {
    await setEffort(state, state.run.plan?.status === 'approved' && state.run.plan.by === 'opus' ? 'xhigh' : 'high')
    if (stale(state, gen)) return
  }
  const brief = buildBrief({
    role: phase === 'review' ? 'self-check' : 'builder',
    tier: state.run.tier,
    phase,
    workRepo: run.workRepo,
    brainPath: run.brainPath,
    task: run.task,
    note,
    planPath: state.run.plan?.status === 'approved' && phase === 'build' ? runTextPath(run.id, 'plan') : undefined,
    reviewPath: phase === 'fix' && state.run.reviewCycles ? runTextPath(run.id, 'review') : undefined
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
  // Verify checks the script still exists; the profile only picks names.
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
  const names = (state.run.profile || detectProfile(state.run.workRepo)).scripts
  const wanted = [names.typecheck || 'typecheck']
  if (state.run.tier !== 'T0') wanted.push(names.test || 'test')
  if (state.run.tier === 'T2') wanted.push(names.e2e || 'e2e')
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
  await reviewStep(state)
}

/** After verify, in order: T1 self-check, Opus strict when required, voice when on, then diff + Commit. */
async function reviewStep(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  if (state.run.tier === 'T1' && !state.run.selfChecked) {
    await buildStep(state, 'review')
    return
  }
  if (strictNeeded(state.run) && !state.run.strict) {
    const go = await strictStep(state)
    if (!go || stale(state, gen)) return
  }
  if (state.run.profile?.voice.on && !state.run.voice) {
    setPhase(state, 'review', { diff: undefined, resumePhase: 'review' })
    const row = await runVoice({
      runId: state.run.id,
      diff: safeDiff(state.run.workRepo, state.run.base),
      profile: state.run.profile,
      env: d.env(state.run.workRepo),
      spawnFn: d.spawnVoice,
      checkPath: d.voiceCheckPath
    })
    if (stale(state, gen)) return
    state.run = { ...state.run, voice: row }
    persist(state)
  }
  finishReview(state)
}

function safeDiff(repo: string, base: string): string {
  try {
    return diffText(repo, base)
  } catch {
    return ''
  }
}

/** One fresh Opus strict review. True: go on to voice and Commit. False: a fix turn took over or the run moved. */
async function strictStep(state: Live): Promise<boolean> {
  const d = need()
  const gen = state.gen
  setPhase(state, 'review', { diff: undefined, resumePhase: 'review' })
  const run = state.run
  const abort = new AbortController()
  state.abort = abort
  const res = await runOpus({
    cwd: run.workRepo,
    prompt: strictPrompt({ task: run.task, tier: run.tier, risk: run.risk, base: run.base, diff: safeDiff(run.workRepo, run.base), workRepo: run.workRepo }),
    env: d.env(run.workRepo),
    bin: (d.claudeBin || (() => resolveBin('claude')))(),
    timeoutMs: OPUS_REVIEW_TIMEOUT_MS,
    spawnFn: d.spawnOpus,
    signal: abort.signal
  })
  if (state.abort === abort) state.abort = undefined
  if (stale(state, gen)) return false
  if (!res.found) {
    state.run = { ...state.run, strict: { status: 'missing', text: STRICT_MISSING } }
    persist(state)
    return true
  }
  const v = res.code === 0 ? verdict(res.text) : null
  if (v === 'PASS') {
    state.run = { ...state.run, strict: { status: 'pass', text: tail(res.text, 12) } }
    persist(state)
    return true
  }
  const text = v === 'FAIL' ? res.text.trim() : `${NO_VERDICT}${res.text.trim() ? `\n${tail(res.text, 12)}` : ''}`
  const cycles = (state.run.reviewCycles || 0) + 1
  saveRunText(run.id, 'review', text)
  state.run = { ...state.run, reviewCycles: cycles, strict: { status: 'fail', text: text.slice(-8000) } }
  persist(state)
  if (cycles < 2) {
    await buildStep(state, 'fix', 'The strict reviewer said FAIL.')
    return false
  }
  return true
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
  state.abort?.abort()
  const from = state.run.phase
  const resumePhase: RunPhase = from === 'failed' ? state.run.resumePhase || 'build' : from
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
  if (target === 'triage') {
    if (run.needsProceed) return setPhase(state, 'triage', { error: undefined })
    track(state, run.triage.llm ? afterTriage(state) : triageStep(state))
    return state.run
  }
  if (target === 'plan') {
    // A waiting plan comes back as it was; a resume never starts a build.
    if (run.plan?.status === 'waiting' && run.plan.text) return setPhase(state, 'plan', { error: undefined })
    track(state, planStep(state, { note: 'Resumed after a pause. Write the plan.' }))
    return state.run
  }
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

export type Decision = 'upgrade' | 'trim' | 'stop' | 'approve-plan' | 'reject-plan' | 'proceed' | 'fix-copy'

export function decideRun(id: string, choice: Decision, opts: { reason?: string } = {}): RunRecord {
  const state = liveFor(id)
  const run = state.run
  if (choice === 'approve-plan' || choice === 'reject-plan') {
    if (run.phase !== 'plan' || run.plan?.status !== 'waiting' || !run.plan.text) throw new Error('This run is not waiting on a plan.')
    state.gen++
    if (choice === 'approve-plan') {
      state.run = { ...run, plan: { ...run.plan, status: 'approved', approvedAt: Date.now() } }
      track(state, buildStep(state, 'build'))
      return state.run
    }
    const reason = String(opts.reason || '').trim().slice(0, 300)
    const plan = { ...run.plan, rejects: run.plan.rejects + 1, reasons: [...run.plan.reasons, reason] }
    state.run = { ...run, plan }
    if (plan.rejects >= 3) return setPhase(state, 'paused', { resumePhase: 'plan', error: 'Plan rejected three times. Paused.' })
    if (plan.rejects === 2) {
      track(state, opusPlan(state))
      return state.run
    }
    track(state, planStep(state, { note: reason ? `Plan rejected: ${reason}` : 'Plan rejected. Write a better one.', previous: true }))
    return state.run
  }
  if (choice === 'proceed') {
    if (run.phase !== 'triage' || !run.needsProceed) throw new Error('This run is not waiting on a Proceed click.')
    state.gen++
    state.run = { ...run, needsProceed: undefined }
    persist(state)
    track(state, afterTriage(state))
    return state.run
  }
  if (choice === 'fix-copy') {
    if (run.phase !== 'review' || run.voice?.status !== 'fail') throw new Error('The voice check did not hold this run.')
    state.gen++
    track(state, buildStep(state, 'fix', `Voice check said REJECT. Fix the copy.\n${tail(run.voice.tail || '', 8)}`))
    return state.run
  }
  if (run.phase !== 'upgrade') throw new Error('This run is not waiting on a tier decision.')
  if (choice === 'stop') return pauseRun(id)
  state.gen++
  if (choice === 'upgrade') {
    const next = run.tripwire?.suggest
    if (!next) throw new Error('T3 comes in a later version. Trim or stop.')
    // Moving up from a tripwire skips the plan gate: the work is already done.
    state.run = { ...run, tier: next }
    const trip = checkTripwire(next, run.audit?.work || [])
    if (trip.trip) return setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: trip.suggest } })
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
  if (run.phase !== 'review' || !run.diff) throw new Error('Commit is only offered after review.')
  if (run.voice?.status === 'fail') throw new Error(VOICE_HOLD)
  const rows = numstat(run.workRepo, run.base)
  const trip = checkTripwire(run.tier, rows)
  if (trip.trip) return setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: trip.suggest }, audit: { brain: run.audit?.brain || [], work: rows } })
  setPhase(state, 'commit')
  try {
    const sha = commitRun(run.workRepo, rows.map((r) => r.path), run.title)
    const branch = currentBranch(run.workRepo) || undefined
    releaseLock(run.workRepo, run.id)
    try {
      need().driver.close(run.acpTab)
    } catch {
      /* */
    }
    return setPhase(state, 'done', { commitSha: sha, branch, audit: { brain: run.audit?.brain || [], work: rows } })
  } catch (e) {
    return setPhase(state, 'review', { error: `Commit failed: ${String((e as Error).message || e).slice(0, 300)}` })
  }
}

function pushTarget(run: RunRecord): PublishTarget {
  return { remote: run.profile?.publish.remote || 'origin', branch: run.branch || '', sha: run.commitSha || '' }
}

/** Null when Push may run on this done run, else the sentence the disabled Push shows. */
export function publishBlockFor(id: string): string | null {
  const run = getRun(id)
  if (!run || run.phase !== 'done' || !run.commitSha) return 'Push comes after Commit.'
  if (run.pushed) return `Pushed to ${run.pushed.remote}/${run.pushed.branch}.`
  return publishBlock({ repo: run.workRepo, ...pushTarget(run) })
}

/** The Push click. Real git, run branch only, refused when HEAD moved or the branch is protected. */
export async function publishRun(id: string): Promise<RunRecord> {
  const state = liveFor(id)
  const run = state.run
  if (run.phase !== 'done' || !run.commitSha) throw new Error('Push comes after Commit.')
  if (run.pushed) return run
  const t = pushTarget(run)
  const block = publishBlock({ repo: run.workRepo, ...t })
  if (block) return setPhase(state, 'done', { pushError: block })
  const res = await (need().publish || gitPublish)(run.workRepo, t)
  if (!res.ok) return setPhase(state, 'done', { pushError: tail(res.out || 'git push failed.', 6) })
  return setPhase(state, 'done', { pushed: { ...t, at: Date.now() }, pushError: undefined })
}

export function abandonRun(id: string): RunRecord {
  const state = liveFor(id)
  state.gen++
  state.abort?.abort()
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
