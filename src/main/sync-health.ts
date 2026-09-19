import { readWatching } from './agency-brain'
import { hqAgentHealth } from './hq-sync'
import { paintHealth, type SyncHealth } from './sync-health-paint'

export type { SyncHealth } from './sync-health-paint'

export async function readSyncHealth(): Promise<SyncHealth> {
  const hq = await hqAgentHealth()
  return paintHealth(hq, Boolean(readWatching().watching))
}
