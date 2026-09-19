import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { binEnv, resolveBin } from './ai-cli'
import { grokAcpArgs, grokLeaderSocket, grokTuiArgs } from './grok-args'

export { grokAcpArgs, grokLeaderSocket, grokTuiArgs }

let leader: ChildProcess | null = null
let booting: Promise<boolean> | null = null

function waitForSock(path: string, ms: number): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(path)) return resolve(true)
      if (Date.now() - start > ms) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

export async function ensureGrokLeader(): Promise<boolean> {
  const sock = grokLeaderSocket()
  if (leader && leader.exitCode == null && existsSync(sock)) return true
  if (booting) return booting
  booting = startGrokLeader()
  try {
    return await booting
  } finally {
    booting = null
  }
}

async function startGrokLeader(): Promise<boolean> {
  const sock = grokLeaderSocket()
  if (leader && leader.exitCode == null && existsSync(sock)) return true
  const bin = resolveBin('grok')
  if (!bin) return false
  mkdirSync(join(homedir(), '.grok'), { recursive: true })
  if (existsSync(sock) && (!leader || leader.exitCode != null)) {
    try {
      unlinkSync(sock)
    } catch {
      /* stale */
    }
  }
  leader = spawn(bin, ['agent', 'leader', '--no-exit-on-disconnect', '--no-auto-update', '--leader-socket', sock], {
    env: binEnv(),
    stdio: 'ignore'
  })
  leader.on('exit', () => {
    leader = null
  })
  return waitForSock(sock, 8000)
}

export function grokLeaderLive(): boolean {
  return Boolean(leader && leader.exitCode == null && existsSync(grokLeaderSocket()))
}

export function killGrokLeader(): void {
  booting = null
  if (leader) {
    try {
      leader.kill('SIGTERM')
    } catch {
      /* */
    }
    leader = null
  }
  const sock = grokLeaderSocket()
  try {
    if (existsSync(sock)) unlinkSync(sock)
  } catch {
    /* */
  }
}
