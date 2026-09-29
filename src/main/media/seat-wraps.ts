import { rootsOverlap } from './hmac-seat.ts'

export type SeatTarget = { role: string; roots: string[] | null }
export type LiveScope = { id: string; root: string; keyVersion: number }
export type PlannedWrap = { scope: string; keyVersion: number }
export type HeldWrap = { scope: string; key_version: number }

export function isBuilderRole(role: string): boolean {
  return role === 'owner' || role === 'scout'
}

/** What a Mac on this seat may hold. Only owner and scout get the brain key. */
export function seatWrapPlan(target: SeatTarget, scopes: LiveScope[], brainKeyVersion: number): PlannedWrap[] {
  const all = scopes.map((s) => ({ scope: s.id, keyVersion: s.keyVersion }))
  if (isBuilderRole(target.role)) return [{ scope: 'brain', keyVersion: brainKeyVersion }, ...all]
  if (target.role === 'team') return all
  if (target.role === 'project' || target.role === 'client-project') {
    const roots = target.roots || []
    return scopes
      .filter((s) => rootsOverlap(roots, s.root))
      .map((s) => ({ scope: s.id, keyVersion: s.keyVersion }))
  }
  return []
}

/**
 * An owner or scout Mac is ready once it holds the brain key. Anyone else is ready once it can open
 * every project its seat shows it; a brain with nothing stored yet counts as ready.
 */
export function joinReady(opts: {
  builder: boolean
  wraps: HeldWrap[]
  scopes: LiveScope[]
  brainKeyVersion: number
}): boolean {
  const has = (scope: string, v: number) => opts.wraps.some((w) => w.scope === scope && w.key_version === v)
  if (opts.builder) return has('brain', opts.brainKeyVersion)
  return opts.scopes.every((s) => has(s.id, s.keyVersion))
}

/** The planned wraps the target does not hold yet. */
export function missingWraps(plan: PlannedWrap[], held: { scope: string; keyVersion: number }[]): PlannedWrap[] {
  return plan.filter((p) => !held.some((h) => h.scope === p.scope && h.keyVersion === p.keyVersion))
}
