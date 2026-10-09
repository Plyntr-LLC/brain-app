import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { binEnv, resolveBin } from './ai-cli'
import { grokAcpArgs, grokFactoryAcpArgs, grokFactorySocket, grokLeaderSocket, grokTuiArgs } from './grok-args'
import { chatEnv } from './chat-env'

export { grokAcpArgs, grokFactoryAcpArgs, grokFactorySocket, grokLeaderSocket, grokTuiArgs }

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

type Leader = { ensure: () => Promise<boolean>; live: () => boolean; kill: () => void }

/** One Grok leader process on its own socket. Chat and Factory each get one. */
export function makeLeader(socketFn: () => string, envFn: () => NodeJS.ProcessEnv = () => binEnv()): Leader {
  let leader: ChildProcess | null = null
  let booting: Promise<boolean> | null = null

  async function start(): Promise<boolean> {
    const sock = socketFn()
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
    const child = spawn(bin, ['agent', 'leader', '--no-exit-on-disconnect', '--no-auto-update', '--leader-socket', sock], {
      env: envFn(),
      stdio: 'ignore'
    })
    leader = child
    child.on('exit', () => {
      if (leader === child) leader = null
    })
    return waitForSock(sock, 8000)
  }

  return {
    async ensure() {
      const sock = socketFn()
      if (leader && leader.exitCode == null && existsSync(sock)) return true
      if (booting) return booting
      booting = start()
      try {
        return await booting
      } finally {
        booting = null
      }
    },
    live() {
      return Boolean(leader && leader.exitCode == null && existsSync(socketFn()))
    },
    kill() {
      booting = null
      if (leader) {
        try {
          leader.kill('SIGTERM')
        } catch {
          /* */
        }
        leader = null
      }
      const sock = socketFn()
      try {
        if (existsSync(sock)) unlinkSync(sock)
      } catch {
        /* */
      }
    }
  }
}

// The chat leader runs every chat Grok session and Show terminal's Grok TUI, so it gets the chat env.
const chatLeader = makeLeader(grokLeaderSocket, () => chatEnv())
let factoryEnvFn: () => NodeJS.ProcessEnv = () => binEnv()
const factoryLeader = makeLeader(grokFactorySocket, () => factoryEnvFn())

export function ensureGrokLeader(): Promise<boolean> {
  return chatLeader.ensure()
}

export function grokLeaderLive(): boolean {
  return chatLeader.live()
}

export function killGrokLeader(): void {
  chatLeader.kill()
}

/** Factory leader env: shims first, no ANTHROPIC_API_KEY. acp-session sets it before the first boot. */
export function setGrokFactoryLeaderEnv(fn: () => NodeJS.ProcessEnv): void {
  factoryEnvFn = fn
}

export function ensureGrokFactoryLeader(): Promise<boolean> {
  return factoryLeader.ensure()
}

export function grokFactoryLeaderLive(): boolean {
  return factoryLeader.live()
}

export function killGrokFactoryLeader(): void {
  factoryLeader.kill()
}
