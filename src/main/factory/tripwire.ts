/** Post-turn tripwire: over the tier limits, a lockfile, or a schema change asks a person. Never changes tier. */

export type NumstatRow = { path: string; added: number; deleted: number }

export const TIER_LIMITS = {
  T0: { files: 1, lines: 20 },
  T1: { files: 3, lines: 150 }
} as const

export const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum'
])

export const SCHEMA_RE = /(^|\/)(migrations?|prisma|drizzle|db\/schema)\/|\.sql$|(^|\/)schema\.(prisma|graphql|gql|sql|rb)$/i

export type Tripwire = {
  trip: boolean
  reasons: string[]
  /** 'T1' when a T0 run is over T0 but inside T1 with no lockfile or schema change. Null otherwise (T2 is Slice 2). */
  suggest: 'T1' | null
  files: number
  lines: number
}

function base(path: string): string {
  return path.split('/').pop()?.toLowerCase() || ''
}

export function checkTripwire(tier: 'T0' | 'T1', rows: NumstatRow[]): Tripwire {
  const files = rows.length
  const lines = rows.reduce((n, r) => n + (r.added || 0) + (r.deleted || 0), 0)
  const reasons: string[] = []
  const lim = TIER_LIMITS[tier]
  if (files > lim.files) reasons.push(`${files} files changed. ${tier} allows ${lim.files}.`)
  if (lines > lim.lines) reasons.push(`${lines} lines changed. ${tier} allows ${lim.lines}.`)
  const locks = rows.filter((r) => LOCKFILES.has(base(r.path))).map((r) => r.path)
  if (locks.length) reasons.push(`Lockfile changed: ${locks.join(', ')}.`)
  const schema = rows.filter((r) => SCHEMA_RE.test(r.path)).map((r) => r.path)
  if (schema.length) reasons.push(`Schema or migration changed: ${schema.join(', ')}.`)
  const trip = reasons.length > 0
  const fitsT1 = files <= TIER_LIMITS.T1.files && lines <= TIER_LIMITS.T1.lines && !locks.length && !schema.length
  return { trip, reasons, suggest: trip && tier === 'T0' && fitsT1 ? 'T1' : null, files, lines }
}
