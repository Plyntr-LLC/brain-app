export type RailState = 'done' | 'live' | 'ask' | 'fail' | 'todo'

/**
 * What the right rail shows for a tab. Now and the files are always there; a Factory run adds Progress,
 * Team and Ship, a chat adds its Plan steps and Done so far.
 */
export type Activity = {
  /** A Factory run: Push in the rail publishes this run. */
  runId?: string
  now: { text: string; since?: number; tone: 'live' | 'ask' | 'done' | 'idle' }
  progress?: { label: string; state: RailState; note?: string }[]
  steps?: { title: string; state: RailState }[]
  team?: { role: string; who: string; state: RailState; note: string }[]
  log?: { at: number; text: string }[]
  files: { path: string; added?: number; deleted?: number; live?: boolean }[]
  /** Chat folds its touched files behind "Files · N"; a Factory run's changed files show. */
  filesFolded?: boolean
  ship?: { line: string; block: string | null; pushed: boolean }
}

/** Which rail the right sidebar shows: a Factory or Chat tab its own, any other tab the last chat's. Null: In use. */
export function railFor(tab: { id: string; type: string } | undefined, lastChatId: string, byTab: Record<string, Activity | null>): Activity | null {
  if (!tab) return null
  if (tab.type === 'factory' || tab.type === 'chat') return byTab[tab.id] || null
  return lastChatId ? byTab[lastChatId] || null : null
}
