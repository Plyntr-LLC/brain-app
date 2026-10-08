import { homedir } from 'node:os'
import { join } from 'node:path'

/** BRAIN_GROK_LEADER_SOCK lets a check run its own leader. makeLeader unlinks a socket it did not start, so a check on the default path would take over the running app's leader. */
export function grokLeaderSocket(): string {
  return process.env.BRAIN_GROK_LEADER_SOCK || join(homedir(), '.grok', 'leader-brain-app.sock')
}

export function grokAcpArgs(cwd: string, useLeader: boolean): string[] {
  const base = ['--cwd', cwd, '--trust', 'agent', '--always-approve']
  if (useLeader) return [...base, '--leader', '--leader-socket', grokLeaderSocket(), 'stdio']
  return [...base, '--no-leader', 'stdio']
}

export function grokTuiArgs(cwd: string, resume: string | undefined, useLeader: boolean): string[] {
  const args = ['--cwd', cwd, '--trust', '--always-approve']
  if (useLeader) args.push('--leader', '--leader-socket', grokLeaderSocket())
  else args.push('--no-leader')
  if (resume) args.push('--resume', resume)
  return args
}

/** Factory's own leader socket. Never Chat's, never the default leader.sock. */
export function grokFactorySocket(): string {
  return join(homedir(), '.grok', 'leader-brain-factory.sock')
}

/** Factory Grok ACP: cwd is the brain, real permission asks (no --always-approve), own leader. */
export function grokFactoryAcpArgs(cwd: string, useLeader: boolean): string[] {
  const base = ['--cwd', cwd, '--trust', 'agent']
  if (useLeader) return [...base, '--leader', '--leader-socket', grokFactorySocket(), 'stdio']
  return [...base, '--no-leader', 'stdio']
}

/**
 * Factory Cursor ACP (the grunt when Grok cannot run). Never Chat's reach: no --sandbox disabled,
 * no --add-dir $HOME, no --always-approve. Workspace is the brain; the work repo is the only extra dir.
 */
export function factoryCursorAcpArgs(brainPath: string, workRepo?: string): string[] {
  const args = ['--trust', '--workspace', brainPath]
  if (workRepo && workRepo !== brainPath) args.push('--add-dir', workRepo)
  return [...args, 'acp']
}
