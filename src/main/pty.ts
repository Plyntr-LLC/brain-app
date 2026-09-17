import { ipcMain, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { AiKind } from '../shared/contracts'
import { extraPath, resolveBin } from './ai-cli'

type Sess = { proc: IPty; sender: WebContents }

const sessions = new Map<string, Sess>()

function env(): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') e[k] = v
  e.HOME = homedir()
  e.TERM = 'xterm-256color'
  e.COLORTERM = 'truecolor'
  e.PATH = `${extraPath()}${delimiter}${e.PATH || ''}`
  return e
}

export function registerPtyIpc(): void {
  ipcMain.handle(
    'pty:create',
    (e, opts: { id: string; kind: AiKind; cwd: string; cols: number; rows: number; sessionId?: string }) => {
      const existing = sessions.get(opts.id)
      if (existing) return { ok: true, reused: true }
      const bin = resolveBin(opts.kind)
      if (!bin) throw new Error(`${opts.kind} is not installed`)
      let proc: IPty
      try {
        proc = pty.spawn(bin, spawnArgs(opts.kind, opts.cwd || homedir(), opts.sessionId), {
          name: 'xterm-256color',
          cols: Math.max(40, opts.cols || 80),
          rows: Math.max(12, opts.rows || 24),
          cwd: opts.cwd || homedir(),
          env: env()
        })
      } catch (err) {
        throw new Error(`Could not start ${opts.kind}: ${String((err as Error).message || err)}`)
      }
      const sender = e.sender
      proc.onData((data) => {
        try {
          if (!sender.isDestroyed()) sender.send('pty:data', { id: opts.id, data })
        } catch {
          /* renderer gone */
        }
      })
      proc.onExit(({ exitCode }) => {
        sessions.delete(opts.id)
        try {
          if (!sender.isDestroyed()) sender.send('pty:exit', { id: opts.id, exitCode })
        } catch {
          /* renderer gone */
        }
      })
      sessions.set(opts.id, { proc, sender })
      return { ok: true, bin }
    }
  )

  ipcMain.handle('pty:write', (_e, id: string, data: string) => {
    const s = sessions.get(id)
    if (!s) return
    try {
      s.proc.write(data)
    } catch {
      /* EPIPE: grok already exited */
    }
  })

  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => {
    const s = sessions.get(id)
    if (!s) return
    try {
      s.proc.resize(Math.max(20, cols), Math.max(8, rows))
    } catch {
      /* EPIPE */
    }
  })

  ipcMain.handle('pty:kill', (_e, id: string) => {
    const s = sessions.get(id)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    sessions.delete(id)
  })
}

function spawnArgs(kind: AiKind, cwd: string, sessionId?: string): string[] {
  if (kind === 'grok') {
    const a = ['--no-alt-screen']
    if (sessionId) a.unshift('--resume', sessionId)
    return a
  }
  if (kind === 'cursor') return ['--trust', '--workspace', cwd]
  if (kind === 'claude') return []
  if (kind === 'gpt') return []
  return []
}

export function killAllPtys(): void {
  for (const [id, s] of sessions) {
    try {
      s.proc.kill()
    } catch {
      /* */
    }
    sessions.delete(id)
  }
}
