import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { DOWNLOAD_AB, GITHUB_APP_INSTALL, GITHUB_NEW_ORG, type AiKind } from '../shared/contracts'
import * as ads2ai from './ads2ai'
import { detectApp, readWatching, writesAllowed } from './agency-brain'
import * as ai from './ai-cli'
import { browseDocs, listDir, matchExisting, readSafe, tree, underRoot } from './files'
import { cancelWarm, closeWarm, promptWarm, resetWarm, warmSession } from './warm'
import { contextBlurb, grokCli, listSlash, usageBlurb } from './slash'
import { getMemberToken, setMemberToken } from './session-token'

type RecentFolder = { path: string; name: string; watching?: boolean }

function recentsFile(): string {
  return join(app.getPath('userData'), 'recent-folders.json')
}

function loadRecents(): RecentFolder[] {
  try {
    const raw = JSON.parse(readFileSync(recentsFile(), 'utf8')) as RecentFolder[]
    if (!Array.isArray(raw)) return []
    return raw.filter((r) => r && typeof r.path === 'string' && existsSync(r.path))
  } catch {
    return []
  }
}

function saveRecent(folder: string): RecentFolder {
  const name = basename(folder)
  const next = [{ path: folder, name }, ...loadRecents().filter((r) => r.path !== folder)].slice(0, 8)
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(recentsFile(), JSON.stringify(next))
  return { path: folder, name }
}

/** Folder writes / new teams stay off unless BRAIN_APP_ALLOW_CREATE=1. Chat and login are live. */
export function dryRun(): boolean {
  return !writesAllowed()
}

export function registerStubIpc(): void {
  ipcMain.handle('env:get', () => {
    const watching = readWatching()
    return {
      dryRun: dryRun(),
      chatLive: true,
      existingBrain: watching
    }
  })

  ipcMain.handle('auth:resolveCode', async (_e, raw: string) => {
    const code = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    const res = await ads2ai.resolveInvite(code)
    setMemberToken(res.memberToken)
    const m = res.member || {}
    return {
      teamSlug: res.teamSlug,
      teamName: res.teamName || res.teamSlug,
      kind: res.kind || 'agency',
      repoUrl: res.repoUrl || '',
      member: {
        email: String(m.email || res.memberEmail || '').toLowerCase(),
        name: m.name || res.memberName || '',
        role: m.role || res.memberRole || 'team'
      }
    }
  })

  ipcMain.handle('auth:requestCode', async (_e, email: string) => ads2ai.requestCode(email))
  ipcMain.handle('auth:verify', async (_e, email: string, code: string) => {
    const res = await ads2ai.verifyCode(email, code)
    setMemberToken(res.token)
    const teams = (await ads2ai.myTeams(res.token)).teams || []
    return { ok: true, member: res.member, teams }
  })
  ipcMain.handle('auth:myTeams', async () => ads2ai.myTeams(getMemberToken()))

  ipcMain.handle('setup:createTeam', async (_e, name: string) => {
    if (!writesAllowed()) {
      return { skipped: true, reason: 'create-team blocked until BRAIN_APP_ALLOW_CREATE=1', name }
    }
    return ads2ai.createTeam(getMemberToken(), name)
  })
  ipcMain.handle('setup:lookupOrg', async (_e, login: string) => ads2ai.lookupGithubAccount(login))
  ipcMain.handle('setup:openCreateOrg', () => {
    shell.openExternal(GITHUB_NEW_ORG)
    return { ok: true }
  })
  ipcMain.handle('setup:openAppInstall', (_e, slug: string, org?: string) => {
    const url = org
      ? `${GITHUB_APP_INSTALL}?state=${encodeURIComponent(slug)}`
      : `${GITHUB_APP_INSTALL}?state=${encodeURIComponent(slug)}`
    shell.openExternal(url)
    return { ok: true, url }
  })
  ipcMain.handle('setup:pollInstall', async (_e, slug: string) => {
    if (!writesAllowed()) return { skipped: true, installed: false }
    return ads2ai.installStatus(slug)
  })
  ipcMain.handle('setup:ensureRepo', async (_e, slug: string) => {
    if (!writesAllowed()) return { skipped: true }
    return ads2ai.ensureBrainRepo(getMemberToken(), slug)
  })
  ipcMain.handle('setup:applyFolder', async () => {
    if (!writesAllowed()) {
      const w = readWatching()
      return { ok: true, skipped: true, brainPath: w.brainPath }
    }
    throw new Error('Clone into a new folder is not enabled on this machine yet')
  })

  ipcMain.handle('ab:detect', async () => detectApp())
  ipcMain.handle('ab:install', async () => {
    const d = detectApp()
    if (d.installed) return { ok: true, already: true, path: d.path }
    shell.openExternal(DOWNLOAD_AB)
    return { ok: true, openedDownload: true }
  })
  ipcMain.handle('ab:watching', async () => readWatching())

  ipcMain.handle('ai:detect', async () => ai.detect())
  ipcMain.handle('ai:login', async (_e, which: AiKind) => {
    const bin = ai.resolveBin(which)
    if (!bin) throw new Error(`${which} is not installed`)
    return { ok: true, which, bin, already: true }
  })

  ipcMain.handle('files:tree', async (_e, root?: string) => {
    const watching = readWatching()
    const cwd = root || watching.brainPath
    if (!cwd) return []
    return tree(cwd)
  })
  ipcMain.handle('files:list', async (_e, root: string, dir?: string) => listDir(root, dir || root))
  ipcMain.handle('files:match', async (_e, cwd: string, text: string) => matchExisting(cwd || '', text || ''))
  ipcMain.handle('files:read', async (_e, root: string, abs: string) => readSafe(root, abs))
  ipcMain.handle('files:browse', async (_e, root?: string) => {
    const watching = readWatching()
    return browseDocs(root || watching.brainPath || '')
  })
  ipcMain.handle('files:fileUrl', async (_e, root: string, abs: string) => {
    if (!underRoot(root, abs)) throw new Error('That file is not in this brain.')
    return 'file://' + abs
  })
  ipcMain.handle('files:recents', async () => {
    const w = readWatching()
    const rec = loadRecents()
    const watched =
      w.brainPath && existsSync(w.brainPath)
        ? [{ path: w.brainPath, name: basename(w.brainPath), watching: true as const }]
        : []
    const seen = new Set(watched.map((x) => x.path))
    return [...watched, ...rec.filter((r) => !seen.has(r.path))]
  })
  ipcMain.handle('files:remember', async (_e, folder: string) => {
    const abs = String(folder || '')
    if (!abs || !existsSync(abs)) throw new Error('That folder is not on this computer.')
    return saveRecent(abs)
  })
  ipcMain.handle('files:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Choose a folder to work in',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return saveRecent(r.filePaths[0])
  })

  ipcMain.handle(
    'chat:send',
    async (
      e,
      payload: {
        tabId: string
        text: string
        kind: AiKind
        cwd?: string
        sessionId?: string
        model?: string
        effort?: string
        agentMode?: string
        alwaysApprove?: boolean
        history?: { who: 'brain' | 'me'; text: string }[]
        system?: string
      }
    ) => {
      const watching = readWatching()
      const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
      if (!cwd) throw new Error('No brain folder on this computer to talk against')
      const wc = e.sender
      const onEvent = (ev: ai.StreamEvent) => {
        wc.send('chat:event', { tabId: payload.tabId, ...ev })
      }
      const kind = payload.kind || 'grok'
      const reply = await promptWarm({
        kind,
        tabId: payload.tabId,
        cwd,
        text: payload.text,
        model: payload.model,
        effort: payload.effort,
        agentMode: payload.agentMode,
        onEvent
      })
      return { reply }
    }
  )
  ipcMain.handle(
    'chat:warm',
    async (
      _e,
      payload: {
        tabId: string
        kind: AiKind
        cwd?: string
        model?: string
        effort?: string
        agentMode?: string
      }
    ) => {
      const watching = readWatching()
      const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
      if (!cwd) return { ok: false }
      const live = await warmSession({
        kind: payload.kind || 'grok',
        tabId: payload.tabId,
        cwd,
        model: payload.model,
        effort: payload.effort,
        agentMode: payload.agentMode
      })
      return { ok: true, ...live }
    }
  )
  ipcMain.handle(
    'chat:reset',
    async (
      _e,
      payload: { tabId: string; kind: AiKind; cwd?: string; model?: string; effort?: string }
    ) => {
      const watching = readWatching()
      const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
      if (!cwd) return { ok: false }
      await resetWarm({
        kind: payload.kind || 'grok',
        tabId: payload.tabId,
        cwd,
        model: payload.model,
        effort: payload.effort
      })
      return { ok: true }
    }
  )
  ipcMain.handle('chat:close', async (_e, tabId: string) => {
    closeWarm(tabId)
    ai.stopPrompt(tabId)
    return true
  })
  ipcMain.handle('chat:stop', async (_e, tabId: string) => cancelWarm(tabId) || ai.stopPrompt(tabId))
  ipcMain.handle('chat:needs', async () => ({ filled: {}, remaining: [] }))
  ipcMain.handle('slash:list', async (_e, cwd?: string, kind?: string) => {
    const watching = readWatching()
    return listSlash(cwd || watching.brainPath || process.cwd(), kind || 'grok')
  })
  ipcMain.handle('slash:context', async (_e, cwd?: string) => {
    const watching = readWatching()
    return contextBlurb(cwd || watching.brainPath || process.cwd())
  })
  ipcMain.handle('slash:usage', async (_e, cwd?: string, kind?: string) => {
    const watching = readWatching()
    return usageBlurb(cwd || watching.brainPath || process.cwd(), kind || 'grok')
  })
  ipcMain.handle('slash:cli', async (_e, args: string[], cwd?: string) => {
    const watching = readWatching()
    return grokCli(cwd || watching.brainPath || process.cwd(), args || [])
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
  })
}
