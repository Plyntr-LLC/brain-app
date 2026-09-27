/** Factory run shapes shared by main (run store, controller) and the Factory tab. */

export type RunPhase =
  | 'intake'
  | 'triage'
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

export type RunRecord = {
  id: string
  title: string
  task: string
  brainPath: string
  workRepo: string
  tier: 'T0' | 'T1'
  risk: 'none' | 'elevated' | 'critical'
  triage: { size: string; original: string; capped: boolean; reasons: string[] }
  phase: RunPhase
  /** The phase a paused or failed run goes back to on Resume. */
  resumePhase?: RunPhase
  base: string
  acpTab: string
  grokSessionId?: string
  audit?: { brain: string[]; work: { path: string; added: number; deleted: number }[] }
  tripwire?: { reasons: string[]; suggest: 'T1' | null }
  verify?: VerifyRow[]
  /** T1: the self-check turn ran. */
  selfChecked?: boolean
  diff?: string
  commitSha?: string
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
