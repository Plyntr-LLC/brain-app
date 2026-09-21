import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { bringAppFront } from './bring-front'
import { cliSignedIn } from './cli-auth'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { shell } from 'electron'
import { DOWNLOAD_AB } from '../shared/contracts'
import { detectApp, readWatching } from './agency-brain'
import { currentBrainFolder } from './brains'
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

export function listNeeds(): { ready: boolean; watching: boolean; brainPath: string | null; items: NeedItem[] } {
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
  const folderPath = currentBrainFolder() || watchingInfo.brainPath || loadAccount()?.folder || null
  const folder = Boolean(folderPath)
  return {
    ready: folder && hasCli && gitPresent(),
    watching,
    brainPath: folderPath,
    items
  }
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

async function findAbInstaller(): Promise<string | null> {
  try {
    const r = await fetch(DOWNLOAD_AB, { headers: { 'user-agent': 'Brain/0.1' } })
    if (!r.ok) return null
    const html = await r.text()
    const re = process.platform === 'win32' ? /https:[^"'<\s]+\.exe/gi : /https:[^"'<\s]+\.dmg/gi
    const hits = html.match(re) || []
    return hits[0] || null
  } catch {
    return null
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const r = await fetch(url, { headers: { 'user-agent': 'Brain/0.1' } })
  if (!r.ok || !r.body) throw new Error(`Could not download (${r.status})`)
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(dest))
}

async function installAgencyBrainApp(): Promise<InstallResult> {
  if (detectApp().installed) {
    await openAb()
    return {
      ok: true,
      detail: 'Agency Brain is already on this computer. Skip its setup wizard. Sign-in and GitHub stay in this app.',
      wait: 'none'
    }
  }
  const url = await findAbInstaller()
  if (!url) {
    return {
      ok: true,
      detail: 'This app already puts the brain folder on this computer and syncs it. Agency Brain is optional. We could not fetch its installer from here.',
      wait: 'none'
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'brain-ab-'))
  const file = join(dir, process.platform === 'win32' ? 'AgencyBrain.exe' : 'AgencyBrain.dmg')
  try {
    await downloadFile(url, file)
  } catch (e) {
    return { ok: false, detail: String((e as Error).message || e), wait: 'none' }
  }
  if (process.platform === 'darwin') {
    const mount = join(dir, 'mnt')
    await run('/usr/bin/hdiutil', ['attach', file, '-nobrowse', '-mountpoint', mount])
    const appPath = join(mount, 'Agency Brain.app')
    if (!existsSync(appPath)) {
      await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'])
      return { ok: false, detail: 'The installer did not contain Agency Brain.app.', wait: 'none' }
    }
    await run('/usr/bin/ditto', [appPath, '/Applications/Agency Brain.app'])
    await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'])
    await openAb()
    return {
      ok: true,
      detail: 'Agency Brain is in Applications. Skip its setup wizard. Sign-in stays in Brain.',
      wait: 'none'
    }
  }
  await shell.openPath(file)
  return { ok: true, detail: 'The Agency Brain installer is open. Finish it, then come back here. Skip its setup wizard.', wait: 'present' }
}

const TOOL_IDS: NeedId[] = ['brew', 'git', 'grok', 'claude', 'cursor', 'gpt']

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
export async function loginCli(kind: AiKind): Promise<{ ok: boolean; detail: string; marker?: string }> {
  const bin = resolveBin(kind)
  if (!bin) return { ok: false, detail: `${kind} is not installed on this computer.` }
  const args = LOGIN_ARGS[kind]
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'brain-login-'))
    const file = join(dir, `login-${kind}.command`)
    const marker = join(dir, 'done')
    writeFileSync(
      file,
      [
        '#!/bin/bash',
        'set -e',
        `echo "Sign in to ${kind}. A browser may open."`,
        `${shQuote(bin)} ${args.map(shQuote).join(' ')}`,
        `echo ok > ${shQuote(marker)}`,
        'echo "Done. You can close this window."'
      ].join('\n'),
      { mode: 0o755 }
    )
    const opened = await shell.openPath(file)
    return {
      ok: !opened,
      detail: opened || 'Sign-in opened. Finish it in the browser or Terminal, then continue.',
      marker
    }
  }
  const argList = args.map((a) => JSON.stringify(a)).join(',')
  await win(`Start-Process -FilePath ${JSON.stringify(bin)} -ArgumentList @(${argList})`)
  return { ok: true, detail: 'Sign-in started. Finish it, then continue.' }
}

/** Setup only. Wait until the CLI is signed in, then steal focus back. */
export async function loginCliUntilDone(kind: AiKind): Promise<{ ok: boolean; detail: string; signedIn?: boolean }> {
  if (cliSignedIn(kind)) {
    bringAppFront()
    return { ok: true, detail: 'Already signed in.', signedIn: true }
  }
  const opened = await loginCli(kind)
  if (!opened.ok) return opened
  const until = Date.now() + 180000
  while (Date.now() < until) {
    if (cliSignedIn(kind)) {
      bringAppFront()
      return { ok: true, detail: 'Signed in.', signedIn: true }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  bringAppFront()
  return {
    ok: true,
    signedIn: cliSignedIn(kind),
    detail: cliSignedIn(kind)
      ? 'Signed in.'
      : 'Sign-in is still open. Finish it, then continue here.'
  }
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
    const put = await installAgencyBrainApp()
    if (!put.ok) return put
    if (readWatching().brainPath) return { ...put, wait: 'none' }
    return {
      ok: true,
      detail: 'Opened Agency Brain. Sign in and pick the shared folder. We will continue when it is watching.',
      wait: 'watching'
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
