export function driveOn(): boolean {
  return process.env.BRAIN_APP_SETUP_DRIVE === '1'
}

export function absentIds(): Set<string> {
  if (!driveOn()) return new Set()
  const raw = String(process.env.BRAIN_APP_PRETEND_ABSENT || '').trim()
  if (!raw) return new Set()
  if (raw === '1' || raw === 'all') return new Set(['git', 'cloudflared'])
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  )
}

export function forcedPresent(id: string): boolean {
  if (!driveOn()) return false
  if (absentIds().has(id)) return false
  const raw = String(process.env.BRAIN_APP_PRETEND_PRESENT || '').trim()
  if (!raw) return false
  return raw
    .split(',')
    .map((part) => part.trim())
    .includes(id)
}

export function pretendExit(id: string): number | null {
  if (!driveOn()) return null
  const raw = String(process.env.BRAIN_APP_PRETEND_EXIT || '').trim()
  if (!raw) return null
  for (const part of raw.split(',')) {
    const [key, value] = part.trim().split(':')
    if (key !== id || value === undefined || value === '') continue
    const code = Number(value)
    if (Number.isFinite(code)) return code
  }
  return null
}

export type AgencyPretend = { app: boolean; bridge: boolean; copy: boolean }

export function agencyPretend(): AgencyPretend | null {
  if (!driveOn()) return null
  const raw = String(process.env.BRAIN_APP_PRETEND_AGENCY || '').trim()
  if (raw === 'bridge-on') return { app: true, bridge: true, copy: true }
  if (raw === 'bridge-off') return { app: true, bridge: false, copy: true }
  if (raw === 'app-off') return { app: false, bridge: false, copy: false }
  return null
}

export type InstallPretend = {
  installed: boolean
  repositorySelection: string
  repo: string
  projectSeatCount?: number
}

export function installPretend(expectedRepo: string): InstallPretend | null {
  if (!driveOn()) return null
  const raw = String(process.env.BRAIN_APP_PRETEND_INSTALL || '').trim()
  if (!raw) return null
  const repo = String(expectedRepo || '').trim()
  if (raw === 'off' || raw === 'not-installed') return { installed: false, repositorySelection: '', repo }
  if (raw === 'all') return { installed: true, repositorySelection: 'all', repo }
  if (raw === 'all_repositories') return { installed: true, repositorySelection: 'all_repositories', repo }
  if (raw === 'wrong-repo') return { installed: true, repositorySelection: 'selected', repo: 'other/other-brain' }
  if (raw === 'missing') return { installed: true, repositorySelection: '', repo }
  if (raw === 'selected') return { installed: true, repositorySelection: 'selected', repo }
  return null
}

const PRETEND_JOIN = ['TEAMJOIN1', 'PROJJOIN1', 'OWNRJOIN1', 'OWNRPEND1']

export function pretendJoinEnabled(): boolean {
  return driveOn() && Boolean(String(process.env.BRAIN_APP_PRETEND_JOIN || '').trim())
}

export function isPretendJoinCode(code: string): boolean {
  if (!pretendJoinEnabled()) return false
  return PRETEND_JOIN.includes(String(code || '').replace(/[-\s]/g, '').toUpperCase())
}
