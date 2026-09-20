import { basename } from 'node:path'
import { readTeamIdentity, readWatching, watchingHealth } from './agency-brain'
import { currentBrainFolder } from './brains'
import { hqAgentHealth } from './hq-sync'
import { paintHealth, type SyncHealth } from './sync-health-paint'

export type { SyncHealth } from './sync-health-paint'

export async function readSyncHealth(): Promise<SyncHealth> {
  const watching = readWatching()
  const folder = currentBrainFolder() || watching.brainPath || ''
  const hq = await hqAgentHealth(folder)
  if (hq.present) return paintHealth(hq, Boolean(watching.watching && folder === watching.brainPath))
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
