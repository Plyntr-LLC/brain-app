export const AB_OWNS_PLYNTR =
  'Agency Brain is already syncing this folder. Stop that sync in Agency Brain, then come back.'

export type WatcherChoice = 'none' | 'blocked' | 'activate' | 'start'

export function chooseWatcher(opts: {
  mode: 'plyntr' | 'agency-brain' | 'local' | null
  abInstalled: boolean
  abWatchingPath: boolean
  mini: boolean
}): WatcherChoice {
  if (opts.mini || opts.mode === 'local') return 'none'
  if (opts.mode === 'plyntr') return opts.abWatchingPath ? 'blocked' : 'start'
  if (opts.abInstalled) return 'activate'
  return 'start'
}

export function plyntrBlockedByAgency(mode: string | null, abWatching: boolean): boolean {
  return mode === 'plyntr' && abWatching
}

/** Valid plyntr manifest uses the worker git token. Every other folder stays on ads2ai. */
export function gitCredentialForMode(mode: string | null | undefined): 'plyntr' | 'ads2ai' {
  return mode === 'plyntr' ? 'plyntr' : 'ads2ai'
}
