import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { DOWNLOAD_AB } from '../shared/contracts'
import { detectApp, readWatching } from './agency-brain'
import { binEnv, detect as detectAi } from './ai-cli'

export type NeedId = 'brew' | 'git' | 'ab' | 'grok' | 'claude' | 'cursor' | 'gpt'

export type NeedItem = {
  id: NeedId
  label: string
  line: string
  present: boolean
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
  const ab = detectApp()
  const watching = Boolean(readWatching().brainPath)
  const items: NeedItem[] = []
  if (process.platform === 'darwin') {
    items.push({
      id: 'brew',
      label: 'Homebrew',
      line: 'Lets this Mac install other tools. macOS will ask for your password.',
      present: Boolean(brewBin())
    })
  }
  items.push({
    id: 'git',
    label: 'Git',
    line: process.platform === 'win32' ? 'Agency Brain needs Git to sync. We install it with winget.' : 'Usually already on a Mac. If not, Apple’s tools installer opens.',
    present: gitPresent()
  })
  items.push({
    id: 'ab',
    label: 'Agency Brain',
    line: 'Mike’s app. It watches the shared folder. We open the official download; you drop it in Applications (or run the Windows installer).',
    present: ab.installed
  })
  items.push({
    id: 'grok',
    label: 'Grok CLI',
    line: 'Official xAI installer. You sign in with your own SuperGrok later.',
    present: ai.grok
  })
  items.push({
    id: 'claude',
    label: 'Claude Code',
    line: 'Official Anthropic installer. You sign in with your own Claude later.',
    present: ai.claude
  })
  items.push({
    id: 'cursor',
    label: 'Cursor CLI',
    line: 'Official Cursor installer (cursor-agent). You sign in with your own Cursor later.',
    present: ai.cursor
  })
  items.push({
    id: 'gpt',
    label: 'Codex CLI',
    line: 'ChatGPT’s command-line tool. Needs Homebrew or npm already on this computer.',
    present: ai.gpt
  })
  const hasCli = ai.grok || ai.claude || ai.cursor || ai.gpt
  return { ready: watching && hasCli, watching, items }
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

export async function installNeed(id: NeedId): Promise<{ ok: boolean; detail: string }> {
  const win32 = process.platform === 'win32'
  if (id === 'brew') {
    if (win32) return { ok: true, detail: 'Homebrew is a Mac tool. Skipped on Windows.' }
    if (brewBin()) return { ok: true, detail: 'Homebrew is already here.' }
    const script =
      'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    const r = await run('/usr/bin/osascript', [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(script)}`
    ])
    return {
      ok: r.code === 0,
      detail: 'Homebrew’s installer is in Terminal. Type your Mac password there. Then Recheck.'
    }
  }
  if (id === 'git') {
    if (gitPresent()) return { ok: true, detail: 'Git is already here.' }
    if (win32) {
      const r = await win('winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements')
      return { ok: r.code === 0 || gitPresent(), detail: r.out.slice(-800) }
    }
    const r = await run('/usr/bin/xcode-select', ['--install'])
    return { ok: gitPresent() || r.code === 0, detail: 'Apple’s tools installer should be open. Finish it, then Continue.' }
  }
  if (id === 'ab') {
    if (detectApp().installed) return { ok: true, detail: 'Agency Brain is already here.' }
    await shell.openExternal(DOWNLOAD_AB)
    return { ok: true, detail: 'Opened the Agency Brain download. Install it, then come back.' }
  }
  if (id === 'grok') {
    if (detectAi().grok) return { ok: true, detail: 'Grok CLI is already here.' }
    const r = win32
      ? await win('npm install -g @xai-official/grok')
      : await bash('curl -fsSL https://x.ai/cli/install.sh | bash')
    return { ok: detectAi().grok || r.code === 0, detail: r.out.slice(-800) || 'Grok installer finished.' }
  }
  if (id === 'claude') {
    if (detectAi().claude) return { ok: true, detail: 'Claude Code is already here.' }
    const r = win32
      ? await win('irm https://claude.ai/install.ps1 | iex')
      : await bash('curl -fsSL https://claude.ai/install.sh | bash')
    return { ok: detectAi().claude || r.code === 0, detail: r.out.slice(-800) || 'Claude installer finished.' }
  }
  if (id === 'cursor') {
    if (detectAi().cursor) return { ok: true, detail: 'Cursor CLI is already here.' }
    const r = win32
      ? await win("irm 'https://cursor.com/install?win32=true' | iex")
      : await bash('curl https://cursor.com/install -fsS | bash')
    return { ok: detectAi().cursor || r.code === 0, detail: r.out.slice(-800) || 'Cursor installer finished.' }
  }
  if (id === 'gpt') {
    if (detectAi().gpt) return { ok: true, detail: 'Codex CLI is already here.' }
    const brew = brewBin()
    if (brew && !win32) {
      const r = await run(brew, ['install', 'codex'])
      return { ok: detectAi().gpt || r.code === 0, detail: r.out.slice(-800) }
    }
    const r = win32
      ? await win('npm install -g @openai/codex')
      : await bash('npm install -g @openai/codex')
    return { ok: detectAi().gpt || r.code === 0, detail: r.out.slice(-800) || 'Codex installer finished.' }
  }
  return { ok: false, detail: 'Unknown tool.' }
}

export function afterInstallHint(): { watching: boolean; hasCli: boolean } {
  const ai = detectAi()
  return {
    watching: Boolean(readWatching().brainPath),
    hasCli: ai.grok || ai.claude || ai.cursor || ai.gpt
  }
}
