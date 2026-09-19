export type PathKind = 'create' | 'join' | 'second'
export type AiKind = 'claude' | 'grok' | 'gpt' | 'cursor'
export type SeatRole = 'owner' | 'scout' | 'team' | 'project'

export function asSeat(role?: string): SeatRole {
  const r = String(role || '').toLowerCase()
  if (r === 'scout') return 'scout'
  if (r === 'project' || r === 'project-only' || r === 'project_team' || r === 'project-team') return 'project'
  if (r === 'team' || r === 'member') return 'team'
  if (r === 'owner' || r === 'head_scout') return 'owner'
  return 'team'
}

export function seatLabel(role?: string): string {
  const r = asSeat(role)
  if (r === 'owner') return 'Owner'
  if (r === 'scout') return 'Scout'
  if (r === 'project') return 'Project only'
  return 'Agency team'
}

export function isTeamSeat(role?: string): boolean {
  const r = asSeat(role)
  return r === 'team' || r === 'project'
}
export type NeedId = 'what' | 'who' | 'offer' | 'voice' | 'now' | 'people' | 'you'

export type Member = { email: string; name?: string; token: string }
export type Team = { slug: string; name: string; role: string; kind?: string; repoUrl?: string }

export type Need = { id: NeedId; label: string; ask: string }

export type Session = {
  path: PathKind
  screen: string
  email: string
  member?: Omit<Member, 'token'>
  teams: Team[]
  team?: Team
  kind?: 'client' | 'agency'
  role?: string
  brainKind?: 'hq' | 'project'
  business: string
  orgLogin?: string
  ai?: AiKind
  brainPath?: string
  abWatching: boolean
  dryRun: boolean
  filled: Partial<Record<NeedId, boolean>>
  parked: string[]
}

export const OWNER_NEEDS: Need[] = [
  { id: 'what', label: 'What you do', ask: 'Tell me what the business does, however you want to say it.' },
  { id: 'who', label: 'Who you serve', ask: 'Who is it for? Who buys, and what are they stuck with?' },
  { id: 'offer', label: 'What you sell', ask: 'What do you actually sell, and what does it cost, even roughly?' },
  { id: 'voice', label: 'How you write', ask: 'When this writes as you, how should it sound?' },
  { id: 'now', label: 'What matters now', ask: 'What matters most over the next month or two?' },
  { id: 'people', label: "Who's on the team", ask: "Who's on the team? Just you is a fine answer." }
]

export const TEAM_NEED: Need = {
  id: 'you',
  label: 'How you work',
  ask: 'Who are you here, and how do you like to work?'
}

export const STEPS = [
  { id: 'signed', label: 'Signed in' },
  { id: 'ab', label: 'Shared folder ready' },
  { id: 'ai', label: 'AI connected' },
  { id: 'know', label: 'Getting to know you' },
  { id: 'invite', label: 'Invite your people' }
] as const

export const DOWNLOAD_AB = 'https://ads2ai.com/downloads'
export const API_BASE = 'https://api.ads2ai.com'
export const GITHUB_NEW_ORG = 'https://github.com/account/organizations/new'
export const GITHUB_APP_INSTALL = 'https://github.com/apps/agency-brain-sync/installations/new'
