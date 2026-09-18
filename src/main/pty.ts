import { ipcMain, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import pty from 'node-pty'
import type { IPty } from 'node-pty'
import { extraPath } from './ai-cli'

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
    (e, opts: { id: string; cwd: string; cols: number; rows: number; shell?: boolean }) => {
      const existing = sessions.get(opts.id)
      if (existing) {
        existing.sender = e.sender
        try {
          existing.proc.resize(Math.max(20, opts.cols || 80), Math.max(8, opts.rows || 24))
          return { ok: true, reused: true }
        } catch {
          sessions.delete(opts.id)
          try {
            existing.proc.kill()
          } catch {
            /* */
          }
        }
      }
      if (!opts.shell) throw new Error('Terminal tabs are a shell, not an AI CLI.')
      const bin =
        process.platform === 'win32'
          ? process.env.COMSPEC || 'powershell.exe'
          : process.env.SHELL || '/bin/zsh'
      const args = process.platform === 'win32' ? [] : ['-l']
      let proc: IPty
      try {
        proc = pty.spawn(bin, args, {
          name: 'xterm-256color',
          cols: Math.max(20, opts.cols || 80),
          rows: Math.max(8, opts.rows || 24),
          cwd: opts.cwd || homedir(),
          env: env()
        })
      } catch (err) {
        throw new Error(`Could not start the terminal: ${String((err as Error).message || err)}`)
      }
      sessions.set(opts.id, { proc, sender: e.sender })
      proc.onData((data) => {
        const live = sessions.get(opts.id)
        if (!live || live.proc !== proc) return
        try {
          if (!live.sender.isDestroyed()) live.sender.send('pty:data', { id: opts.id, data })
        } catch {
          /* renderer gone */
        }
      })
      proc.onExit(({ exitCode }) => {
        const live = sessions.get(opts.id)
        if (live && live.proc !== proc) return
        sessions.delete(opts.id)
        try {
          if (live && !live.sender.isDestroyed()) live.sender.send('pty:exit', { id: opts.id, exitCode })
        } catch {
          /* renderer gone */
        }
      })
      return { ok: true, bin }
    }
  )

  ipcMain.handle('pty:write', (_e, id: string, data: string) => {
    const s = sessions.get(id)
    if (!s) return
    try {
      s.proc.write(data)
    } catch {
      /* EPIPE: shell already exited */
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
    sessions.delete(id)
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    try {
      if (!s.sender.isDestroyed()) s.sender.send('pty:exit', { id, exitCode: 0 })
    } catch {
      /* */
    }
  })
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
