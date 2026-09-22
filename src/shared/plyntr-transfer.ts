export type PlyntrListedSeat = {
  email: string
  role?: string
  status: string
  plyntrScout?: boolean
  bootstrap?: boolean
}

function normRole(role?: string): string {
  return String(role || '').trim().toLowerCase()
}

function normEmail(email?: string): string {
  return String(email || '').trim().toLowerCase()
}

/**
 * Role of the seat token on this Mac.
 * roles.json and the agency roster must not turn a scout token into owner.
 */
export function plyntrSessionRole(opts: { seatRole?: string; accountRole?: string; rowRole?: string }): string {
  const seat = normRole(opts.seatRole)
  if (seat === 'owner' || seat === 'scout' || seat === 'team' || seat === 'project') return seat
  const account = normRole(opts.accountRole)
  if (account === 'scout' || account === 'team' || account === 'project') return account
  // rowRole is roles.json or the agency roster. It does not grant a Plyntr owner seat.
  return ''
}

/** Worker row for this email. A plyntrScout flag wins over a roster owner row for the same address. */
export function listedRoleForSeat(
  local: { email: string },
  seats: PlyntrListedSeat[]
): { role: string; bootstrap: boolean } | null {
  const email = normEmail(local.email)
  if (!email) return null
  const mine = seats.filter((s) => s.status === 'active' && normEmail(s.email) === email)
  const scout = mine.find((s) => s.plyntrScout || normRole(s.role) === 'scout')
  const picked = scout || mine.find((s) => normRole(s.role) === 'owner') || null
  if (!picked) return null
  return { role: scout ? 'scout' : normRole(picked.role), bootstrap: Boolean(picked.bootstrap) }
}

/** Remove Plyntr scout is only for a redeemed owner seat, and not for the scout's own email. */
export function canOfferPlyntrTransfer(opts: {
  accountRole?: string
  seatRole?: string
  sessionEmail?: string
  seats: PlyntrListedSeat[]
}): boolean {
  const account = normRole(opts.accountRole)
  const seat = normRole(opts.seatRole)
  if (account === 'scout' || seat === 'scout') return false
  if (seat !== 'owner') return false
  const session = normEmail(opts.sessionEmail)
  const listed = session ? listedRoleForSeat({ email: session }, opts.seats) : null
  if (listed && listed.role !== 'owner') return false
  const scout = opts.seats.find((s) => s.plyntrScout && s.status === 'active')
  if (!scout) return false
  const scoutEmail = normEmail(scout.email)
  if (!scoutEmail) return false
  if (session && session === scoutEmail) return false
  return true
}

const OWNER_ONLY = 'Only the owner can remove the Plyntr scout.'

/** POST /v1/brains/:id/transfer uses the owner seat token. A scout token is not sent. */
export function transferUsesOwnerToken(opts: {
  seatRole?: string
  seatEmail?: string
  seatToken?: string
  seats?: PlyntrListedSeat[] | null
}): { ok: true; token: string } | { ok: false; detail: string } {
  const token = String(opts.seatToken || '')
  if (!token) return { ok: false, detail: OWNER_ONLY }
  const email = normEmail(opts.seatEmail)
  let role = normRole(opts.seatRole)
  if (opts.seats) {
    const listed = listedRoleForSeat({ email }, opts.seats)
    if (listed) role = listed.role
    const scout = opts.seats.find((s) => s.plyntrScout && s.status === 'active')
    if (scout && normEmail(scout.email) === email) return { ok: false, detail: OWNER_ONLY }
  }
  if (role !== 'owner') return { ok: false, detail: OWNER_ONLY }
  return { ok: true, token }
}
