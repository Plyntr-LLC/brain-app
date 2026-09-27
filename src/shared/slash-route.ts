/**
 * Where a Chat line goes when it is not an app command. `warm` is the warm CLI session behind the
 * Skin thread; `pty` is the CLI's own terminal behind Show terminal. A `/` line never goes to the
 * PTY: Brain answers it, runs it as a skill turn, or hands the leftover to the warm session.
 */
export type SlashRoute = 'warm' | 'pty'

export function routeLine(line: string, flags: { peel: boolean }): SlashRoute {
  if (line.trim().startsWith('/')) return 'warm'
  return flags.peel ? 'pty' : 'warm'
}
