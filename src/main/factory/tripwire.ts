/** Post-turn tripwire: over the tier limits, a lockfile, or a schema change asks a person. Never changes tier. */

import type { Tier } from '../../shared/factory.ts'

export type NumstatRow = { path: string; added: number; deleted: number }

export const TIER_LIMITS = {
  T0: { files: 1, lines: 20 },
  T1: { files: 3, lines: 150 },
  T2: { files: 10, lines: 600 },
  T3: { files: 40, lines: 2500 }
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
  /** The smallest tier above this one that fits with no lockfile or schema change. Null over T3, or on a lockfile or schema change. */
  suggest: 'T1' | 'T2' | 'T3' | null
  files: number
  lines: number
}

function base(path: string): string {
  return path.split('/').pop()?.toLowerCase() || ''
}

const ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3']

export function checkTripwire(tier: Tier, rows: NumstatRow[]): Tripwire {
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
  let suggest: Tripwire['suggest'] = null
  if (trip && !locks.length && !schema.length) {
    for (const next of ORDER.slice(ORDER.indexOf(tier) + 1) as ('T1' | 'T2' | 'T3')[]) {
      if (files <= TIER_LIMITS[next].files && lines <= TIER_LIMITS[next].lines) {
        suggest = next
        break
      }
    }
  }
  return { trip, reasons, suggest, files, lines }
}
