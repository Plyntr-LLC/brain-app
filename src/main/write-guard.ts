import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Brain.app file helpers refuse agency-team writes under skills/ and .team-config/.
 * Owner and scout writes are allowed. A CLI that writes the folder itself can still
 * bypass this until a later hook.
 */
export const TEAM_WRITE_REFUSAL =
  'Agency team can read skills and team config. Brain.app will not write those files. The CLI on this Mac can still write them until a later hook.'

export function isAgencyTeamRole(role?: string | null): boolean {
  const r = String(role || '').trim().toLowerCase()
  return r === 'team' || r === 'member'
}

function posixRel(root: string, target: string): string | null {
  const base = resolve(root)
  const abs = isAbsolute(target) ? resolve(target) : resolve(base, target)
  if (abs === base) return ''
  const rel = relative(base, abs)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function isProtectedBrainPath(relPosix: string): boolean {
  const top = String(relPosix || '').split('/').filter(Boolean)[0]?.toLowerCase() || ''
  return top === 'skills' || top === '.team-config'
}

/** Empty when this write is allowed. A sentence when agency team is writing a protected path. */
export function brainWriteBlock(role: string | null | undefined, root: string, target: string): string | null {
  if (!isAgencyTeamRole(role)) return null
  const base = String(root || '').trim()
  const path = String(target || '').trim()
  if (!base || !path) return null
  const rel = posixRel(base, path)
  if (rel == null || !isProtectedBrainPath(rel)) return null
  return TEAM_WRITE_REFUSAL
}
