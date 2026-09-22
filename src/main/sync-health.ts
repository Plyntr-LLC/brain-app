import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readTeamIdentity, readWatching, watchingHealth } from './agency-brain'
import { lastBrainSync, lastBrainSyncError } from './brain-sync'
import { currentBrainFolder } from './brains'
import { readSyncMode } from './sync-manifest'
import { AB_OWNS_PLYNTR, plyntrBlockedByAgency } from './watcher-choice'
import { hqAgentHealth } from './hq-sync'
import { paintHealth, type SyncHealth } from './sync-health-paint'

export type { SyncHealth } from './sync-health-paint'

export async function readSyncHealth(): Promise<SyncHealth> {
  const watching = readWatching()
  const folder = currentBrainFolder() || watching.brainPath || ''
  const hq = await hqAgentHealth(folder)
  if (hq.present) return paintHealth(hq, Boolean(watching.watching && folder === watching.brainPath))
  if (folder && watching.watching && folder === watching.brainPath) {
    if (plyntrBlockedByAgency(readSyncMode(folder), true)) {
      const ident = readTeamIdentity(folder)
      const err = lastBrainSyncError(folder) || AB_OWNS_PLYNTR
      return paintHealth(
        {
          present: true,
          label: ident?.name || basename(folder),
          lastSync: '',
          offline: false,
          error: err,
          openOnly: false
        },
        false
      )
    }
    return paintHealth(watchingHealth(), true)
  }
  if (folder && existsSync(join(folder, '.git'))) {
    const ident = readTeamIdentity(folder)
    const last = lastBrainSync(folder)
    const err = lastBrainSyncError(folder)
    return paintHealth(
      {
        present: true,
        label: ident?.name || basename(folder),
        lastSync: last,
        offline: false,
        error: err,
        openOnly: false
      },
      false
    )
  }
  if (folder && folder !== watching.brainPath) {
    const ident = readTeamIdentity(folder)
    return paintHealth(
      {
        present: true,
        label: ident?.name || basename(folder),
        lastSync: '',
        offline: false,
        error: '',
        openOnly: true
      },
      false
    )
  }
  return paintHealth(watchingHealth(), Boolean(watching.watching))
}
