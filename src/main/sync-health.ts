import { readWatching, watchingHealth } from './agency-brain'
import { hqAgentHealth } from './hq-sync'
import { paintHealth, type SyncHealth } from './sync-health-paint'

export type { SyncHealth } from './sync-health-paint'

export async function readSyncHealth(): Promise<SyncHealth> {
  const watching = readWatching()
  const hq = await hqAgentHealth(watching.brainPath || '')
  if (hq.present) return paintHealth(hq, Boolean(watching.watching))
  return paintHealth(watchingHealth(), Boolean(watching.watching))
}
