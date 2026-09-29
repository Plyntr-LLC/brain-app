import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGrokLine, resolveBin, type StreamEvent } from '../ai-cli'
import { ACK_FILED, ACK_NOTED, BUILDER_FIX_MAX, VOICE_MAX, type Builder, type GuideNote, type LiveCall, type Slice, type Tier, type UsageRow } from '../../shared/factory.ts'
import { upsertLog } from './brain-log.ts'
import { buildBrief, type BriefPhase } from './brief.ts'
import { isNeedOpus } from './fallback.ts'
import { deploy as gitDeploy, deployBlock, isKennelGated, publish as gitPublish, publishBlock, pushWarn, type PublishTarget, type PushOverride } from './gates.ts'
import { auditTurn, commitRun, currentBranch, diffText, dirtyPaths, gitTop, headSha, isClean, isGitRepo, numstat, porcelain, stashAll } from './git-audit.ts'
import { OPUS_PLAN_TIMEOUT_MS, OPUS_REVIEW_TIMEOUT_MS, planPrompt, REVIEW_MAX, reviewAccept, runOpus, splitOutside, STRICT_EFFORT, strictNeeded, strictPrompt, type SpawnFn } from './opus.ts'
import { realish } from './paths.ts'
import { detectProfile, readProfile, runProfile } from './profile.ts'
import { lastRepo, rememberRepo, resolveWorkRepo } from './resolve-repo.ts'
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
import { llmTriage, mergeTriage, TRIAGE_EFFORT, TRIAGE_MODEL } from './triage-llm.ts'
import { parseSlices, scheduleSlices } from './slices.ts'
import { gateFor, gateOpen, withAuto, withGate, withJudgment } from './shadow.ts'
import { checkTripwire, type Tripwire } from './tripwire.ts'
import { acpRow, withUsage } from './usage.ts'
import { copyAdds, runVoice, voiceNotes } from './voice.ts'

/**
 * Factory run controller. Owns triage, phases, verify, review, and commit. The model only does
 * the current phase brief; it never picks tier, pushes, or decides what is next.
 */

export type FactoryEvent = { runId: string; kind: 'run'; run: RunRecord } | { runId: string; kind: 'stream'; ev: StreamEvent }

/**
 * builder on warm: 'cursor' keeps a run that fell back on Factory Cursor. The warm answer says which
 * ACP grunt it got. Either may throw FACTORY_NEED_OPUS (Grok and Cursor both unusable): the controller
 * then builds with Opus. onBuilder: a Grok turn hopped to Cursor mid-turn.
 */
export type Driver = {
  warm: (o: { tabId: string; brainPath: string; workRepo: string; resumeId?: string; runThrough?: boolean; builder?: 'grok' | 'cursor' }) => Promise<{ sessionId: string; builder?: 'grok' | 'cursor' }>
  prompt: (o: {
    tabId: string
    brainPath: string
    text: string
    onEvent: (ev: StreamEvent) => void
    onBuilder?: (builder: 'cursor', sessionId: string) => void
    /** What the ACP turn reported: served model, effort, and usage when the result carries it. */
    onUsage?: (u: TurnUsage) => void
  }) => Promise<string>
  cancel: (tabId: string) => void
  close: (tabId: string) => void
  /** The ACP tab's current model and effort, for the live row. */
  info?: (tabId: string) => { model?: string; effort?: string }
  /** Grok reasoning effort on the Factory session (T2 build xhigh after an Opus plan, high otherwise; T3 xhigh). */
  setEffort?: (tabId: string, effort: string) => Promise<void>
}

export type ScriptResult = { code: number; out: string }

export type TurnUsage = { model?: string; effort?: string; usage?: Record<string, unknown> | null }

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
  publish?: (workRepo: string, t: PublishTarget, over?: PushOverride) => Promise<{ ok: boolean; out: string }>
  deploy?: (workRepo: string, cmd: string, o?: { env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; out: string }>
  /** Where Projects folder names in a task resolve. Default ~/Projects. */
  projectsDir?: string
  /** Test hook: the Opus stdout cap (default OPUS_JSON_MAX). */
  opusMax?: number
  /** Test hook: the Opus review timeout (default OPUS_REVIEW_TIMEOUT_MS). */
  opusTimeoutMs?: number
}

/** workers: T3 builder tabs open right now (factory-<id>-w<n>). */
type Live = {
  run: RunRecord
  gen: number
  warm: boolean
  busy: Promise<void> | null
  abort?: AbortController
  workers?: string[]
  /** Notes the in-flight Opus planner carries: a Guide interrupt hands them to the next planner. */
  planNotes?: string[]
  /** gen that already had its one auto fix turn for a verify fail naming a changed file. */
  verifyFix?: number
  /** This fix turn answers a voice REJECT: its brief carries the voice notes. */
  voiceFix?: boolean
  /** gen that already had its one retry after a turn that changed no files. */
  emptyRetry?: number
  /** Porcelain of the other repos this run could have written, taken before the turn (see healCandidates). */
  otherBefore?: Map<string, Record<string, string>>
}

export const STRICT_MISSING = 'Opus reviewer not found (claude CLI). Commit is your call.'
export const VOICE_HOLD = 'Voice check said REJECT. Fix the copy before Commit.'
const NO_VERDICT = 'Reviewer did not end with PASS or FAIL.'
export const HELD_LINE = `Opus has not approved after ${REVIEW_MAX - 1} fixes. Gaps still count.`
export const VOICE_HELD_LINE = `Voice has not approved after ${VOICE_MAX} fixes.`
const GUIDE_MAX = 20
const GUIDE_CHARS = 800

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
  if (TERMINAL_PHASES.includes(state.run.phase)) logToBrain(state.run)
  need().emit({ runId: state.run.id, kind: 'run', run: state.run })
  return state.run
}

/** The brain's record of this run. A brain that cannot take the write never stops the run. */
function logToBrain(run: RunRecord): void {
  try {
    let folder = run.profile?.brainFolder
    try {
      folder = readProfile(run.workRepo).brainFolder || folder
    } catch {
      /* the run's copy */
    }
    upsertLog(run.brainPath, run, folder)
  } catch {
    /* read-only or missing brain */
  }
}

function addUsage(state: Live, row: UsageRow): void {
  state.run = { ...state.run, usage: withUsage(state.run.usage, row) }
}

/** The call's row sits on the run while it runs; its own id comes off when it ends, however it ends. */
async function withLive<T>(state: Live, entry: Omit<LiveCall, 'id' | 'since'>, fn: () => Promise<T>): Promise<T> {
  const id = randomUUID()
  state.run = { ...state.run, live: [...(state.run.live || []), { ...entry, id, since: Date.now() }] }
  persist(state)
  try {
    return await fn()
  } finally {
    const rest = (state.run.live || []).filter((c) => c.id !== id)
    state.run = { ...state.run, live: rest.length ? rest : undefined }
    persist(state)
  }
}

const OPUS_LIVE = { cli: 'claude' as const, model: 'opus', effort: 'medium' }

/** One ACP builder turn with its usage row, whatever way it ends. */
async function acpTurn(state: Live, o: Parameters<Driver['prompt']>[0]): Promise<void> {
  const started = Date.now()
  let got: TurnUsage = {}
  let ok = false
  const d = need()
  let info: { model?: string; effort?: string } = {}
  try {
    info = d.driver.info?.(o.tabId) || {}
  } catch {
    /* no info: the builder name stands in */
  }
  const cli = state.run.builder === 'cursor' ? 'cursor' : 'grok'
  try {
    await withLive(state, { phase: 'build', cli, model: info.model || cli, effort: info.effort || '', tab: o.tabId }, () => d.driver.prompt({ ...o, onUsage: (u) => (got = u) }))
    ok = true
  } finally {
    const cli = state.run.builder === 'cursor' ? 'cursor' : 'grok'
    addUsage(state, acpRow({ phase: 'build', cli, effort: got.effort || '', ms: Date.now() - started }, { model: got.model, usage: got.usage, ok }))
    persist(state)
  }
}

function setPhase(state: Live, phase: RunPhase, patch: Partial<RunRecord> = {}): RunRecord {
  state.run = { ...state.run, ...patch, phase }
  return persist(state)
}

function stale(state: Live, gen: number): boolean {
  return state.gen !== gen || live.get(state.run.id) !== state
}

function track(state: Live, work: Promise<void>): void {
  // Callers bump gen before track: a cancelled turn that throws later never fails the turn that replaced it.
  const gen = state.gen
  const p = work.catch((e) => {
    if (stale(state, gen)) return
    if (state.run.phase === 'paused' || TERMINAL_PHASES.includes(state.run.phase)) return
    // Grok and Cursor both unusable is a builder hop, never a failed run: the next turn is Opus.
    if (isNeedOpus(e)) {
      const at = state.run.phase === 'failed' ? state.run.resumePhase || 'build' : state.run.phase
      setPhase(state, 'paused', { builder: 'opus', error: 'Grok and Cursor could not run. Resume builds with Opus.', resumePhase: at === 'review' ? 'review' : 'build' })
      return
    }
    setPhase(state, 'failed', { error: String((e as Error)?.message || e).slice(0, 400), resumePhase: state.run.resumePhase || 'build' })
  })
  const busy: Promise<void> = p.finally(() => {
    if (state.busy === busy) state.busy = null
  })
  state.busy = busy
}

export function triageTask(text: string, hints?: { files?: number; lines?: number }) {
  return triage(text, hints)
}

/** workRepo is optional: main resolves it from the task, then the last Factory repo. runThrough: Approve in advance. shipThrough: Ship in advance. */
export type StartInput = { task: string; workRepo?: string; brainPath: string; proceedCritical?: boolean; runThrough?: boolean; shipThrough?: boolean }
export type StartResult =
  | { ok: true; run: RunRecord }
  | { ok: false; error: string; needsProceed?: boolean; runId?: string }

export function startRun(input: StartInput): StartResult {
  const task = String(input.task || '').trim()
  if (!task) return { ok: false, error: 'Say what to change first.' }
  const brainPath = String(input.brainPath || '').trim()
  if (!brainPath || !existsSync(brainPath)) return { ok: false, error: 'Open a brain folder first.' }
  const found = resolveWorkRepo({ task, brainPath, workRepo: input.workRepo, lastRepo: lastRepo(), projectsDir: deps?.projectsDir })
  if (!found.ok) return { ok: false, error: found.error }
  const picked = found.workRepo
  if (!existsSync(picked)) return { ok: false, error: `${picked} does not exist. Name the code repo in the task.` }
  if (!isGitRepo(picked)) return { ok: false, error: 'That folder is not a git repo. Factory commits to a git repo.' }
  const workRepo = gitTop(picked)
  if (realish(workRepo) === realish(brainPath)) {
    return { ok: false, error: 'The work repo is the brain itself. Factory does not edit the brain. Name the code repo in the task.' }
  }
  const held = activeRunFor(workRepo)
  if (held) return { ok: false, error: `Factory is already running on this repo: ${held.title}`, runId: held.runId }
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
    ...(input.runThrough ? { runThrough: true } : {}),
    ...(input.shipThrough ? { shipThrough: true } : {}),
    phase: 'triage',
    resumePhase: 'triage',
    profile: runProfile(readProfile(workRepo)),
    base: headSha(workRepo),
    acpTab: 'factory-' + id,
    createdAt: now,
    updatedAt: now
  }
  run.repos = [{ repo: workRepo, base: run.base }]
  run.pushWarn = warnFor(run, workRepo)
  saveRun(run)
  const lock = acquireLock(workRepo, { runId: id, title: run.title })
  if (!lock.ok) {
    saveRun({ ...run, phase: 'abandoned', error: 'Another run holds this repo.' })
    return { ok: false, error: `Factory is already running on this repo: ${lock.title}`, runId: lock.runId }
  }
  rememberRepo(workRepo)
  const state: Live = { run, gen: 0, warm: false, busy: null }
  live.set(id, state)
  // Uncommitted changes: the run opens and waits for Commit first or Stash first. Approve in advance does not skip this.
  if (!isClean(workRepo)) {
    const dirty = dirtyPaths(workRepo)
    state.run = { ...state.run, needsPrep: 'dirty', dirtyFiles: dirty.slice(0, 20), dirtyCount: dirty.length }
    persist(state)
    return { ok: true, run: state.run }
  }
  persist(state)
  track(state, triageStep(state))
  return { ok: true, run: state.run }
}

/** The run's repo history with this repo added once (its first base kept). */
function withRepo(repos: RunRecord['repos'], repo: string, base: string): NonNullable<RunRecord['repos']> {
  const list = [...(repos || [])]
  if (!list.some((r) => realish(r.repo) === realish(repo))) list.push({ repo, base })
  return list
}

function warnFor(run: RunRecord, repo: string): string | undefined {
  try {
    return pushWarn({ repo, remote: readProfile(repo).publish.remote || 'origin', shipThrough: run.shipThrough })
  } catch {
    return undefined
  }
}

/**
 * Repos an empty turn may have written instead: the run's earlier repos and the repo the task itself
 * names. Never the current repo, never the brain, never a scan of every project.
 */
function healCandidates(run: RunRecord): string[] {
  const brain = realish(run.brainPath)
  const out: string[] = []
  const add = (repo: string) => {
    if (!repo || !existsSync(repo) || !isGitRepo(repo)) return
    const top = gitTop(repo)
    if (!top || realish(top) === brain || realish(top) === realish(run.workRepo)) return
    if (!out.some((r) => realish(r) === realish(top))) out.push(top)
  }
  for (const r of run.repos || []) add(r.repo)
  const found = resolveWorkRepo({ task: run.task, brainPath: run.brainPath, projectsDir: deps?.projectsDir })
  if (found.ok) add(found.workRepo)
  return out
}

/**
 * An empty turn: if the builder's edits landed in a candidate repo during this turn (porcelain, content
 * hashes, so an already-dirty file edited again counts), move the run back there. True: moved.
 * A candidate another run holds is not taken.
 */
function healEmptyTurn(state: Live): boolean {
  const before = state.otherBefore
  if (!before?.size) return false
  const run = state.run
  for (const [repo, snapBefore] of before) {
    const now = snap(repo)
    const keys = new Set([...Object.keys(snapBefore), ...Object.keys(now)])
    if (![...keys].some((k) => snapBefore[k] !== now[k])) continue
    const lock = acquireLock(repo, { runId: run.id, title: run.title })
    if (!lock.ok) continue
    if (holdsLock(run.workRepo, run.id)) releaseLock(run.workRepo, run.id)
    rememberRepo(repo)
    const known = (run.repos || []).find((r) => realish(r.repo) === realish(repo))
    const base = known?.base || headSha(repo)
    // Every note read so far now points here, so reconcile does not pull the run straight back out.
    const guide = (run.guide || []).map((g) => ({ ...g, repo }))
    state.warm = false
    state.run = {
      ...run,
      workRepo: repo,
      base,
      profile: runProfile(readProfile(repo)),
      guide,
      repos: withRepo(withRepo(run.repos, run.workRepo, run.base), repo, base),
      pushWarn: warnFor(run, repo),
      moved: `Moved back to ${repo.split(/[\\/]/).pop()}: the last turn's edits landed there.`,
      error: undefined
    }
    persist(state)
    return true
  }
  return false
}

/**
 * The work repo follows the repo the task (or Joe's newest Guide note that names one) uniquely
 * names. Never lastRepo, never the brain, never an ambiguous name. A note that only mentions the
 * current or last work repo ("why is it showing mykennel") does not choose it; each note is read
 * once and its answer kept, so a move never flips back. Nothing unique: the run stays put.
 * On a move: the lock, profile, base, and lastRepo follow; a dirty repo the run has not built in
 * yet waits on Commit/Stash first.
 * 'stop': the caller starts nothing (another run holds the repo, or the new repo waits on prep).
 */
function reconcileWorkRepo(state: Live): 'go' | 'stop' {
  const run = state.run
  const brain = realish(run.brainPath)
  const ignore = [run.workRepo, lastRepo()].filter(Boolean)
  let pinned = false
  const guide = (run.guide || []).map((g): GuideNote => {
    if (g.repo !== undefined) return g
    pinned = true
    // A note moves the run by a path or a folder name, never by a README or package.json word.
    const found = resolveWorkRepo({ task: g.text, brainPath: run.brainPath, projectsDir: deps?.projectsDir, ignore, aliases: false })
    return { ...g, repo: found.ok ? found.workRepo : '' }
  })
  if (pinned) {
    state.run = { ...state.run, guide }
    persist(state)
  }
  let hit = [...guide].reverse().find((g) => g.repo)?.repo || ''
  if (!hit) {
    const found = resolveWorkRepo({ task: run.task, brainPath: run.brainPath, projectsDir: deps?.projectsDir })
    if (found.ok) hit = found.workRepo
  }
  if (!hit || !existsSync(hit) || !isGitRepo(hit)) return 'go'
  const next = gitTop(hit)
  if (!next || realish(next) === brain || realish(next) === realish(run.workRepo)) return 'go'
  // The new lock first: a refused move keeps the old repo and the lock this run already holds.
  const lock = acquireLock(next, { runId: run.id, title: run.title })
  if (!lock.ok) {
    state.run = { ...state.run, error: `Factory is already running on ${next}: ${lock.title}`.slice(0, 300) }
    persist(state)
    return 'stop'
  }
  if (holdsLock(run.workRepo, run.id)) releaseLock(run.workRepo, run.id)
  rememberRepo(next)
  // The Grok tab re-warms on the same session so its write gate follows the new repo.
  state.warm = false
  const base = headSha(next)
  state.run = {
    ...state.run,
    workRepo: next,
    profile: runProfile(readProfile(next)),
    base,
    error: undefined,
    moved: undefined,
    // Runs saved before 0.1.89 have no history: the repo it is leaving goes in first.
    repos: withRepo(withRepo(state.run.repos, run.workRepo, run.base), next, base),
    pushWarn: warnFor(state.run, next)
  }
  // A restored or paused run reads the phase it will resume, not 'paused'.
  const at = run.phase === 'paused' ? run.resumePhase : run.phase
  const notBuilt = !!run.needsPrep || ((at === 'triage' || at === 'plan') && !run.diff && !run.audit?.work?.length)
  if (notBuilt && !isClean(next)) {
    const dirty = dirtyPaths(next)
    setPhase(state, 'triage', { needsPrep: 'dirty', dirtyFiles: dirty.slice(0, 20), dirtyCount: dirty.length, resumePhase: 'triage' })
    return 'stop'
  }
  if (run.needsPrep) state.run = { ...state.run, needsPrep: undefined, dirtyFiles: undefined, dirtyCount: undefined }
  persist(state)
  return 'go'
}

function asTier(size: Size | string): Tier {
  return size === 'T0' ? 'T0' : size === 'T1' ? 'T1' : size === 'T3' ? 'T3' : 'T2'
}

function planned(tier: Tier): boolean {
  return tier === 'T2' || tier === 'T3'
}

/** Joe's notes that no builder or planner brief has carried yet. */
function openNotes(run: RunRecord): string[] {
  return (run.guide || []).filter((g) => !g.sent).map((g) => g.text)
}

function markSent(state: Live): void {
  if (!state.run.guide?.some((g) => !g.sent)) return
  state.run = { ...state.run, guide: state.run.guide.map((g): GuideNote => (g.sent ? g : { ...g, sent: true })) }
}

/** Joe's notes lead the brief note so the cap cuts the task and the fix reason first. */
function withGuide(note: string | undefined, notes: string[]): string | undefined {
  if (!notes.length) return note
  const joe = `Joe says: ${notes.join(' / ')}`
  return note ? `${joe}\n${note}` : joe
}

/** Opus strict failed REVIEW_MAX times (or more after Keep fixing): the diff waits for Joe. */
function held(run: RunRecord): boolean {
  return run.phase === 'review' && !!run.diff && run.strict?.status === 'fail' && (run.reviewCycles || 0) >= REVIEW_MAX
}

/** Grok low one-shot, raise-only. Critical raised by the model waits for a Proceed click. */
async function triageStep(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  const run = state.run
  setPhase(state, 'triage', { resumePhase: 'triage', error: undefined })
  const rules = triage(run.task)
  const res = await withLive(state, { phase: 'triage', cli: 'grok', model: TRIAGE_MODEL || 'grok (CLI default)', effort: TRIAGE_EFFORT }, () => llmTriage({
    task: run.task,
    rules,
    cwd: run.brainPath,
    env: d.env(run.brainPath),
    bin: (d.grokBin || (() => resolveBin('grok')))(),
    parseLine: parseGrokLine,
    spawnFn: d.spawnTriage
  }))
  addUsage(state, res.usage)
  if (stale(state, gen)) {
    persist(state)
    return
  }
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
  if (planned(state.run.tier)) await opusPlan(state)
  else await buildStep(state, 'build')
}

async function ensureWarm(state: Live, gen: number): Promise<boolean> {
  if (state.warm) return true
  const run = state.run
  const w = await need().driver.warm({
    tabId: run.acpTab,
    brainPath: run.brainPath,
    workRepo: run.workRepo,
    resumeId: run.grokSessionId,
    runThrough: run.runThrough,
    ...(run.builder === 'cursor' ? { builder: 'cursor' as const } : {})
  })
  if (stale(state, gen)) return false
  state.warm = true
  state.run = { ...state.run, grokSessionId: w.sessionId, ...(w.builder === 'cursor' ? { builder: 'cursor' as const } : {}) }
  persist(state)
  return true
}

function setBuilder(state: Live, builder: Builder, sessionId?: string): void {
  if (state.run.builder === builder && !sessionId) return
  state.run = { ...state.run, builder, ...(sessionId ? { grokSessionId: sessionId } : {}) }
  persist(state)
}

/** Opus builds this turn: Grok and Cursor could not run, or this is the third review fix (or later). */
function opusBuilds(state: Live, viaOpus?: boolean): boolean {
  return !!viaOpus || state.run.builder === 'opus'
}

/**
 * Warms the run's ACP grunt. 'opus': both grunts are unusable, so the run builds with Opus from now
 * on. False: the run moved on while warming.
 */
async function warmGrunt(state: Live, gen: number): Promise<boolean | 'opus'> {
  try {
    return await ensureWarm(state, gen)
  } catch (e) {
    if (!isNeedOpus(e)) throw e
    if (stale(state, gen)) return false
    setBuilder(state, 'opus')
    return 'opus'
  }
}

async function setEffort(state: Live, effort: string, tabId = state.run.acpTab): Promise<void> {
  try {
    await need().driver.setEffort?.(tabId, effort)
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

/** The plan is approved (click or Approve in advance): T3 reads its slices, then build starts. */
async function approvePlan(state: Live): Promise<void> {
  const plan = state.run.plan
  if (!plan?.text) return
  let slices: Slice[] | undefined
  if (state.run.tier === 'T3') {
    let text = plan.text
    try {
      text = readFileSync(runTextPath(state.run.id, 'plan'), 'utf8')
    } catch {
      /* the run copy is enough */
    }
    slices = parseSlices(text)
  }
  state.run = { ...state.run, plan: { ...plan, status: 'approved', approvedAt: Date.now() }, slices }
  persist(state)
  await buildStep(state, 'build')
}

/**
 * T2/T3 plan: a fresh Opus 5.5 medium process (plan mode, cannot edit) every time, first plan and
 * every reject. Never the Grok builder. Missing, timeout, or non-zero exit pauses.
 */
async function opusPlan(state: Live): Promise<void> {
  const d = need()
  const gen = state.gen
  if (reconcileWorkRepo(state) === 'stop') {
    if (!state.run.needsPrep) setPhase(state, 'paused', { resumePhase: 'plan', error: state.run.error })
    return
  }
  const prev: NonNullable<RunRecord['plan']> = state.run.plan || { text: '', by: 'opus', status: 'waiting', rejects: 0, reasons: [] }
  setPhase(state, 'plan', { plan: { ...prev, text: '', status: 'waiting' }, resumePhase: 'plan', error: undefined, needsProceed: undefined })
  // Joe's guide notes go to the planner (never to a reviewer). Marked sent as this plan starts.
  const notes = openNotes(state.run)
  markSent(state)
  if (notes.length) persist(state)
  state.planNotes = notes
  const run = state.run
  const earlier = (prev.rejects > 0 || notes.length) && existsSync(runTextPath(run.id, 'plan')) ? [runTextPath(run.id, 'plan')] : []
  const abort = new AbortController()
  state.abort = abort
  const res = await withLive(state, { phase: 'plan', ...OPUS_LIVE }, () =>
    runOpus({
      cwd: run.workRepo,
      prompt: planPrompt({ task: run.task, workRepo: run.workRepo, plans: earlier, reasons: prev.reasons, tier: run.tier === 'T3' ? 'T3' : 'T2', guide: notes }),
      env: d.env(run.workRepo),
      bin: (d.claudeBin || (() => resolveBin('claude')))(),
      timeoutMs: OPUS_PLAN_TIMEOUT_MS,
      spawnFn: d.spawnOpus,
      signal: abort.signal,
      phase: 'plan',
      maxBytes: d.opusMax
    })
  )
  if (state.abort === abort) state.abort = undefined
  addUsage(state, res.usage)
  if (stale(state, gen)) {
    persist(state)
    return
  }
  state.planNotes = undefined
  const why = !res.found
    ? 'Opus planner not found (claude CLI).'
    : res.code !== 0
      ? `Opus plan did not finish (exit ${res.code}).`
      : !res.parsed
        ? 'Opus plan answer could not be read.'
        : !res.text.trim()
          ? 'Opus returned no plan.'
          : ''
  if (why) {
    // The notes did not reach a plan: they wait for the Resume.
    const guide = state.run.guide?.map((g) => (notes.includes(g.text) && g.sent ? { at: g.at, text: g.text, ...(g.ack ? { ack: g.ack } : {}) } : g))
    setPhase(state, 'paused', { plan: prev, resumePhase: 'plan', error: `${why} Paused.`, guide })
    return
  }
  const body = res.text.trim()
  saveRunText(run.id, 'plan', body)
  setPhase(state, 'plan', { plan: { ...prev, text: body.slice(0, 8000), by: 'opus', status: 'waiting' } })
  // Joe guided while Opus wrote: one more fresh plan with the note before anything is approved.
  if (openNotes(state.run).length) return opusPlan(state)
  if (state.run.runThrough) await approvePlan(state)
}

/** viaOpus: this turn is the Opus builder (a review fix from BUILDER_FIX_MAX on). Every other turn is the grunt. */
async function buildStep(state: Live, phase: BriefPhase, note?: string, viaOpus?: boolean, o: { voice?: boolean } = {}): Promise<void> {
  state.voiceFix = !!o.voice
  const d = need()
  const gen = state.gen
  const inReview = phase === 'review' || phase === 'fix'
  if (reconcileWorkRepo(state) === 'stop') {
    if (!state.run.needsPrep) setPhase(state, 'paused', { resumePhase: inReview ? 'review' : 'build', error: state.run.error })
    return
  }
  const run = state.run
  // Any turn that can change files clears the last strict and voice results: the pipeline runs again.
  // A fix turn keeps its reason (or Joe's note) on the run so the card says Grok is fixing, not Opus reviewing.
  setPhase(state, inReview ? 'review' : 'build', {
    error: undefined,
    tripwire: undefined,
    note: phase === 'fix' ? note || withGuide(undefined, openNotes(state.run)) : note,
    diff: inReview ? undefined : run.diff,
    strict: undefined,
    followUps: undefined,
    moved: undefined,
    voice: undefined,
    resumePhase: inReview ? 'review' : 'build'
  })
  const brainBefore = snap(run.brainPath)
  state.otherBefore = new Map(healCandidates(state.run).map((r) => [r, snap(r)]))
  // T3 with more than one slice from the plan: parallel builders. Resume, fix, and Joe's notes use one builder.
  if (phase === 'build' && !note && !openNotes(state.run).length && state.run.tier === 'T3' && (state.run.slices?.length || 0) > 1 && !opusBuilds(state, viaOpus)) {
    await buildSlices(state, gen, brainBefore)
    return
  }
  const notes = openNotes(state.run)
  markSent(state)
  if (notes.length) persist(state)
  if (!opusBuilds(state, viaOpus)) {
    const warm = await warmGrunt(state, gen)
    if (!warm) return
    if (warm === true && state.run.tier === 'T3') {
      await setEffort(state, 'xhigh')
      if (stale(state, gen)) return
    } else if (warm === true && state.run.tier === 'T2') {
      await setEffort(state, state.run.plan?.status === 'approved' && state.run.plan.by === 'opus' ? 'xhigh' : 'high')
      if (stale(state, gen)) return
    }
  }
  await builderTurn(state, gen, phase, withGuide(note, notes), viaOpus)
  if (stale(state, gen)) return
  if (!(await drainGuide(state, gen, phase))) return
  await afterTurn(state, phase, brainBefore)
}

/** One builder turn with the phase brief: the run's own Grok or Cursor tab, or the Opus builder. */
async function builderTurn(state: Live, gen: number, phase: BriefPhase, note?: string, viaOpus?: boolean): Promise<void> {
  const d = need()
  const run = state.run
  const brief = buildBrief({
    role: phase === 'review' ? 'self-check' : 'builder',
    tier: run.tier,
    phase,
    workRepo: run.workRepo,
    brainPath: run.brainPath,
    task: run.task,
    note,
    planPath: run.plan?.status === 'approved' && phase === 'build' ? runTextPath(run.id, 'plan') : undefined,
    reviewPath: phase === 'fix' && run.reviewCycles && !state.voiceFix ? runTextPath(run.id, 'review') : undefined,
    voicePath: phase === 'fix' && state.voiceFix && existsSync(runTextPath(run.id, 'voice')) ? runTextPath(run.id, 'voice') : undefined
  })
  if (opusBuilds(state, viaOpus)) return opusBuildTurn(state, gen, brief)
  try {
    await acpTurn(state, {
      tabId: run.acpTab,
      brainPath: run.brainPath,
      text: brief,
      onEvent: (ev) => {
        if (!stale(state, gen)) d.emit({ runId: run.id, kind: 'stream', ev })
      },
      onBuilder: (b, sid) => {
        if (!stale(state, gen)) setBuilder(state, b, sid)
      }
    })
  } catch (e) {
    if (!isNeedOpus(e) || stale(state, gen)) throw e
    setBuilder(state, 'opus')
    await opusBuildTurn(state, gen, brief)
  }
}

/**
 * Opus 5.5 medium as the builder: a fresh `claude -p` in bypassPermissions (can edit), cwd = work repo,
 * Factory env, no Anthropic keys. Stdout streams as text. Pause, abandon, and Guide kill it.
 */
async function opusBuildTurn(state: Live, gen: number, brief: string): Promise<void> {
  const d = need()
  const run = state.run
  const say = (ev: StreamEvent) => {
    if (!stale(state, gen)) d.emit({ runId: run.id, kind: 'stream', ev })
  }
  say({ kind: 'status', data: 'work:Opus is building' })
  const abort = new AbortController()
  state.abort = abort
  const res = await withLive(state, { phase: 'build', ...OPUS_LIVE }, () =>
    runOpus({
      cwd: run.workRepo,
      prompt: brief,
      env: d.env(run.workRepo),
      bin: (d.claudeBin || (() => resolveBin('claude')))(),
      timeoutMs: OPUS_REVIEW_TIMEOUT_MS,
      spawnFn: d.spawnOpus,
      signal: abort.signal,
      build: true,
      phase: 'build',
      maxBytes: d.opusMax
    })
  )
  if (state.abort === abort) state.abort = undefined
  addUsage(state, res.usage)
  persist(state)
  if (stale(state, gen)) return
  if (!res.found) throw new Error('Opus builder not found (claude CLI).')
  if (res.code !== 0) throw new Error(`Opus build did not finish (exit ${res.code}).`)
  if (!res.parsed) throw new Error('Opus build answer could not be read.')
  if (res.text) say({ kind: 'text', data: res.text })
}

/** Notes Joe sent while a turn ran: one follow-up turn with them before verify. False: the run moved. */
async function drainGuide(state: Live, gen: number, phase: BriefPhase): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const notes = openNotes(state.run)
    if (!notes.length) return true
    markSent(state)
    persist(state)
    if (!opusBuilds(state) && !(await warmGrunt(state, gen))) return false
    await builderTurn(state, gen, phase === 'fix' ? 'fix' : 'build', withGuide(undefined, notes))
    if (stale(state, gen)) return false
  }
  return true
}

function workerTab(state: Live, n: number): string {
  return `${state.run.acpTab}-w${n}`
}

function closeWorkers(state: Live): void {
  const d = need()
  for (const tabId of state.workers || []) {
    try {
      d.driver.cancel(tabId)
      d.driver.close(tabId)
    } catch {
      /* not warm */
    }
  }
  state.workers = []
}

/** T3: waves of up to 3 builders on non-overlapping files, same pool and Approve-in-advance setting. */
async function buildSlices(state: Live, gen: number, brainBefore: Record<string, string>): Promise<void> {
  const d = need()
  const run = state.run
  const slices = state.run.slices || []
  const waves = scheduleSlices(slices)
  let n = 0
  let needOpus = false
  // Every exit (done, stale, tripwire stop, a failed builder) closes the worker tabs.
  try {
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w].map((slice) => ({ slice, n: ++n, tabId: '' }))
      for (const job of wave) job.tabId = workerTab(state, job.n)
      state.workers = [...new Set([...(state.workers || []), ...wave.map((j) => j.tabId)])]
      // One builder fails: cancel the others so they stop editing, then fail the run with the first error.
      let failed: { e: unknown } | null = null
      await Promise.allSettled(
        wave.map(async (job) => {
          try {
            const w = await d.driver.warm({
              tabId: job.tabId,
              brainPath: run.brainPath,
              workRepo: run.workRepo,
              runThrough: run.runThrough,
              ...(state.run.builder === 'cursor' ? { builder: 'cursor' as const } : {})
            })
            if (w.builder === 'cursor' && !stale(state, gen)) setBuilder(state, 'cursor')
            if (stale(state, gen)) return
            await setEffort(state, 'xhigh', job.tabId)
            if (stale(state, gen)) return
            const brief = buildBrief({
              role: 'builder',
              tier: 'T3',
              phase: 'build',
              workRepo: run.workRepo,
              brainPath: run.brainPath,
              task: run.task,
              planPath: runTextPath(run.id, 'plan'),
              slice: { title: job.slice.title, files: job.slice.files, n: job.n, of: slices.length }
            })
            await acpTurn(state, {
              tabId: job.tabId,
              brainPath: run.brainPath,
              text: brief,
              onEvent: (ev) => {
                if (!stale(state, gen)) d.emit({ runId: run.id, kind: 'stream', ev })
              },
              onBuilder: (b) => {
                if (!stale(state, gen)) setBuilder(state, b)
              }
            })
          } catch (e) {
            if (!failed) {
              failed = { e }
              for (const other of wave) {
                if (other.tabId === job.tabId) continue
                try {
                  d.driver.cancel(other.tabId)
                } catch {
                  /* not warm */
                }
              }
            }
            throw e
          }
        })
      )
      const first = failed as { e: unknown } | null
      // Grok and Cursor both unusable: the workers stop and one Opus builder does the whole plan.
      if (first && isNeedOpus(first.e) && !stale(state, gen)) {
        needOpus = true
        break
      }
      if (first) throw first.e
      if (stale(state, gen)) return
      if (w === waves.length - 1) break
      // Between waves: one combined audit and tripwire before the next builders start.
      const audit = auditTurn({ brainPath: run.brainPath, workRepo: run.workRepo, brainBefore, base: run.base })
      const brain = [...new Set([...(state.run.audit?.brain || []), ...audit.brain])].sort()
      state.run = { ...state.run, audit: { brain, work: audit.work } }
      persist(state)
      const trip = checkTripwire(state.run.tier, audit.work)
      if (trip.trip && !(await onTrip(state, trip))) return
    }
  } finally {
    closeWorkers(state)
  }
  if (needOpus) {
    setBuilder(state, 'opus')
    await builderTurn(state, gen, 'build')
    if (stale(state, gen)) return
  }
  if (!(await drainGuide(state, gen, 'build'))) return
  await afterTurn(state, 'build', brainBefore)
}

/** A tripped tripwire. Approve in advance takes a suggested tier; otherwise (or no suggestion) wait on the card. True: go on. */
async function onTrip(state: Live, trip: Tripwire): Promise<boolean> {
  if (state.run.runThrough && trip.suggest) {
    state.run = { ...state.run, tier: trip.suggest, tripwire: { reasons: trip.reasons, suggest: trip.suggest, auto: true } }
    persist(state)
    return true
  }
  setPhase(state, 'upgrade', { tripwire: { reasons: trip.reasons, suggest: trip.suggest }, resumePhase: 'upgrade' })
  return false
}

async function afterTurn(state: Live, phase: BriefPhase, brainBefore: Record<string, string>): Promise<void> {
  // Audit the repo Joe is in: Grok may have written the repo the task or a Guide note names.
  // 'stop' (another run holds it, or it waits on prep): not an empty turn; the error or prep is on the run.
  if (reconcileWorkRepo(state) === 'stop') {
    if (!state.run.needsPrep) setPhase(state, 'paused', { resumePhase: 'build', error: state.run.error })
    return
  }
  const run = state.run
  const audit = auditTurn({ brainPath: run.brainPath, workRepo: run.workRepo, brainBefore, base: run.base })
  // Brain writes are shown, never reverted. They stay on the run for every later screen.
  const brain = [...new Set([...(run.audit?.brain || []), ...audit.brain])].sort()
  state.run = { ...state.run, audit: { brain, work: audit.work } }
  const trip = checkTripwire(state.run.tier, audit.work)
  if (trip.trip && !(await onTrip(state, trip))) return
  if (!audit.work.length && healEmptyTurn(state)) {
    const healed = auditTurn({ brainPath: state.run.brainPath, workRepo: state.run.workRepo, brainBefore, base: state.run.base })
    state.run = { ...state.run, audit: { brain, work: healed.work } }
    persist(state)
    if (healed.work.length) {
      const trip2 = checkTripwire(state.run.tier, healed.work)
      if (trip2.trip && !(await onTrip(state, trip2))) return
      if (phase === 'review') state.run = { ...state.run, selfChecked: true }
      await verifyStep(state)
      return
    }
  }
  if (!state.run.audit?.work.length) {
    // One more builder turn, then a pause Resume or Guide picks up. Not a failure.
    if (state.emptyRetry !== state.gen) {
      state.emptyRetry = state.gen
      await buildStep(state, phase, `The last turn changed no files in ${state.run.workRepo}. Make the change there.`)
      return
    }
    setPhase(state, 'paused', { error: 'This turn changed no files in the work repo.', resumePhase: 'build' })
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
  const t3 = state.run.tier === 'T3'
  const wanted = [names.typecheck || 'typecheck']
  if (state.run.tier !== 'T0') wanted.push(names.test || 'test')
  if (planned(state.run.tier)) wanted.push(names.e2e || 'e2e')
  // T3 full e2e: its own script when the repo has one; a skipped row otherwise.
  if (t3 && !wanted.includes('e2e:full')) wanted.push('e2e:full')
  const rows: VerifyRow[] = []
  const outs: string[] = []
  const env = d.env(state.run.workRepo)
  for (const script of wanted) {
    if (!scripts[script]) {
      rows.push({ script, status: 'skipped' })
      outs.push(`== npm run ${script}: skipped (no script)`)
      continue
    }
    const res = await (d.runScript || defaultRunScript)(state.run.workRepo, script, env)
    if (stale(state, gen)) return
    rows.push(res.code === 0 ? { script, status: 'pass' } : { script, status: 'fail', tail: tail(res.out) })
    outs.push(`== npm run ${script}: ${res.code === 0 ? 'pass' : `fail (exit ${res.code})`}\n${String(res.out || '').trimEnd()}`)
    state.run = { ...state.run, verify: [...rows] }
    persist(state)
  }
  // T3 artifact: the combined verify output beside the run record, never in the work repo.
  if (t3) state.run = { ...state.run, verifyArtifact: saveRunText(state.run.id, 'verify', outs.join('\n\n') + '\n') }
  state.run = { ...state.run, verify: rows }
  // A red suite that names none of this turn's files is the repo next door, not this work: the row stays, review goes on.
  // One that names a changed file gets one builder fix turn per verify pass, then review either way.
  const ours = ourFail(state.run)
  if (ours && state.verifyFix !== gen) {
    state.verifyFix = gen
    await buildStep(state, 'fix', `Verify failed: npm run ${ours.script}.\n${tail(ours.tail || '', 8)}`)
    return
  }
  await reviewStep(state)
}

/** The first red verify row that names a file this run changed. Unrelated red rows are the repo next door. */
function ourFail(run: RunRecord): VerifyRow | undefined {
  const changed = (run.audit?.work || []).map((r) => r.path).filter(Boolean)
  return (run.verify || []).find((r) => r.status === 'fail' && changed.some((p) => String(r.tail || '').includes(p)))
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
    setPhase(state, 'review', { diff: undefined, note: undefined, resumePhase: 'review' })
    const voiceDiff = safeDiff(state.run.workRepo, state.run.base)
    const row = await runVoice({
      runId: state.run.id,
      diff: voiceDiff,
      profile: state.run.profile,
      env: d.env(state.run.workRepo),
      spawnFn: d.spawnVoice,
      checkPath: d.voiceCheckPath
    })
    if (stale(state, gen)) return
    state.run = { ...state.run, voice: row }
    persist(state)
    // A REJECT fixes itself up to VOICE_MAX times, always on the grunt; after that it holds for Joe.
    if (row.status === 'fail') {
      const used = state.run.voiceCycles || 0
      saveRunText(state.run.id, 'voice', voiceNotes({ copy: copyAdds(voiceDiff), out: row.tail || '', attempt: Math.min(used + 1, VOICE_MAX), max: VOICE_MAX }))
      if (used < VOICE_MAX) {
        state.run = { ...state.run, voiceCycles: used + 1 }
        persist(state)
        await buildStep(state, 'fix', `Voice check said REJECT (attempt ${used + 1} of ${VOICE_MAX}).`, false, { voice: true })
        return
      }
    }
  }
  await finishReview(state)
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
  // Opus reviews now: the last fix note is done.
  setPhase(state, 'review', { diff: undefined, note: undefined, resumePhase: 'review' })
  const run = state.run
  const abort = new AbortController()
  state.abort = abort
  const res = await withLive(state, { phase: 'review', ...OPUS_LIVE, effort: STRICT_EFFORT }, () =>
    runOpus({
      cwd: run.workRepo,
      prompt: strictPrompt({ task: run.task, tier: run.tier, risk: run.risk, base: run.base, diff: safeDiff(run.workRepo, run.base), workRepo: run.workRepo, verify: run.verify }),
      env: d.env(run.workRepo),
      bin: (d.claudeBin || (() => resolveBin('claude')))(),
      timeoutMs: d.opusTimeoutMs ?? OPUS_REVIEW_TIMEOUT_MS,
      spawnFn: d.spawnOpus,
      signal: abort.signal,
      phase: 'review',
      run: { effort: STRICT_EFFORT },
      maxBytes: d.opusMax
    })
  )
  if (state.abort === abort) state.abort = undefined
  addUsage(state, res.usage)
  if (stale(state, gen)) {
    persist(state)
    return false
  }
  if (!res.found) {
    state.run = { ...state.run, strict: { status: 'missing', text: STRICT_MISSING }, followUps: undefined }
    persist(state)
    return true
  }
  // OUTSIDE items (no edit here can close them) go to Joe as follow-ups; the rest is the review.
  const split = splitOutside(res.text)
  state.run = { ...state.run, followUps: split.outside.length ? split.outside : undefined }
  // The controller reads the review (reviewAccept), not Opus's story: any gap is a fail, even under PASS.
  // A verdict comes only from a whole JSON envelope: cut, over-cap, or plain stdout is never read as PASS.
  const acc = res.code === 0 && res.parsed ? reviewAccept(split.review) : { status: 'fail' as const, why: NO_VERDICT }
  if (acc.status === 'pass') {
    state.run = { ...state.run, strict: { status: 'pass', text: tail(split.review, 12) } }
    persist(state)
    return true
  }
  const body = split.review.trim()
  const text = acc.why === 'FAIL' ? body : acc.why === NO_VERDICT ? `${NO_VERDICT}${body ? `\n${tail(body, 12)}` : ''}` : `${acc.why}.\n${body}`
  const cycles = (state.run.reviewCycles || 0) + 1
  saveRunText(run.id, 'review', text)
  state.run = { ...state.run, reviewCycles: cycles, strict: { status: 'fail', text: text.slice(-8000) } }
  persist(state)
  // Auto fix + a fresh independent review until REVIEW_MAX; the last fail holds for Joe.
  // Grok/Cursor make the first two review fixes; from the third on, Claude makes the fix.
  if (cycles < REVIEW_MAX) {
    const why = acc.why === 'FAIL' ? 'The strict reviewer said FAIL.' : `The strict reviewer did not approve: ${acc.why}. Every gap counts.`
    await buildStep(state, 'fix', why, cycles >= BUILDER_FIX_MAX)
    return false
  }
  return true
}

async function finishReview(state: Live): Promise<void> {
  // Joe guided during verify or review: that note gets a turn before anything commits.
  // The work is built by now: one builder fix turn carries the note, never a fresh (T3: sliced) build.
  if (openNotes(state.run).length) {
    await buildStep(state, 'fix', undefined, false, { voice: state.run.voice?.status === 'fail' })
    return
  }
  let diff = ''
  let read = true
  try {
    diff = diffText(state.run.workRepo, state.run.base)
  } catch (e) {
    read = false
    diff = `Could not read the diff: ${String((e as Error).message || e)}`
  }
  setPhase(state, 'review', { diff, resumePhase: 'review' })
  if (!read || !diff.trim()) return
  const reviewModel = [...(state.run.usage || [])].reverse().find((u) => u.phase === 'review')?.model
  state.run = { ...state.run, shadow: withGate(state.run.shadow, gateFor(state.run, { needed: strictNeeded(state.run), ourFail: !!ourFail(state.run), model: reviewModel })) }
  persist(state)
  const r = state.run
  if (r.voice?.status === 'fail') return
  // Only reviewAccept's pass is an Opus approval. A missing reviewer, a fail, or a held reject never
  // auto-commits or auto-pushes. Approve in advance commits; Ship in advance commits then pushes. Never deploys.
  // A red verify row that names a changed file waits for Joe, even after a PASS.
  if (ourFail(r)) return
  const opusOk = r.strict?.status === 'pass'
  const auto = opusOk ? r.runThrough || r.shipThrough : r.runThrough && !strictNeeded(r) && !r.strict
  if (!auto) return
  const done = commitRunNow(r.id)
  if (done.phase !== 'done') return
  state.run = { ...state.run, shadow: withAuto(state.run.shadow) }
  persist(state)
  if (opusOk && r.shipThrough) await publishRun(r.id)
}

function liveFor(id: string): Live {
  const hit = live.get(id)
  if (hit) return hit
  const run = restoreRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  return live.get(id)!
}

/** After an app restart: the run comes back paused, same tier, Grok session, and lock, on the repo its task or notes name. */
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
  if (run.phase !== 'paused') {
    const resumePhase: RunPhase = run.phase === 'failed' ? run.resumePhase || 'build' : run.phase
    state.run = { ...run, phase: 'paused', resumePhase }
    persist(state)
  }
  // An app update may read the notes differently: move now, not on the next Guide. A dirty new repo shows the prep card.
  reconcileWorkRepo(state)
  return state.run
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
  closeWorkers(state)
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
  // Resume that starts work first moves the run to the repo its task or Guide note names.
  const waitingPlan = target === 'plan' && run.plan?.status === 'waiting' && !!run.plan.text && !openNotes(run).length && !run.runThrough
  const waitingDiff = target === 'review' && !!run.diff && !openNotes(run).length
  if (!waitingPlan && !waitingDiff && !run.needsProceed) {
    if (reconcileWorkRepo(state) === 'stop') return state.run
  }
  return resumeTo(state, target)
}

function resumeTo(state: Live, target: RunPhase): RunRecord {
  const run = state.run
  if (target === 'triage') {
    // Still waiting on Commit first or Stash first: resume never starts triage.
    if (run.needsPrep) return setPhase(state, 'triage', { error: undefined })
    if (run.needsProceed) return setPhase(state, 'triage', { error: undefined })
    track(state, run.triage.llm ? afterTriage(state) : triageStep(state))
    return state.run
  }
  if (target === 'plan') {
    // A waiting plan comes back as it was; a resume never starts a build.
    if (run.plan?.status === 'waiting' && run.plan.text && !openNotes(run).length) {
      if (!run.runThrough) return setPhase(state, 'plan', { error: undefined })
      state.run = { ...run, error: undefined }
      track(state, approvePlan(state))
      return state.run
    }
    track(state, opusPlan(state))
    return state.run
  }
  if (target === 'review' && run.diff && openNotes(run).length) {
    track(state, buildStep(state, 'fix', undefined, false, { voice: run.voice?.status === 'fail' }))
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

export type Decision =
  | 'upgrade'
  | 'trim'
  | 'stop'
  | 'approve-plan'
  | 'reject-plan'
  | 'proceed'
  | 'fix-copy'
  | 'prep-commit'
  | 'prep-stash'
  | 'keep-fix'
  | 're-review'

export function decideRun(id: string, choice: Decision, opts: { reason?: string } = {}): RunRecord {
  const state = liveFor(id)
  const run = state.run
  if (choice === 'prep-commit' || choice === 'prep-stash') {
    if (run.phase !== 'triage' || run.needsPrep !== 'dirty') throw new Error('This run is not waiting on uncommitted changes.')
    state.gen++
    try {
      // Cleaned up by hand since Start: nothing to commit or stash.
      const paths = dirtyPaths(run.workRepo)
      if (paths.length && choice === 'prep-commit') commitRun(run.workRepo, paths, `WIP before Factory: ${run.title}`)
      else if (paths.length) stashAll(run.workRepo, `Factory: ${run.title}`)
    } catch (e) {
      const what = choice === 'prep-commit' ? 'Commit' : 'Stash'
      return setPhase(state, 'triage', { error: `${what} failed: ${String((e as Error).message || e).slice(0, 300)}` })
    }
    state.run = { ...state.run, base: headSha(run.workRepo), needsPrep: undefined, dirtyFiles: undefined, dirtyCount: undefined, error: undefined }
    persist(state)
    track(state, triageStep(state))
    return state.run
  }
  if (choice === 'approve-plan' || choice === 'reject-plan') {
    if (run.phase !== 'plan' || run.plan?.status !== 'waiting' || !run.plan.text) throw new Error('This run is not waiting on a plan.')
    state.gen++
    if (choice === 'approve-plan') {
      track(state, approvePlan(state))
      return state.run
    }
    const reason = String(opts.reason || '').trim().slice(0, 300)
    const plan = { ...run.plan, rejects: run.plan.rejects + 1, reasons: [...run.plan.reasons, reason] }
    state.run = { ...run, plan }
    if (plan.rejects >= 3) return setPhase(state, 'paused', { resumePhase: 'plan', error: 'Plan rejected three times. Paused.' })
    // Every reject is another fresh Opus process with the reasons and the rejected plan path.
    track(state, opusPlan(state))
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
    state.run = { ...state.run, voiceCycles: 0 }
    persist(state)
    track(state, buildStep(state, 'fix', `Voice check said REJECT. Fix the copy.\n${tail(run.voice.tail || '', 8)}`, false, { voice: true }))
    return state.run
  }
  if (choice === 'keep-fix' || choice === 're-review' || (choice === 'trim' && held(run))) {
    if (!held(run)) throw new Error('Opus has not held this run.')
    state.gen++
    // Cycles keep counting past REVIEW_MAX; each review is a fresh Opus process.
    if (choice === 'keep-fix') track(state, buildStep(state, 'fix', String(opts.reason || '').trim().slice(0, GUIDE_CHARS) || HELD_LINE, (run.reviewCycles || 0) >= BUILDER_FIX_MAX))
    else if (choice === 'trim') track(state, buildStep(state, 'trim', `${HELD_LINE} Cut the change down to what the task needs.`))
    else {
      state.run = { ...run, strict: undefined, followUps: undefined, diff: undefined, error: undefined }
      persist(state)
      track(state, reviewStep(state))
    }
    return state.run
  }
  if (run.phase !== 'upgrade') throw new Error('This run is not waiting on a tier decision.')
  if (choice === 'stop') return pauseRun(id)
  state.gen++
  if (choice === 'upgrade') {
    const next = run.tripwire?.suggest
    if (!next) throw new Error('Over T3, or a lockfile or schema change. Trim or stop.')
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

/** Phases whose in-flight work a Guide Send interrupts. Triage is short: its note waits for the plan or build. */
const INTERRUPTIBLE: RunPhase[] = ['plan', 'build', 'verify', 'review']

/** Guide Send while busy: the same cancel as Pause, without pausing or letting go of the lock. */
function interrupt(state: Live): void {
  state.gen++
  try {
    need().driver.cancel(state.run.acpTab)
  } catch {
    /* not warm */
  }
  state.abort?.abort()
  closeWorkers(state)
}

/**
 * Joe's note after Start. Stored on the run; the next builder or planner brief carries it (never the
 * Opus reviewer). A waiting plan gets a fresh Opus plan with it; a diff in review (a held reject
 * included) gets a builder turn with it. While a turn is in flight it interrupts that turn (planner,
 * builder, workers, verify, or reviewer) and starts the follow-up with the note at once.
 * A failed or paused run: this Send is Resume with the note. Triage in flight, prep, Proceed, and
 * tier cards keep it unsent for the next brief. A follow-up it starts marks the note sent before
 * this returns (opusPlan / buildStep mark it before their first await).
 * Every Send gets an ack bubble on the note (ACK_FILED or ACK_NOTED), no model call.
 */
export function guideRun(id: string, text: string): RunRecord {
  const state = liveFor(id)
  const body = String(text || '').trim().slice(0, GUIDE_CHARS)
  if (!body) throw new Error('Type a note first.')
  if (TERMINAL_PHASES.includes(state.run.phase)) throw new Error('This run is over. Start a new run.')
  const at = Date.now()
  state.run = { ...state.run, guide: [...(state.run.guide || []), { at, text: body }].slice(-GUIDE_MAX) }
  persist(state)
  // The reply bubble, no model call: filed with work in flight, or just noted for the next brief.
  const ack = guideRoute(state) ? ACK_FILED : ACK_NOTED
  state.run = { ...state.run, guide: state.run.guide?.map((g) => (g.at === at && g.text === body && !g.ack ? { ...g, ack } : g)) }
  return persist(state)
}

/** Routes a note guideRun just stored. True: work was in flight and this note interrupted it or started a follow-up now. */
function guideRoute(state: Live): boolean {
  // A note that names another repo moves the run there before any follow-up turn.
  if (reconcileWorkRepo(state) === 'stop') {
    // The new repo waits on Commit/Stash first: the turn still running in the old repo stops.
    if (state.run.needsPrep && state.busy) interrupt(state)
    return false
  }
  const run = state.run
  // Failed or paused is not a dead end: Send resumes with the note at once. Tier cards, Proceed, and prep wait.
  if (run.phase === 'failed' || run.phase === 'paused') {
    const target: RunPhase = run.resumePhase || 'build'
    if (target === 'upgrade' || run.needsPrep || run.needsProceed) return false
    state.gen++
    // Verify never carries a note: a run paused in verify (or review with no diff) gets a builder turn with it.
    resumeTo(state, target === 'verify' || (target === 'review' && !run.diff) ? 'build' : target)
    return true
  }
  if (state.busy) {
    if (!INTERRUPTIBLE.includes(run.phase) || run.needsPrep || run.needsProceed) return false
    interrupt(state)
    if (run.phase === 'plan') {
      // The killed planner never answered: its notes go to the fresh one with the new note.
      const carried = state.planNotes || []
      state.planNotes = undefined
      if (carried.length) state.run = { ...state.run, guide: state.run.guide?.map((g) => (carried.includes(g.text) && g.sent ? { at: g.at, text: g.text, repo: g.repo, ...(g.ack ? { ack: g.ack } : {}) } : g)) }
      track(state, opusPlan(state))
    }
    // Built or under review: a fix turn on the work. Otherwise one builder (T3 slices are not restarted).
    else {
      judgeGuide(state)
      track(state, buildStep(state, run.diff || run.phase === 'review' ? 'fix' : 'build'))
    }
    return true
  }
  if (run.phase === 'plan' && run.plan?.status === 'waiting' && run.plan.text) {
    state.gen++
    track(state, opusPlan(state))
    return false
  }
  // A diff exists: one builder fix turn with the note, never a fresh (T3: sliced) build.
  if (run.phase === 'review' && run.diff) {
    state.gen++
    judgeGuide(state)
    track(state, buildStep(state, 'fix', undefined, false, { voice: run.voice?.status === 'fail' }))
    return false
  }
  return false
}

/** Joe's note is about to start a fix turn on a reviewed diff: he did not take the loop's call as is. */
function judgeGuide(state: Live): void {
  if (state.run.phase === 'review' && state.run.diff && gateOpen(state.run.shadow)) state.run = { ...state.run, shadow: withJudgment(state.run.shadow, 'guide') }
}

/** by 'joe': a click (IPC). Only clicks are judgments in the shadow ledger; finishReview's auto-commit is not. */
export type Actor = { by?: 'joe' }

export function commitRunNow(id: string, o: Actor = {}): RunRecord {
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
    closeWorkers(state)
    try {
      need().driver.close(run.acpTab)
    } catch {
      /* */
    }
    const shadow = o.by === 'joe' ? withJudgment(state.run.shadow, 'commit') : state.run.shadow
    return setPhase(state, 'done', { commitSha: sha, branch, audit: { brain: run.audit?.brain || [], work: rows }, shadow })
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

/** True when Push is refused only because the branch is protected or Kennel-gated: Push anyway is offered. */
export function publishAnywayFor(id: string): boolean {
  const run = getRun(id)
  if (!run || run.phase !== 'done' || !run.commitSha || run.pushed) return false
  const t = { repo: run.workRepo, ...pushTarget(run) }
  return publishBlock(t) !== null && publishBlock(t, { allowProtected: true, kennelApproved: true }) === null
}

export const KENNEL_GATE_FAIL = 'Kennel gate did not approve'

/**
 * The Push click. Real git, run branch only, refused when HEAD moved or the branch is protected. With
 * allowProtected (Joe's Push anyway click, never finishReview) protected branches push, and Kennel
 * main/master/staging push only after a fresh Opus 5.5 medium review approves (Joe's Kennel rule).
 */
export async function publishRun(id: string, o: Actor & { allowProtected?: boolean } = {}): Promise<RunRecord> {
  const state = liveFor(id)
  const run = state.run
  if (run.phase !== 'done' || !run.commitSha) throw new Error('Push comes after Commit.')
  if (run.pushed) return run
  const t = pushTarget(run)
  let over: PushOverride = {}
  if (o.allowProtected) {
    const guard = publishBlock({ repo: run.workRepo, ...t }, { allowProtected: true, kennelApproved: true })
    if (guard) return setPhase(state, 'done', { pushError: guard })
    over = { allowProtected: true }
    if (isKennelGated(run.workRepo, t.branch)) {
      const d = need()
      const res = await withLive(state, { phase: 'review', ...OPUS_LIVE }, () =>
        runOpus({
          cwd: run.workRepo,
          prompt: strictPrompt({ task: run.task, tier: run.tier, risk: run.risk, base: run.base, diff: safeDiff(run.workRepo, run.base), workRepo: run.workRepo, verify: run.verify }),
          env: d.env(run.workRepo),
          bin: (d.claudeBin || (() => resolveBin('claude')))(),
          timeoutMs: d.opusTimeoutMs ?? OPUS_REVIEW_TIMEOUT_MS,
          spawnFn: d.spawnOpus,
          phase: 'review',
          run: { model: 'opus', effort: 'medium' },
          maxBytes: d.opusMax
        })
      )
      addUsage(state, res.usage)
      const acc = res.found && res.code === 0 && res.parsed ? reviewAccept(splitOutside(res.text).review) : { status: 'fail' as const, why: res.found ? NO_VERDICT : STRICT_MISSING }
      if (acc.status !== 'pass') {
        saveRunText(run.id, 'review', res.text || acc.why)
        return setPhase(state, 'done', { pushError: `${KENNEL_GATE_FAIL}: ${acc.why}` })
      }
      over = { allowProtected: true, kennelApproved: true }
    }
  }
  const block = publishBlock({ repo: run.workRepo, ...t }, over)
  if (block) return setPhase(state, 'done', { pushError: block })
  const pub = need().publish
  const res = pub ? await pub(run.workRepo, t, over) : await gitPublish(run.workRepo, t, undefined, over)
  if (!res.ok) return setPhase(state, 'done', { pushError: tail(res.out || 'git push failed.', 6) })
  const shadow = o.by === 'joe' ? withJudgment(state.run.shadow, 'push') : state.run.shadow
  return setPhase(state, 'done', { pushed: { ...t, at: Date.now() }, pushError: undefined, shadow })
}

function deployCmd(run: RunRecord): string {
  try {
    return String(readProfile(run.workRepo).deploy?.cmd || '')
  } catch {
    return ''
  }
}

/** Null when Deploy may run on this pushed run, else the sentence the disabled Deploy shows. */
export function deployBlockFor(id: string): string | null {
  const run = getRun(id)
  if (!run || run.phase !== 'done' || !run.pushed) return 'Deploy comes after Push.'
  if (run.deployed) return 'Deployed.'
  return deployBlock({ repo: run.workRepo, cmd: deployCmd(run) })
}

/** The Deploy click: the profile's cmd, no shims, never the model. The cmd never lands on the run. */
export async function deployRun(id: string): Promise<RunRecord> {
  const state = liveFor(id)
  const run = state.run
  if (run.phase !== 'done' || !run.pushed) throw new Error('Deploy comes after Push.')
  if (run.deployed) return run
  const cmd = deployCmd(run)
  const block = deployBlock({ repo: run.workRepo, cmd })
  if (block) return setPhase(state, 'done', { deployError: block })
  const d = need()
  // Same project bins as verify; deploy() strips the Factory shims.
  const res = await (d.deploy || gitDeploy)(run.workRepo, cmd, { env: d.env(run.workRepo) })
  if (!res.ok) return setPhase(state, 'done', { deployError: tail(res.out || 'Deploy failed.', 6) })
  return setPhase(state, 'done', { deployed: { at: Date.now() }, deployError: undefined })
}

export function abandonRun(id: string, o: Actor = {}): RunRecord {
  const state = liveFor(id)
  if (o.by === 'joe' && !TERMINAL_PHASES.includes(state.run.phase)) state.run = { ...state.run, shadow: withJudgment(state.run.shadow, 'abandon') }
  state.gen++
  state.abort?.abort()
  closeWorkers(state)
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
