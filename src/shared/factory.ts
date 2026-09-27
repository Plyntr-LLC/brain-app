/** Factory run shapes shared by main (run store, controller) and the Factory tab. */

export type Tier = 'T0' | 'T1' | 'T2'

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

export type VerifyRow = { script: string; status: 'pass' | 'fail' | 'skipped'; tail?: string }

/** Per work repo settings, kept in userData only. Keyed by lockKey(repo). */
export type RepoProfile = {
  repo: string
  scripts: { typecheck?: string; test?: string; e2e?: string }
  voice: { on: boolean; register?: string; audience?: string }
  publish: { remote: string }
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
  /** Model triage raised risk to critical after Start: waits for a Proceed click. */
  needsProceed?: boolean
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
  /** The repo profile as it was at Start. */
  profile?: RepoProfile
  audit?: { brain: string[]; work: { path: string; added: number; deleted: number }[] }
  tripwire?: { reasons: string[]; suggest: 'T1' | 'T2' | null }
  verify?: VerifyRow[]
  /** T1: the self-check turn ran. */
  selfChecked?: boolean
  /** Opus strict FAIL count for this run. */
  reviewCycles?: number
  strict?: { status: 'pass' | 'fail' | 'missing'; text: string }
  voice?: VerifyRow
  diff?: string
  commitSha?: string
  /** Branch at commit time; Push only goes to this branch. */
  branch?: string
  pushed?: { remote: string; branch: string; sha: string; at: number }
  pushError?: string
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
