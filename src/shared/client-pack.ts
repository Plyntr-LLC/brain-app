export const CLIENT_PACKS = ['starter', 'standard', 'growth'] as const
export type ClientPack = (typeof CLIENT_PACKS)[number]

export function isClientPack(raw: unknown): raw is ClientPack {
  return raw === 'starter' || raw === 'standard' || raw === 'growth'
}

export function packLabel(pack?: string | null): string {
  if (pack === 'starter') return 'Starter'
  if (pack === 'standard') return 'Standard'
  if (pack === 'growth') return 'Growth'
  return 'Not set'
}

export function packLine(pack?: string | null): string {
  const builders = 'At most 2 builders (owner and scout). Project-only people are not counted.'
  if (pack === 'starter') return `Starter. The owner and two other people. ${builders}`
  if (pack === 'standard') return `Standard. $4,000 setup, then $700 a month. No people cap. ${builders}`
  if (pack === 'growth') return `Growth. $5,000 setup, then $1,000 a month. No people cap. ${builders}`
  return `Plan not set. No people cap until you pick Starter, Standard, or Growth. ${builders}`
}

export const STARTER_FULL =
  'Starter includes the owner and two other people. Standard is $4,000 setup, then $700 a month.'

const COUNTED = new Set(['owner', 'scout', 'team'])

export function countedPeople(rows: { role?: string; status?: string; email?: string }[]): number {
  const people = new Set<unknown>()
  for (const row of rows) {
    const role = String(row.role || '')
    const status = String(row.status || '')
    if (!COUNTED.has(role) || (status !== 'active' && status !== 'pending')) continue
    people.add(String(row.email || '').trim().toLowerCase() || row)
  }
  return people.size
}

/** Starter counts owner, scout, and team. Unset, Standard, and Growth do not. */
export function starterBlocksAdd(
  pack: string | null | undefined,
  people: { role?: string; status?: string; email?: string }[],
  role: string
): string | null {
  if (pack !== 'starter') return null
  if (!COUNTED.has(role)) return null
  if (countedPeople(people) >= 3) return STARTER_FULL
  return null
}
