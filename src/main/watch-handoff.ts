import { activateWatching, detectApp, readTeamIdentity, readWatching } from './agency-brain'
import { currentBrainFolder } from './brains'
import { stopBrainSync } from './brain-sync'
import { getPendingJoin, pendingFromInvite, setPendingJoin } from './join-pending'
import { getAccount, loadAccount } from './session-token'

/** So Agency Brain can watch after email OTP (no setup-code pending join in memory). */
export function ensurePendingJoinForFolder(folder: string): void {
  if (getPendingJoin()?.memberToken) return
  const acct = getAccount() || loadAccount()
  const ident = readTeamIdentity(folder)
  const slug = String(ident?.slug || '').trim()
  if (!acct?.token || acct.token.startsWith('local:') || !slug) return
  setPendingJoin(
    pendingFromInvite({
      memberToken: acct.token,
      teamSlug: slug,
      teamName: ident?.name || slug,
      memberEmail: acct.email,
      memberName: acct.name || '',
      memberRole: acct.role || 'owner'
    })
  )
}

export async function handOffToAgencyBrain(): Promise<void> {
  const folder =
    currentBrainFolder() || readWatching().brainPath || loadAccount()?.folder || ''
  if (!folder || !detectApp().installed) return
  ensurePendingJoinForFolder(folder)
  const watched = await activateWatching(folder)
  if (watched.ok) stopBrainSync()
}
