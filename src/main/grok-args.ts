import { homedir } from 'node:os'
import { join } from 'node:path'

export function grokLeaderSocket(): string {
  return join(homedir(), '.grok', 'leader-brain-app.sock')
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
