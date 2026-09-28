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

/** Opus strict reviews that may fail before the run holds for Joe (auto fix + fresh review until then). */
export const REVIEW_MAX = 5

/** One note Joe sent from the Factory composer. `sent` once a builder or planner brief carried it. */
export type GuideNote = { at: number; text: string; sent?: boolean }

export type VerifyRow = { script: string; status: 'pass' | 'fail' | 'skipped'; tail?: string }

/** Per work repo settings, kept in userData only. Keyed by lockKey(repo). */
export type RepoProfile = {
  repo: string
  scripts: { typecheck?: string; test?: string; e2e?: string }
  voice: { on: boolean; register?: string; audience?: string }
  publish: { remote: string }
  /** Deploy click only (never the model). userData profile only; runs never copy the cmd. */
  deploy?: { cmd?: string }
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
  acpTab: string
  grokSessionId?: string
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
  strict?: { status: 'pass' | 'fail' | 'missing'; text: string }
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
