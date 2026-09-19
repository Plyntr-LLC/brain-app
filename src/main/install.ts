import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { DOWNLOAD_AB } from '../shared/contracts'
import { detectApp, readWatching } from './agency-brain'
import { loadAccount } from './session-token'
import { binEnv, detect as detectAi, resolveBin } from './ai-cli'
import type { AiKind } from '../shared/contracts'

export type NeedId = 'brew' | 'git' | 'ab' | 'grok' | 'claude' | 'cursor' | 'gpt'

export type NeedItem = {
  id: NeedId
  label: string
  line: string
  present: boolean
  /** Empty when this install has no OS or vendor permission dialog. */
  warn: string
  /** Short line shown immediately before this install starts. */
  accept: string
}

export type InstallResult = {
  ok: boolean
  detail: string
  wait: 'none' | 'present' | 'watching'
}

function brewBin(): string | null {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(p)) return p
  }
  return null
}

function gitPresent(): boolean {
  if (process.platform === 'win32') {
    const env = binEnv()
    const dirs = String(env.PATH || '').split(';')
    for (const d of dirs) {
      if (existsSync(join(d, 'git.exe')) || existsSync(join(d, 'git'))) return true
    }
    return false
  }
  try {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' })
    return r.status === 0 && Boolean(String(r.stdout || '').trim())
  } catch {
    return Boolean(brewBin() && existsSync('/opt/homebrew/bin/git'))
  }
}

export function listNeeds(): { ready: boolean; watching: boolean; items: NeedItem[] } {
  const ai = detectAi()
  const watchingInfo = readWatching()
  const watching = Boolean(watchingInfo.brainPath)
  const win32 = process.platform === 'win32'
  const cliWin =
    win32
      ? {
          warn: 'Windows may ask to allow this installer. Click Yes.',
          accept: 'Click Yes if Windows asks to allow the installer.'
        }
      : { warn: '', accept: '' }
  const items: NeedItem[] = []
  items.push({
    id: 'git',
    label: 'Git',
    line: win32 ? 'This app needs Git to sync the shared folder. We install it with winget.' : 'Usually already on a Mac. If not, Apple’s tools installer opens.',
    present: gitPresent(),
    warn: win32
      ? 'Windows may ask to allow the Git installer. Click Yes.'
      : 'Apple will open a window called Install Command Line Developer Tools. Click Install and wait until it finishes.',
    accept: win32 ? 'Click Yes if Windows asks to allow the Git installer.' : 'Click Install on Apple’s tools window.'
  })
  if (process.platform === 'darwin') {
    items.push({
      id: 'brew',
      label: 'Homebrew',
      line: 'Lets this Mac install the other tools.',
      present: Boolean(brewBin()),
      warn: 'A Terminal window will open. macOS will ask for your computer password so Homebrew can install. Type it (you will not see dots) and press Return.',
      accept: 'Type your Mac password in Terminal, then press Return.'
    })
  }
  items.push({
    id: 'grok',
    label: 'Grok CLI',
    line: 'Official xAI installer. You sign in with your own SuperGrok later.',
    present: ai.grok,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'claude',
    label: 'Claude Code',
    line: 'Official Anthropic installer. You sign in with your own Claude later.',
    present: ai.claude,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'cursor',
    label: 'Cursor CLI',
    line: 'Official Cursor installer (cursor-agent). You sign in with your own Cursor later.',
    present: ai.cursor,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'gpt',
    label: 'Codex CLI',
    line: 'ChatGPT’s command-line tool. Needs Homebrew or npm already on this computer.',
    present: ai.gpt,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  const hasCli = ai.grok || ai.claude || ai.cursor || ai.gpt
  const folder = Boolean(watchingInfo.brainPath) || Boolean(loadAccount()?.folder)
  return { ready: folder && hasCli, watching, items }
}

function run(cmd: string, args: string[], timeoutMs = 8 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: binEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const t = setTimeout(() => {
      child.kill()
      resolve({ code: 1, out: out + '\nThat install took too long.' })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code: code ?? 1, out })
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: 1, out: String(e.message || e) })
    })
  })
}

function bash(script: string): Promise<{ code: number; out: string }> {
  return run('/bin/bash', ['-lc', script])
}

function win(script: string): Promise<{ code: number; out: string }> {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

async function openAb(): Promise<void> {
  const d = detectApp()
  if (!d.installed) return
  if (process.platform === 'darwin') {
    await run('/usr/bin/open', ['-a', 'Agency Brain'])
    return
  }
  await shell.openPath(d.path)
}

const TOOL_IDS: NeedId[] = ['brew', 'git', 'ab', 'grok', 'claude', 'cursor', 'gpt']

export function isNeedId(id: string): id is NeedId {
  return (TOOL_IDS as string[]).includes(id)
}

const LOGIN_ARGS: Record<AiKind, string[]> = {
  grok: ['login'],
  claude: ['auth', 'login'],
  cursor: ['login'],
  gpt: ['login']
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Open this CLI’s own sign-in. Browser or Terminal may appear. */
export async function loginCli(kind: AiKind): Promise<{ ok: boolean; detail: string }> {
  const bin = resolveBin(kind)
  if (!bin) return { ok: false, detail: `${kind} is not installed on this computer.` }
  const args = LOGIN_ARGS[kind]
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'brain-login-'))
    const file = join(dir, `login-${kind}.command`)
    writeFileSync(
      file,
      [
        '#!/bin/bash',
        'set -e',
        `echo "Sign in to ${kind}. A browser may open."`,
        `${shQuote(bin)} ${args.map(shQuote).join(' ')}`,
        'echo "Done. You can close this window."'
      ].join('\n'),
      { mode: 0o755 }
    )
    const opened = await shell.openPath(file)
    return {
      ok: !opened,
      detail: opened || 'Sign-in opened. Finish it in the browser or Terminal, then continue.'
    }
  }
  const argList = args.map((a) => JSON.stringify(a)).join(',')
  await win(`Start-Process -FilePath ${JSON.stringify(bin)} -ArgumentList @(${argList})`)
  return { ok: true, detail: 'Sign-in started. Finish it, then continue.' }
}

export async function installNeed(id: NeedId): Promise<InstallResult> {
  const win32 = process.platform === 'win32'
  if (id === 'brew') {
    if (win32) return { ok: true, detail: 'Homebrew is a Mac tool. Skipped on Windows.', wait: 'none' }
    if (brewBin()) return { ok: true, detail: 'Homebrew is already here.', wait: 'none' }
    const dir = mkdtempSync(join(tmpdir(), 'brain-brew-'))
    const file = join(dir, 'install-homebrew.command')
    writeFileSync(
      file,
      [
        '#!/bin/bash',
        'set -e',
        'echo "Homebrew installer. Type your Mac password when asked (you will not see dots), then press Return."',
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        'echo "Done. You can close this window."'
      ].join('\n'),
      { mode: 0o755 }
    )
    const opened = await shell.openPath(file)
    return {
      ok: !opened,
      detail:
        opened ||
        'Homebrew’s installer is in Terminal. Type your Mac password there. We will continue when it finishes.',
      wait: 'present'
    }
  }
  if (id === 'git') {
    if (gitPresent()) return { ok: true, detail: 'Git is already here.', wait: 'none' }
    if (win32) {
      const r = await win('winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements')
      return { ok: r.code === 0 || gitPresent(), detail: r.out.slice(-800), wait: gitPresent() ? 'none' : 'present' }
    }
    const r = await run('/usr/bin/xcode-select', ['--install'])
    if (gitPresent()) return { ok: true, detail: 'Git is already here.', wait: 'none' }
    return {
      ok: r.code === 0 || r.code === 1,
      detail: 'Apple’s tools installer should be open. Click Install. We will continue when it finishes.',
      wait: 'present'
    }
  }
  if (id === 'ab') {
    if (detectApp().installed) {
      await openAb()
      if (readWatching().brainPath) {
        return { ok: true, detail: 'Agency Brain is already watching a folder.', wait: 'none' }
      }
      return {
        ok: true,
        detail: 'Opened Agency Brain. Sign in and pick the shared folder. We will continue when it is watching.',
        wait: 'watching'
      }
    }
    await shell.openExternal(DOWNLOAD_AB)
    return {
      ok: true,
      detail: 'Opened the Agency Brain download. Install it, then open it. We will continue when it is on this computer.',
      wait: 'present'
    }
  }
  if (id === 'grok') {
    if (detectAi().grok) return { ok: true, detail: 'Grok CLI is already here.', wait: 'none' }
    const r = win32
      ? await win('npm install -g @xai-official/grok')
      : await bash('curl -fsSL https://x.ai/cli/install.sh | bash')
    return { ok: detectAi().grok || r.code === 0, detail: r.out.slice(-800) || 'Grok installer finished.', wait: 'none' }
  }
  if (id === 'claude') {
    if (detectAi().claude) return { ok: true, detail: 'Claude Code is already here.', wait: 'none' }
    const r = win32
      ? await win('irm https://claude.ai/install.ps1 | iex')
      : await bash('curl -fsSL https://claude.ai/install.sh | bash')
    return { ok: detectAi().claude || r.code === 0, detail: r.out.slice(-800) || 'Claude installer finished.', wait: 'none' }
  }
  if (id === 'cursor') {
    if (detectAi().cursor) return { ok: true, detail: 'Cursor CLI is already here.', wait: 'none' }
    const r = win32
      ? await win("irm 'https://cursor.com/install?win32=true' | iex")
      : await bash('curl https://cursor.com/install -fsS | bash')
    return { ok: detectAi().cursor || r.code === 0, detail: r.out.slice(-800) || 'Cursor installer finished.', wait: 'none' }
  }
  if (id === 'gpt') {
    if (detectAi().gpt) return { ok: true, detail: 'Codex CLI is already here.', wait: 'none' }
    const brew = brewBin()
    if (brew && !win32) {
      const r = await run(brew, ['install', 'codex'])
      return { ok: detectAi().gpt || r.code === 0, detail: r.out.slice(-800), wait: 'none' }
    }
    const r = win32
      ? await win('npm install -g @openai/codex')
      : await bash('npm install -g @openai/codex')
    return { ok: detectAi().gpt || r.code === 0, detail: r.out.slice(-800) || 'Codex installer finished.', wait: 'none' }
  }
  return { ok: false, detail: 'Unknown tool.', wait: 'none' }
}

export function afterInstallHint(): { watching: boolean; hasCli: boolean } {
  const ai = detectAi()
  return {
    watching: Boolean(readWatching().brainPath),
    hasCli: ai.grok || ai.claude || ai.cursor || ai.gpt
  }
}
