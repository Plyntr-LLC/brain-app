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

/** Opus strict reviews that may fail before the run holds for Joe: the first 5 fails each get an automatic fix (Joe 2026-09-29). */
export const REVIEW_MAX = 6

/** Automatic voice fixes before a voice REJECT holds for Joe (Joe 2026-09-29). */
export const VOICE_MAX = 5

/** From this strict-review cycle on, the review fix is made by the Opus builder, not Grok or Cursor (they get the first two). */
export const BUILDER_FIX_MAX = 3

/** Who makes the edits: Grok ACP first, Cursor Grok when Grok cannot run, Opus when neither can. */
export type Builder = 'grok' | 'cursor' | 'opus'

export const ACK_FILED = "Okay, we're filing that with the other work that's already in progress."
export const ACK_NOTED = 'Just noted.'

/** One note Joe sent from the Factory composer. `sent` once a builder or planner brief carried it. */
/** repo: what this note named when it was first read ('' for nothing), so a later move never re-reads it. */
/** ack: the reply bubble shown under the note (no model call). */
export type GuideNote = { at: number; text: string; sent?: boolean; repo?: string; ack?: string }

export type VerifyRow = { script: string; status: 'pass' | 'fail' | 'skipped'; tail?: string }

/** One model call. model is what the CLI said served it (never the configured name); '' when no answer came. */
export type UsageRow = {
  phase: 'triage' | 'plan' | 'review' | 'build'
  cli: 'claude' | 'grok' | 'cursor'
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
    /** Model triage: what Grok said, or why it was skipped. */
    llm?: { size?: string; risk?: string; reason?: string; skipped?: string }
  }
  /** Approve in advance: plan, permission asks, suggested upgrades, and a clean Commit go ahead without a click. Never push or deploy. */
  runThrough?: boolean
  /** Ship in advance: after a clean Opus pass (no gaps), commit and push. Never deploys; protected branches are refused. */
  shipThrough?: boolean
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
    status: 'waiting' | 'approved'
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
  deployed?: { at: number }
  deployError?: string
  note?: string
  error?: string
  /** Every model call this run made (last 200). */
  usage?: UsageRow[]
  /** Model calls running right now. Memory and disk for the UI; loadRun drops it (no call survives a restart). */
  live?: LiveCall[]
  shadow?: Shadow
  createdAt: number
  updatedAt: number
}

export type FactoryTriage = {
  size: 'T0' | 'T1' | 'T2' | 'T3'
  original: 'T0' | 'T1' | 'T2' | 'T3'
  risk: 'none' | 'elevated' | 'critical'
  capped: boolean
  reasons: string[]
  ms: number
}
