import { readTeamMember } from './agency-brain'
import { brainRowForPath } from './brains'
import { seatForBrain } from './plyntr-seats'
import { getAccount } from './session-token'

/** Seat used by Brain.app file helpers. Empty when this Mac has no seat on the folder. */
export function roleForBrainWrite(folder: string): string {
  const row = brainRowForPath(folder)
  if (row?.brainId) {
    const seat = seatForBrain(row.brainId)
    if (seat?.role) return seat.role
  }
  const acct = getAccount()
  const email = String(acct?.appEmail || acct?.email || '').trim().toLowerCase()
  if (email) {
    const member = readTeamMember(folder, email)
    if (member?.role) return member.role
  }
  if (acct?.role && (!acct.folder || acct.folder === folder)) return acct.role
  return String(row?.role || '')
}
