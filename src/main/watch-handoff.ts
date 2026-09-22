import { activateWatching, detectApp, readTeamIdentity, readWatching } from './agency-brain'
import { currentBrainFolder } from './brains'
import { setBrainSyncBlockedReason, stopBrainSync } from './brain-sync'
import { isHqMiniFolder } from './hq-sync'
import { getPendingJoin, pendingFromInvite, setPendingJoin } from './join-pending'
import { getAccount, loadAccount } from './session-token'
import { readSyncMode } from './sync-manifest'
import { AB_OWNS_PLYNTR, chooseWatcher } from './watcher-choice'

/** So Agency Brain can watch after email OTP (no setup-code pending join in memory). */
export function ensurePendingJoinForFolder(folder: string): void {
  if (getPendingJoin()?.memberToken) return
  const acct = getAccount() || loadAccount()
  const ident = readTeamIdentity(folder)
  const slug = String(ident?.slug || '').trim()
  if (!acct?.token || acct.token.startsWith('local:') || acct.token.startsWith('login:') || acct.source === 'plyntr' || !slug) return
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
  const watching = readWatching()
  const choice = chooseWatcher({
    mode: readSyncMode(folder),
    abInstalled: true,
    abWatchingPath: Boolean(watching.watching && watching.brainPath === folder),
    mini: isHqMiniFolder(folder)
  })
  if (choice === 'blocked') {
    setBrainSyncBlockedReason(folder, AB_OWNS_PLYNTR)
    return
  }
  if (choice !== 'activate') return
  ensurePendingJoinForFolder(folder)
  const watched = await activateWatching(folder)
  if (watched.ok) stopBrainSync()
}
