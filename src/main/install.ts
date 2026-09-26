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
import { brainRowForPath, currentBrainFolder } from './brains'
import { hasBrainMarker } from './clone'
import { handOffToAgencyBrain } from './watch-handoff'
import { loadAccount } from './session-token'
import { binEnv, detect as detectAi, resolveBin } from './ai-cli'
import { plyntrInstalled } from './plyntr-sync'
import { brainIdForSlug } from './plyntr-seats'
import { readSyncManifest, readSyncMode } from './sync-manifest'
import { plyntrGithubInstallReady } from './setup-folder'
import { absentIds, forcedPresent, pretendExit } from './setup-pretend'
import { setupTrace } from './setup-trace'
import type { AiKind } from '../shared/contracts'

export type NeedId = 'brew' | 'git' | 'ab' | 'cloudflared' | 'grok' | 'claude' | 'cursor' | 'gpt' | 'plyntr-github'

export type NeedItem = {
  id: NeedId
  label: string
  line: string
  present: boolean
  /** Empty when this install has no OS or vendor permission dialog. */
  warn: string
  /** Short line shown immediately before this install starts. */
  accept: string
  kind?: 'status' | 'install'
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

function brewPresent(): boolean {
  if (absentIds().has('brew')) return false
  return Boolean(brewBin())
}

export function gitPresent(): boolean {
  if (absentIds().has('git')) return false
  if (forcedPresent('git')) return true
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

export function cloudflaredPresent(): boolean {
  if (absentIds().has('cloudflared')) return false
  if (forcedPresent('cloudflared')) return true
  const extra = '/opt/homebrew/bin:/usr/local/bin'
  const env = { ...process.env, PATH: `${process.env.PATH || ''}:${extra}` }
  try {
    if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore', env }).status === 0) return true
  } catch {
    /* */
  }
  try {
    const r = spawnSync('which', ['cloudflared'], { encoding: 'utf8', env })
    return r.status === 0 && Boolean(String(r.stdout || '').trim())
  } catch {
    return false
  }
}

export async function listNeeds(picked?: AiKind): Promise<{ ready: boolean; watching: boolean; brainPath: string | null; items: NeedItem[] }> {
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
      : 'Apple opens a window called Install Command Line Developer Tools. Click Install, then Agree. It can take 10 minutes or more.',
    accept: win32 ? 'Click Yes if Windows asks to allow the Git installer.' : 'Click Install, then Agree, on Apple’s tools window.'
  })
  if (process.platform === 'darwin') {
    items.push({
      id: 'brew',
      label: 'Homebrew',
      line: 'Lets this Mac install the other tools.',
      present: brewPresent(),
      warn: 'Terminal opens (a window full of text). Press Return when it asks. Type your Mac password in the Brain password box. It takes 5 to 10 minutes. Ignore Next steps at the end.',
      accept: 'In Terminal, press Return if asked. Then type your Mac password in the Brain box.'
    })
  }
  items.push({
    id: 'ab',
    label: 'Agency Brain',
    line: 'Optional. Keeps the shared folder in sync. If it is not installed, this app syncs the folder itself.',
    present: detectApp().installed,
    warn: win32
      ? 'Windows may ask to allow the installer. Click Yes.'
      : 'The Agency Brain installer may open. Finish it in that window.',
    accept: 'Finish the Agency Brain installer if it opens.'
  })
  items.push({
    id: 'cloudflared',
    label: 'Cloudflare Tunnel',
    line: 'Lets you use Brain from your phone, even away from Wi-Fi.',
    present: cloudflaredPresent(),
    warn: win32
      ? 'Windows may ask to allow the installer. Click Yes.'
      : 'Terminal opens and installs it. This usually needs no password. Wait until Terminal says Done.',
    accept: win32 ? 'Click Yes if Windows asks to allow the installer.' : 'Wait until Terminal says Done. This usually needs no password.'
  })
  items.push({
    id: 'grok',
    label: 'Grok',
    line: 'Official xAI installer. You sign in with your own SuperGrok later.',
    present: ai.grok,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'claude',
    label: 'Claude',
    line: 'Official Anthropic installer. You sign in with your own Claude later.',
    present: ai.claude,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'cursor',
    label: 'Cursor',
    line: 'Official Cursor installer. You sign in with your own Cursor later.',
    present: ai.cursor,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  items.push({
    id: 'gpt',
    label: 'ChatGPT',
    line: 'Uses your ChatGPT account.',
    present: ai.gpt,
    warn: cliWin.warn,
    accept: cliWin.accept
  })
  const hasCli = ai.grok || ai.claude || ai.cursor || ai.gpt
  const folderPath = currentBrainFolder() || watchingInfo.brainPath || loadAccount()?.folder || null
  const folder = Boolean(folderPath)
  const mode = readSyncMode(folderPath || '')
  const finish = (
    ready: boolean,
    kept: NeedItem[],
    path: string | null
  ): { ready: boolean; watching: boolean; brainPath: string | null; items: NeedItem[] } => {
    const git = kept.find((item) => item.id === 'git')
    const tunnel = kept.find((item) => item.id === 'cloudflared')
    setupTrace({
      event: 'needs',
      ready,
      git: Boolean(git?.present),
      cloudflared: Boolean(tunnel?.present),
      picked: picked || '',
      mode: mode || ''
    })
    return { ready, watching, brainPath: path, items: kept }
  }
  if (mode === 'local') {
    const kept = items.filter((i) => i.id !== 'ab')
    const signed = picked ? Boolean(ai[picked] && cliSignedIn(picked)) : (ai.grok && cliSignedIn('grok')) || (ai.claude && cliSignedIn('claude')) || (ai.cursor && cliSignedIn('cursor')) || (ai.gpt && cliSignedIn('gpt'))
    const marker = Boolean(folderPath && hasBrainMarker(folderPath))
    return finish(Boolean(folderPath) && gitPresent() && cloudflaredPresent() && signed && marker, kept, folderPath)
  }
  if (mode === 'plyntr') {
    const kept = items.filter((i) => i.id !== 'ab')
    const manifest = folderPath ? readSyncManifest(folderPath) : null
    const repo = manifest?.ok ? manifest.manifest.repo : ''
    const row = folderPath ? brainRowForPath(folderPath) : null
    const brainId = row?.brainId || brainIdForSlug(row?.slug || '')
    let gh = false
    if (brainId && repo) {
      try {
        gh = plyntrGithubInstallReady(await plyntrInstalled(brainId, repo), repo)
      } catch {
        gh = false
      }
    }
    kept.push({
      id: 'plyntr-github',
      kind: 'status',
      label: 'GitHub app on this repo',
      line: 'Plyntr’s GitHub app, allowed on this brain only.',
      present: gh,
      warn: '',
      accept: ''
    })
    const signed = picked ? Boolean(ai[picked] && cliSignedIn(picked)) : (ai.grok && cliSignedIn('grok')) || (ai.claude && cliSignedIn('claude')) || (ai.cursor && cliSignedIn('cursor')) || (ai.gpt && cliSignedIn('gpt'))
    const marker = Boolean(folderPath && hasBrainMarker(folderPath))
    return finish(
      Boolean(folderPath) && gitPresent() && cloudflaredPresent() && signed && marker && gh,
      kept,
      folderPath
    )
  }
  const pickedPresent = picked ? Boolean(ai[picked]) : hasCli
  return finish(Boolean(folder && pickedPresent && gitPresent() && cloudflaredPresent()), items, folderPath)
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
    return {
      ok: true,
      detail: 'Agency Brain is already on this computer. This app writes its setup when the folder is on this computer.',
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
    return {
      ok: true,
      detail: 'Agency Brain is in Applications. This app writes its setup. Do not run its setup wizard.',
      wait: 'none'
    }
  }
  await shell.openPath(file)
  return { ok: true, detail: 'The Agency Brain installer is open. Finish it, then come back here. Skip its setup wizard.', wait: 'present' }
}

const TOOL_IDS: NeedId[] = ['brew', 'git', 'ab', 'cloudflared', 'grok', 'claude', 'cursor', 'gpt']

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

/** Open Terminal with a password dialog. Silent spawn cannot ask for a Mac password. */
async function openAskpassInstall(opts: { dialog: string; echo: string; runLine: string }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'brain-install-'))
  const file = join(dir, 'install.command')
  writeFileSync(
    file,
    [
      '#!/bin/bash',
      'set -e',
      'ASK=$(mktemp)',
      'cat > "$ASK" << \'EOF\'',
      '#!/bin/bash',
      `osascript -e 'display dialog "${opts.dialog}" default answer "" with hidden answer with title "Brain" buttons {"Cancel", "OK"} default button "OK"' -e 'text returned of result'`,
      'EOF',
      'chmod 700 "$ASK"',
      'export SUDO_ASKPASS="$ASK"',
      `echo ${JSON.stringify(opts.echo)}`,
      opts.runLine,
      'rm -f "$ASK"',
      'echo "Done. You can close this window."'
    ].join('\n'),
    { mode: 0o755 }
  )
  return shell.openPath(file)
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
  if (id === 'plyntr-github') {
    return { ok: false, detail: 'GitHub app on this repo is a status check, not an installer.', wait: 'none' }
  }
  const win32 = process.platform === 'win32'
  if (id === 'brew') {
    if (win32) return { ok: true, detail: 'Homebrew is a Mac tool. Skipped on Windows.', wait: 'none' }
    const stub = pretendExit('brew')
    if (brewPresent() && stub === null) {
      setupTrace({ event: 'install', id: 'brew', ok: true, presentAfter: true })
      return { ok: true, detail: 'Homebrew is already here.', wait: 'none' }
    }
    if (stub !== null) {
      const presentAfter = brewPresent()
      setupTrace({ event: 'install', id: 'brew', ok: presentAfter, presentAfter })
      return {
        ok: presentAfter,
        detail: presentAfter ? 'Homebrew is already here.' : 'Homebrew did not install.',
        wait: 'none'
      }
    }
    if (brewPresent()) return { ok: true, detail: 'Homebrew is already here.', wait: 'none' }
    const dir = mkdtempSync(join(tmpdir(), 'brain-brew-'))
    const file = join(dir, 'install-homebrew.command')
    writeFileSync(
      file,
      [
        '#!/bin/bash',
        'set -e',
        'ASK=$(mktemp)',
        'cat > "$ASK" << \'EOF\'',
        '#!/bin/bash',
        'osascript -e \'display dialog "Brain needs your Mac password to install Homebrew." default answer "" with hidden answer with title "Brain" buttons {"Cancel", "OK"} default button "OK"\' -e \'text returned of result\'',
        'EOF',
        'chmod 700 "$ASK"',
        'export SUDO_ASKPASS="$ASK"',
        'echo "Installing Homebrew. Press Return if Terminal asks. Type your Mac password in the Brain password box. It takes 5 to 10 minutes. Ignore Next steps at the end."',
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        'rm -f "$ASK"',
        'echo "Done. You can close this window."'
      ].join('\n'),
      { mode: 0o755 }
    )
    const opened = await shell.openPath(file)
    return {
      ok: !opened,
      detail:
        opened ||
        'Homebrew’s installer is in Terminal. A password window will open, with dots. Cancel stops it. We continue when it finishes.',
      wait: 'present'
    }
  }
  if (id === 'git') {
    const stub = pretendExit('git')
    if (gitPresent() && stub === null) {
      setupTrace({ event: 'install', id: 'git', ok: true, presentAfter: true })
      return { ok: true, detail: 'Git is already here.', wait: 'none' }
    }
    let detail = ''
    if (stub === null) {
      if (win32) {
        const r = await win('winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements')
        detail = r.out.slice(-800)
      } else {
        await run('/usr/bin/xcode-select', ['--install'])
      }
    }
    const presentAfter = gitPresent()
    setupTrace({ event: 'install', id: 'git', ok: presentAfter, presentAfter })
    return {
      ok: presentAfter,
      detail: presentAfter
        ? 'Git is already here.'
        : detail || (win32 ? 'Git did not install.' : 'Apple’s tools installer should be open. Click Install. We will continue when it finishes.'),
      wait: presentAfter ? 'none' : 'present'
    }
  }
  if (id === 'ab') {
    if (detectApp().installed) {
      await handOffToAgencyBrain()
      return {
        ok: true,
        detail: 'Agency Brain is installed. This app writes its setup when the folder is on this computer.',
        wait: 'none'
      }
    }
    const put = await installAgencyBrainApp()
    if (!put.ok) return put
    if (detectApp().installed) await handOffToAgencyBrain()
    return {
      ok: detectApp().installed,
      detail: detectApp().installed
        ? 'Agency Brain is installed. This app writes its setup when the folder is on this computer.'
        : put.detail || 'Agency Brain did not install. This app can still sync the folder.',
      wait: detectApp().installed ? 'none' : 'present'
    }
  }
  if (id === 'cloudflared') {
    const stub = pretendExit('cloudflared')
    if (cloudflaredPresent() && stub === null) {
      setupTrace({ event: 'install', id: 'cloudflared', ok: true, presentAfter: true })
      return { ok: true, detail: 'Cloudflare Tunnel is already here.', wait: 'none' }
    }
    let detail = ''
    if (stub === null) {
      if (win32) {
        const r = await win(
          'winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements'
        )
        detail = r.out.slice(-800)
      } else {
        const brew = brewBin()
        if (!brew) {
          setupTrace({ event: 'install', id: 'cloudflared', ok: false, presentAfter: false })
          return { ok: false, detail: 'Homebrew is not installed yet. Click Start setup to install it first.', wait: 'none' }
        }
        const opened = await openAskpassInstall({
          dialog: 'Brain needs your Mac password to install Cloudflare Tunnel.',
          echo: 'Installing Cloudflare Tunnel. This usually needs no password. Wait until Terminal says Done.',
          runLine: `${shQuote(brew)} install cloudflared`
        })
        const presentAfter = cloudflaredPresent()
        setupTrace({ event: 'install', id: 'cloudflared', ok: !opened, presentAfter })
        if (opened) return { ok: false, detail: opened, wait: 'none' }
        return {
          ok: true,
          detail:
            'Cloudflare Tunnel’s installer is in Terminal. This usually needs no password. Wait until Terminal says Done.',
          wait: 'present'
        }
      }
    }
    const presentAfter = cloudflaredPresent()
    setupTrace({ event: 'install', id: 'cloudflared', ok: presentAfter, presentAfter })
    return {
      ok: presentAfter,
      detail: presentAfter ? 'Cloudflare Tunnel is installed.' : detail || 'Cloudflare Tunnel did not install.',
      wait: 'none'
    }
  }
  if (id === 'grok' || id === 'claude' || id === 'cursor' || id === 'gpt') {
    const stub = pretendExit(id)
    if (stub !== null) {
      const presentAfter = Boolean(detectAi()[id])
      setupTrace({ event: 'install', id, ok: presentAfter, presentAfter })
      return {
        ok: presentAfter,
        detail: presentAfter ? 'Already here.' : 'That installer did not leave the CLI on this computer.',
        wait: 'none'
      }
    }
  }
  if (id === 'grok') {
    if (detectAi().grok) return { ok: true, detail: 'Grok is already here.', wait: 'none' }
    const r = win32
      ? await win('npm install -g @xai-official/grok')
      : await bash('curl -fsSL https://x.ai/cli/install.sh | bash')
    return { ok: detectAi().grok || r.code === 0, detail: r.out.slice(-800) || 'Grok installer finished.', wait: 'none' }
  }
  if (id === 'claude') {
    if (detectAi().claude) return { ok: true, detail: 'Claude is already here.', wait: 'none' }
    const r = win32
      ? await win('irm https://claude.ai/install.ps1 | iex')
      : await bash('curl -fsSL https://claude.ai/install.sh | bash')
    return { ok: detectAi().claude || r.code === 0, detail: r.out.slice(-800) || 'Claude installer finished.', wait: 'none' }
  }
  if (id === 'cursor') {
    if (detectAi().cursor) return { ok: true, detail: 'Cursor is already here.', wait: 'none' }
    const r = win32
      ? await win("irm 'https://cursor.com/install?win32=true' | iex")
      : await bash('curl https://cursor.com/install -fsS | bash')
    return { ok: detectAi().cursor || r.code === 0, detail: r.out.slice(-800) || 'Cursor installer finished.', wait: 'none' }
  }
  if (id === 'gpt') {
    if (detectAi().gpt) return { ok: true, detail: 'ChatGPT is already here.', wait: 'none' }
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
