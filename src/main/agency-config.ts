/** Agency Brain config.json profile swap. Same keys Mike uses. Never log this object. */

export const BRAIN_PROFILE_KEYS = [
  'brainPath',
  'mode',
  'teamSlug',
  'memberEmail',
  'memberName',
  'memberRole',
  'memberToken',
  'scoutSeats',
  'packageTier',
  'kind',
  'brandName'
] as const

export type AgencyProfile = {
  brainPath: string
  mode?: string
  teamSlug?: string
  memberEmail?: string
  memberName?: string
  memberRole?: string
  memberToken?: string
  scoutSeats?: number | null
  packageTier?: string | null
  kind?: string
  brandName?: string
}

export type AgencyConfig = AgencyProfile & {
  brains?: AgencyProfile[]
  [k: string]: unknown
}

export function brainKey(p: { teamSlug?: string; brainPath?: string } | null | undefined): string {
  if (!p) return ''
  return String(p.teamSlug || p.brainPath || '').trim()
}

export function profileFromActive(cfg: AgencyConfig): AgencyProfile {
  const p: AgencyProfile = { brainPath: String(cfg.brainPath || '') }
  for (const k of BRAIN_PROFILE_KEYS) {
    if (cfg[k] !== undefined) (p as Record<string, unknown>)[k] = cfg[k]
  }
  return p
}

export function upsertProfile(brains: AgencyProfile[], profile: AgencyProfile): AgencyProfile[] {
  const key = brainKey(profile)
  if (!key || !profile.brainPath) return brains
  const next = brains.filter((b) => brainKey(b) !== key)
  next.push(profile)
  return next
}

export function findProfile(cfg: AgencyConfig, folder: string, slug?: string): AgencyProfile | null {
  const path = String(folder || '').trim()
  const want = String(slug || '').trim().toLowerCase()
  const rows = [
    ...(Array.isArray(cfg.brains) ? cfg.brains : []),
    profileFromActive(cfg)
  ]
  const byPath = rows.find((b) => String(b.brainPath || '').trim() === path && path)
  if (byPath?.brainPath) return byPath
  if (want) {
    const bySlug = rows.find((b) => String(b.teamSlug || '').trim().toLowerCase() === want)
    if (bySlug?.brainPath) return { ...bySlug, brainPath: path || bySlug.brainPath }
  }
  return null
}

/** Archive the current brain, then make `target` the active top-level profile. */
export function activateProfile(cfg: AgencyConfig, target: AgencyProfile): AgencyConfig {
  const prev = { ...cfg }
  let brains = Array.isArray(cfg.brains) ? cfg.brains.slice() : []
  if (prev.brainPath && brainKey(prev) && brainKey(prev) !== brainKey(target)) {
    brains = upsertProfile(brains, profileFromActive(prev))
  }
  const next: AgencyConfig = { ...cfg }
  for (const k of BRAIN_PROFILE_KEYS) delete next[k]
  Object.assign(next, target)
  if (next.brainPath && brainKey(next)) brains = upsertProfile(brains, profileFromActive(next))
  if (brains.length) next.brains = brains
  return next
}

export function alreadyActive(cfg: AgencyConfig, folder: string, slug?: string): boolean {
  const path = String(folder || '').trim()
  if (!path || String(cfg.brainPath || '').trim() !== path) return false
  const want = String(slug || '').trim()
  if (want && String(cfg.teamSlug || '').trim() && String(cfg.teamSlug || '').trim() !== want) return false
  return true
}
