/** Factory run shapes shared by main (run store, controller) and the Factory tab. */

export type Tier = 'T0' | 'T1' | 'T2' | 'T3'

/** T3: one builder per slice, files repo-relative. */
export type Slice = { title: string; files: string[] }

export type RunPhase =
  | 'intake'
  | 'triage'
  | 'plan'
  | 'build'
  | 'verify'
  | 'review'
  | 'commit'
  | 'done'
  | 'paused'
  | 'upgrade'
  | 'failed'
  | 'abandoned'

/** Opus strict reviews that may fail before the run holds for Joe: the first 12 fails each get an automatic fix (Joe 2026-09-29). */
export const REVIEW_MAX = 13

/**
 * Whether a run gets the Opus strict review: T2 and T3, elevated or critical risk, any MyPuppies path, and
 * any run with Ship in advance on (it only pushes after an Opus pass). Main and the Factory pane share it.
 */
export function strictRequired(run: { tier: Tier; risk: string; workRepo: string; shipThrough?: boolean }): boolean {
  return run.tier === 'T2' || run.tier === 'T3' || run.risk === 'elevated' || run.risk === 'critical' || /mypuppies/i.test(run.workRepo) || !!run.shipThrough
}

/** Automatic voice fixes before a voice REJECT holds for Joe (Joe 2026-09-29). */
export const VOICE_MAX = 12

/** From this strict-review cycle on, the review fix is made by the Opus builder, not Grok or Cursor (they get the first two). */
export const BUILDER_FIX_MAX = 3

/** Who makes the edits: Grok ACP first, Cursor Grok when Grok cannot run, Opus when neither can. */
export type Builder = 'grok' | 'cursor' | 'opus'

export const ACK_FILED = "Okay, we're filing that with the other work that's already in progress."
export const ACK_NOTED = 'Just noted.'

/** One note Joe sent from the Factory composer. `sent` once a builder or planner brief carried it. */
/** repo: what this note named when it was first read ('' for nothing), so a later move never re-reads it. */
/** ack: the reply bubble shown under the note. */
/** ask: a question. It never chooses the work repo. */
export type GuideNote = { at: number; text: string; sent?: boolean; repo?: string; ack?: string; ask?: boolean }

export type VerifyRow = { script: string; status: 'pass' | 'fail' | 'skipped'; tail?: string }

/** The verify row for the repo's own TypeScript when it has no typecheck script. */
export const TSC_ROW = 'tsc --noEmit'

/** What ran for a verify row: the local tsc, or the repo's npm script. */
export function verifyLabel(row: { script: string }): string {
  return row.script === TSC_ROW ? TSC_ROW : `npm run ${row.script}`
}

/** One model call. model is what the CLI said served it (never the configured name); '' when no answer came. */
export type UsageRow = {
  phase: 'triage' | 'plan' | 'review' | 'build' | 'approve'
  cli: 'claude' | 'grok' | 'cursor' | 'jev'
  model: string
  effort: string
  inTokens: number
  outTokens: number
  cacheRead: number
  cacheWrite: number
  /** The CLI's list-price equivalent in USD. Subscription calls are not billed this. */
  costEq: number
  ms: number
  turns: number
  ok: boolean
  at: number
}

/** Model calls in usage rows: a folded approver row counts each of its calls (turns). */
export function callCount(rows: UsageRow[] | undefined): number {
  return (rows || []).reduce((n, r) => n + (r.phase === 'approve' ? Math.max(1, r.turns) : 1), 0)
}

/** A model call in flight. id is per call, so a new turn on the same tab never loses its row. */
export type LiveCall = { id: string; phase: UsageRow['phase']; cli: UsageRow['cli']; model: string; effort: string; since: number; tab?: string }

/** "triage grok-4.6-build low; review claude-opus-5-5 medium": each served phase/model/effort once, in order. */
export function modelsLine(rows: UsageRow[] | undefined): string {
  const seen: string[] = []
  for (const r of rows || []) {
    if (!r.model) continue
    const t = `${r.phase} ${r.model}${r.effort ? ` ${r.effort}` : ''}`
    if (!seen.includes(t)) seen.push(t)
  }
  return seen.join('; ')
}

/** Who answers a builder's permission ask: a model on the signed-in Claude CLI, or nobody (the card, or Approve in advance). */
export type Approver = 'fable' | 'opus' | 'off'
export const APPROVERS: Approver[] = ['fable', 'opus', 'off']
export const APPROVER_NAME: Record<Approver, string> = { fable: 'Fable', opus: 'Opus 5.5', off: 'No model' }

/** One ask the approver answered. card: it handed the call to Joe (ASK, or no answer). */
export type AskLog = { n: number; at: number; title: string; decision: 'allow' | 'deny' | 'card'; by: string; why: string; repeat?: boolean }
export const ASK_LOG_MAX = 40

/** The loop's own ship call at the last finishReview, whatever the checkboxes say. */
export type ShadowGate = { id: string; wouldShip: boolean; strict: 'pass' | 'held' | 'missing' | 'none'; model: string; at: number }

export type JudgmentAction = 'commit' | 'push' | 'guide' | 'abandon'

/** One click by Joe against one gate. agree: he did what the loop would have done. */
export type Judgment = { gate: string; wouldShip: boolean; action: JudgmentAction; agree: boolean; at: number }

export type Shadow = { gate?: ShadowGate; judgments: Judgment[]; auto: number; autoGates?: string[]; noGate?: boolean }

/** Per work repo settings, kept in userData only. Keyed by lockKey(repo). */
export type RepoProfile = {
  repo: string
  scripts: { typecheck?: string; test?: string; e2e?: string }
  voice: { on: boolean; register?: string; audience?: string }
  publish: { remote: string }
  /** Deploy click only (never the model). userData profile only; runs never copy the cmd. */
  deploy?: { cmd?: string }
  /** Brain-relative folder for this repo's factory-log.md. Anything that leaves the brain is ignored. */
  brainFolder?: string
  updatedAt: number
}

export type RunRecord = {
  id: string
  title: string
  task: string
  brainPath: string
  workRepo: string
  tier: Tier
  risk: 'none' | 'elevated' | 'critical'
  triage: {
    size: string
    original: string
    capped: boolean
    reasons: string[]
    /** Model triage: what Jev (else Grok) said, or why both were skipped. */
    llm?: { size?: string; risk?: string; reason?: string; skipped?: string; by?: 'jev' | 'grok' }
  }
  /** Approve in advance: plan, suggested upgrades, and a clean Commit go ahead without a click; with no approver, permission asks too. Never push or deploy. */
  runThrough?: boolean
  /** Ship in advance: after a clean Opus pass (no gaps), commit and push. Never deploys; protected branches are refused. */
  shipThrough?: boolean
  /** Who answers the builder's permission asks. Missing (runs before 0.1.124) means off. */
  approver?: Approver
  /** What the approver did on this run: counts, and the last ASK_LOG_MAX answers. */
  asks?: { allowed: number; denied: number; carded: number; log: AskLog[] }
  /** Joe's notes after Start (last 20, each cut at 800). Unsent ones ride in the next builder or planner brief. */
  guide?: GuideNote[]
  /** Model triage raised risk to critical after Start: waits for a Proceed click. */
  needsProceed?: boolean
  /** The work repo had uncommitted changes at Start: waits for Commit first or Stash first. Triage has not run. */
  needsPrep?: 'dirty'
  /** Repo-relative porcelain paths seen at Start (cap 20). */
  dirtyFiles?: string[]
  /** How many paths were dirty at Start (uncapped). */
  dirtyCount?: number
  phase: RunPhase
  /** The phase a paused or failed run goes back to on Resume. */
  resumePhase?: RunPhase
  base: string
  /** Every repo this run has been in, with the base it had there. Missing on runs saved before 0.1.89. */
  repos?: { repo: string; base: string }[]
  /** Set when an empty turn found the builder's edits in an earlier repo and the run moved back there. */
  moved?: string
  /** Push cannot happen from here (no remote, or Ship in advance on a protected branch). Shown from Start. */
  pushWarn?: string
  acpTab: string
  /** The builder's ACP session (Grok or Cursor, see builder). */
  grokSessionId?: string
  /** Who builds this run. Set once a run falls back; it never flips back. Missing means Grok. */
  builder?: Builder
  /** T2: the plan Joe approves before any build. Full text sits beside the run record. */
  plan?: {
    text: string
    by: 'grok' | 'opus'
    /** blocked: the planner said it cannot plan here; it is never approved. */
    status: 'waiting' | 'approved' | 'blocked'
    /** The planner gave no PLAN: READY line: it waits for Joe even with Approve in advance on. */
    unready?: boolean
    rejects: number
    reasons: string[]
    approvedAt?: number
  }
  /** T3: slices from the plan's JSON line. */
  slices?: Slice[]
  /** The repo profile as it was at Start (no deploy cmd). */
  profile?: RepoProfile
  audit?: { brain: string[]; work: { path: string; added: number; deleted: number }[] }
  tripwire?: { reasons: string[]; suggest: 'T1' | 'T2' | 'T3' | null; auto?: boolean }
  verify?: VerifyRow[]
  /** T3: combined verify output beside the run record. */
  verifyArtifact?: string
  /** T1: the self-check turn ran. */
  selfChecked?: boolean
  /** Opus strict rejects (FAIL, or a PASS with gaps) for this run. REVIEW_MAX holds for Joe. */
  reviewCycles?: number
  /** Automatic voice fixes used since the last Fix copy. VOICE_MAX holds for Joe. */
  voiceCycles?: number
  strict?: { status: 'pass' | 'fail' | 'missing'; text: string }
  /** The reviewer's OUTSIDE items: things no edit in this repo can close. Not gaps. Cleared with strict. */
  followUps?: string[]
  voice?: VerifyRow
  diff?: string
  commitSha?: string
  /** Branch at commit time; Push only goes to this branch. */
  branch?: string
  pushed?: { remote: string; branch: string; sha: string; at: number }
  pushError?: string
  /** What a push of the committed branch sets off on its host (Vercel, Netlify, Railway), from the repo's link file. */
  deployHint?: { host: string; prod: boolean; line: string }
  /** Ship in advance committed but did not push: the push would deploy production. */
  shipHeld?: string
  /** The commit pushed to a preview branch (factory/<run id>); the real branch is not pushed by it. */
  preview?: { remote: string; branch: string; sha: string; at: number }
  previewError?: string
  deployed?: { at: number }
  deployError?: string
  /** What GitHub says about the pushed commit's deploy, from Brain's watch after the push. */
  deployWatch?: DeployWatch
  note?: string
  error?: string
  /** Every model call this run made (last 200). */
  usage?: UsageRow[]
  /** Model calls running right now. Memory and disk for the UI; loadRun drops it (no call survives a restart). */
  live?: LiveCall[]
  /** This run only. The conductor sets a boundary when Joe names it. The factory holds listen. */
  override?: { review?: boolean; voice?: boolean; tier?: boolean; proceed?: boolean }
  shadow?: Shadow
  /** The repo a blocked planner named (REPO: line). The run moves there once, after Joe's notes, before the task. */
  planRepo?: string
  /** How Start picked the work repo: the resolver step and the word that matched. */
  repoFrom?: { from: string; word?: string }
  /** What the team did, newest last (cap 300). Full text sits in the work repo's store; userData keeps it without text. */
  events?: RunEvent[]
  createdAt: number
  updatedAt: number
}

/**
 * The pushed commit's deploy as GitHub reports it. watching: nothing yet. none: nothing started in the 3
 * minutes after the push. unknown: Brain cannot watch (no gh, gh signed out, not a github.com remote), or
 * the build ran past 20 minutes.
 */
export type DeployWatch =
  | { state: 'watching'; since: number }
  | { state: 'building'; host: string; env?: string; url?: string; since: number }
  | { state: 'live'; host: string; env?: string; url?: string; at: number }
  | { state: 'failed'; host: string; env?: string; url?: string; at: number }
  | { state: 'none'; at: number }
  | { state: 'unknown'; why: string; at: number }

/** The ship block's deploy line (and the thread's) for a watch state. */
export function deployWatchLine(w: DeployWatch): string {
  switch (w.state) {
    case 'watching':
      return 'Watching for a deploy...'
    case 'building':
      return `${w.host} is building ${w.env ? w.env.toLowerCase() : 'this push'}...`
    case 'live':
      return w.url ? `Live on ${w.host}: ${w.url}` : `Live on ${w.host}.`
    case 'failed':
      return w.url ? `${w.host} deploy failed: ${w.url}` : `${w.host} deploy failed.`
    case 'none':
      return 'No deploy started in the 3 minutes after the push.'
    case 'unknown':
      return `Brain can't watch this host: ${w.why}`
  }
}

/** Deploy stays off while the host has the push (watching, building, live). Null: the watch leaves Deploy to its other rules. */
export function watchDeployBlock(w: DeployWatch | undefined): string | null {
  if (w?.state === 'watching') return 'Brain is watching GitHub for a deploy from this push.'
  if (w?.state === 'building') return `${w.host} is building this push.`
  if (w?.state === 'live') return `Live on ${w.host}.`
  return null
}

export type HoldKind = 'dirty' | 'review' | 'voice' | 'tier' | 'proceed' | 'plan' | 'paused' | 'failed'

/** Something the run waits on Joe for. The Factory thread asks it; the run's events record each one. */
export type Hold = { kind: HoldKind; text: string }

export type RunEvent =
  | { at: number; kind: 'repo'; repo: string; moved: boolean; from?: string; word?: string; planner?: boolean }
  | { at: number; kind: 'plan'; status: 'waiting' | 'approved' | 'blocked'; by: 'grok' | 'opus'; text: string }
  | { at: number; kind: 'turn'; call: number; model: string; ms: number; ok: boolean; files: number; added: number; deleted: number; paths: string[] }
  | { at: number; kind: 'test'; rows: VerifyRow[] }
  | { at: number; kind: 'review'; round: number; status: 'pass' | 'fail' | 'missing'; text: string }
  | { at: number; kind: 'voice'; status: VerifyRow['status']; text: string }
  | { at: number; kind: 'commit'; sha: string; branch?: string }
  | { at: number; kind: 'push'; ok: boolean; text: string }
  | { at: number; kind: 'deploy'; ok: boolean; text: string }
  | { at: number; kind: 'watch'; state: DeployWatch['state']; line: string }
  | { at: number; kind: 'hold'; hold: HoldKind; text: string }
  | { at: number; kind: 'ask'; n: number; decision: 'deny' | 'card'; title: string; by: string; text: string }
  | { at: number; kind: 'end'; phase: 'done' | 'abandoned' }

/** The hold Joe has to answer, or null. One order for the conductor, the thread, and the events. */
export function holdOf(run: RunRecord): Hold | null {
  if (run.needsPrep === 'dirty') {
    const n = run.dirtyCount ?? run.dirtyFiles?.length ?? 0
    return { kind: 'dirty', text: `This repo has uncommitted changes (${n} ${n === 1 ? 'file' : 'files'}).` }
  }
  if (run.phase === 'review' && !!run.diff && run.strict?.status === 'fail' && (run.reviewCycles || 0) >= REVIEW_MAX) {
    return { kind: 'review', text: `Opus has not approved after ${run.reviewCycles} reviews.` }
  }
  if (run.voice?.status === 'fail' && (run.voiceCycles || 0) >= VOICE_MAX) return { kind: 'voice', text: `Voice has not approved after ${VOICE_MAX} fixes.` }
  if (run.phase === 'upgrade') return { kind: 'tier', text: (run.tripwire?.reasons || []).join(' ') || `Over the ${run.tier} limit.` }
  if (run.needsProceed) {
    const by = run.triage.llm?.skipped ? 'Model triage did not answer.' : `${run.triage.llm?.by === 'jev' ? 'Jev' : 'Grok'} says this is critical risk.`
    return { kind: 'proceed', text: by }
  }
  if (run.phase === 'plan' && run.plan?.status === 'blocked') return { kind: 'plan', text: 'The planner could not plan here.' }
  if (run.phase === 'plan' && run.plan?.status === 'waiting' && !!run.plan.text && run.plan.unready) {
    return { kind: 'plan', text: 'The planner did not say the plan is ready. Read it, then approve or re-plan.' }
  }
  if (run.phase === 'plan' && run.plan?.status === 'waiting' && !!run.plan.text && !run.runThrough) return { kind: 'plan', text: 'The plan is waiting for your approval.' }
  if (run.phase === 'paused') return { kind: 'paused', text: run.error || 'Paused.' }
  if (run.phase === 'failed') return { kind: 'failed', text: run.error || 'The run failed.' }
  return null
}

export type FactoryTriage = {
  size: 'T0' | 'T1' | 'T2' | 'T3'
  original: 'T0' | 'T1' | 'T2' | 'T3'
  risk: 'none' | 'elevated' | 'critical'
  capped: boolean
  reasons: string[]
  ms: number
}
