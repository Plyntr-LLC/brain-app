import { homedir } from 'node:os'
import { join } from 'node:path'

export function grokLeaderSocket(): string {
  return join(homedir(), '.grok', 'leader-brain-app.sock')
}

export function grokAcpArgs(cwd: string, useLeader: boolean): string[] {
  const base = ['--cwd', cwd, 'agent', '--always-approve']
  if (useLeader) return [...base, '--leader', '--leader-socket', grokLeaderSocket(), 'stdio']
  return [...base, '--no-leader', 'stdio']
}

export function grokTuiArgs(cwd: string, resume: string | undefined, useLeader: boolean): string[] {
  const args = ['--cwd', cwd, '--always-approve']
  if (useLeader) args.push('--leader', '--leader-socket', grokLeaderSocket())
  else args.push('--no-leader')
  if (resume) args.push('--resume', resume)
  return args
}
