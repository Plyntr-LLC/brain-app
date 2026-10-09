import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { app } from 'electron'
import { binEnv } from './ai-cli'

/**
 * The env every AI chat process in Brain runs with: BRAIN_CHAT=1, and a shims folder first on PATH whose
 * `open` keeps web pages out of Chrome (open-guard.cjs decides). Plain shell tabs, Factory and Desk do not get it.
 * Some CLIs (Grok) run commands in a zsh login shell that rebuilds PATH from the person's startup files, so the
 * env also points ZDOTDIR at Brain's own startup files: each sources the person's file, then puts the shims first.
 */
const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** open-guard.cjs: in Resources when packed, the source file in `npm run dev`. */
export function guardScriptPath(where: { resourcesPath?: string; appPath?: string } = { resourcesPath: process.resourcesPath, appPath: app.getAppPath() }): string {
  const packed = where.resourcesPath ? join(where.resourcesPath, 'open-guard.cjs') : ''
  if (packed && existsSync(packed)) return packed
  return join(where.appPath || process.cwd(), 'src', 'main', 'open-guard.cjs')
}

let shims: string | null = null

/** Writes the shims once per run, so they always point at this Brain's executable and guard script. */
export function ensureChatShims(guard = guardScriptPath()): string {
  if (shims) return shims
  const dir = join(app.getPath('userData'), 'chat-shims')
  mkdirSync(dir, { recursive: true })
  const open = join(dir, 'open')
  writeFileSync(open, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shq(process.execPath)} ${shq(guard)} "$@"\n`)
  chmodSync(open, 0o755)
  const zdot = join(dir, 'zdot')
  mkdirSync(zdot, { recursive: true })
  for (const f of ZSH_FILES) {
    writeFileSync(
      join(zdot, f),
      `# Brain chat: the person's own ${f}, then the chat shims first on PATH.\n` +
        `[[ -f "\${BRAIN_REAL_ZDOTDIR:-$HOME}/${f}" ]] && ZDOTDIR="\${BRAIN_REAL_ZDOTDIR:-$HOME}" source "\${BRAIN_REAL_ZDOTDIR:-$HOME}/${f}"\n` +
        `path=(${shq(dir)} \${path:#${shq(dir)}})\nexport PATH\n`
    )
  }
  shims = dir
  return dir
}

/** Adds the chat marker and shims to an env built elsewhere (binEnv, ptyEnv). */
export function asChatEnv<T extends Record<string, string | undefined>>(env: T): T {
  const next = { ...env, BRAIN_CHAT: '1' } as Record<string, string | undefined>
  if (process.platform !== 'win32') {
    const dir = ensureChatShims()
    next.PATH = `${dir}${delimiter}${env.PATH || ''}`
    next.BRAIN_REAL_ZDOTDIR = env.BRAIN_REAL_ZDOTDIR || env.ZDOTDIR || env.HOME || ''
    next.ZDOTDIR = join(dir, 'zdot')
  }
  return next as T
}

export function chatEnv(): NodeJS.ProcessEnv {
  return asChatEnv(binEnv())
}
