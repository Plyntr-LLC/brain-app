import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { asSeat, GITHUB_APP_INSTALL, GITHUB_NEW_ORG, type AiKind } from '../shared/contracts'
import { openInApp } from './in-app-browse'
import * as ads2ai from './ads2ai'
import { homedir } from 'node:os'
import {
  detectApp,
  listProjectFolders,
  readTeamMember,
  readTeamRoster,
  readWatching,
  upsertTeamMember
} from './agency-brain'
import { cloneBrain } from './clone'
import { startBrainSync, stopBrainSync } from './brain-sync'
import {
  addCompany,
  addProjectSeat,
  existingProjectSeat,
  isHqMiniFolder,
  joinProject,
  openExistingSeat,
  hqRepoFromFolder,
  ownerBindUntilReady,
  ownerLogin,
  ownerStatus,
  requestHqCode,
  revokeProjectSeat
} from './hq-sync'
import { readSyncHealth } from './sync-health'
import { isJoeSuperAdmin } from './super-admin'
import { classifyLogin, type LoginVia } from './login-route'
import { installNeed, isNeedId, listNeeds, loginCli } from './install'
import * as ai from './ai-cli'
import { asAttachBuf, inspectAttach, stashBytes } from './attach'
import { browseDocs, listDir, matchExisting, readSafe, tree, underRoot } from './files'
import { loadChats, saveChats, type SavedChats } from './persist'
import { cancelWarm, closeWarm, forkSession, promptWarm, resetWarm, resumeSession, warmSession } from './warm'
import { captureEvent, skinHint } from './skin/capture'
import { justUpdated } from './update'
import { contextBlurb, grokCli, grokTranscript, listGrokSessions, listSlash, usageBlurb } from './slash'
import { clearAccount, getAccount, getMemberToken, loadAccount, saveAccount } from './session-token'
import {
  getSettings,
  loadClients,
  loadTeam,
  saveClients,
  saveTeam,
  setSuperAdmin,
  type ClientBrain,
  type TeamPerson
} from './settings-store'

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

/** Dev only (`npm run dev`). Packed Brain creates teams and clones. */
export function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

export function registerStubIpc(): void {
  loadAccount()
  ipcMain.handle('env:get', async () => {
    const watching = readWatching()
    const seat = await existingProjectSeat().catch(() => null)
    return {
      dryRun: dryRun(),
      chatLive: true,
      existingBrain: watching,
      justUpdated: justUpdated(),
      projectSeat: seat
        ? { folder: seat.folder, label: seat.label, lastSync: seat.lastSync }
        : null
    }
  })

  function bridgeFile(): string {
    return join(app.getPath('userData'), 'bridge.json')
  }
  ipcMain.handle('bridge:load', () => {
    try {
      return JSON.parse(readFileSync(bridgeFile(), 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle('bridge:save', (_e, data: unknown) => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(bridgeFile(), JSON.stringify(data || {}))
    return { ok: true }
  })
  ipcMain.handle('bridge:openUrl', (_e, raw: string) => {
    const url = String(raw || '')
    if (!/^https?:\/\//i.test(url)) throw new Error('That is not a web address.')
    if (/^https:\/\/(github\.com|ads2ai\.com)\//i.test(url)) return openInApp(url, 'Setup')
    shell.openExternal(url)
    return { ok: true }
  })
  ipcMain.handle('settings:get', () => {
    const watching = readWatching()
    const file = getSettings()
    const acct = getAccount() || loadAccount()
    const email = String(acct?.email || '').toLowerCase()
    const folder = watching.brainPath || acct?.folder || null
    const roster = readTeamRoster(folder)
    const member = readTeamMember(folder, email)
    const displayName = String(acct?.name || member?.name || '').trim() || (email ? email.split('@')[0] : '')
    const brainName = String(roster?.name || watching.teamName || watching.name || '').trim()
    const plyntrBrain = (roster?.slug || watching.teamSlug) === 'plyntr'
    const superAdmin = isJoeSuperAdmin(acct, file)
    const hqMini = acct?.source === 'hq-sync' || isHqMiniFolder(acct?.folder)
    return {
      superAdmin,
      email,
      name: displayName,
      role: String(acct?.role || member?.role || ''),
      signedIn: Boolean(acct?.email),
      watching: hqMini ? true : watching.watching,
      brainPath: hqMini ? acct?.folder || folder : folder,
      brainName: brainName || (folder ? folder.split(/[/\\]/).filter(Boolean).pop() : '') || '',
      brainSlug: roster?.slug || watching.teamSlug,
      plyntrBrain,
      source: acct?.source || ''
    }
  })
  ipcMain.handle('settings:setSuper', (_e, on: boolean) => setSuperAdmin(Boolean(on)))
  ipcMain.handle('settings:team', () => loadTeam())
  ipcMain.handle('settings:roster', () => {
    const watching = readWatching()
    const acct = getAccount()
    const folder = watching.brainPath || acct?.folder || null
    const roster = readTeamRoster(folder)
    return (roster?.members || []).map((m) => ({
      name: m.name,
      email: m.email,
      role: asSeat(m.role),
      brain: (m.brains && m.brains[0]) || 'hq',
      brains: m.brains || []
    }))
  })
  ipcMain.handle('settings:saveTeam', (_e, people: TeamPerson[]) => saveTeam(people))
  ipcMain.handle('settings:clients', () => loadClients())
  ipcMain.handle('settings:saveClients', (_e, clients: ClientBrain[]) => saveClients(clients))
  ipcMain.handle('settings:projects', (_e, folder?: string) => {
    const watching = readWatching()
    const acct = getAccount()
    return listProjectFolders(folder || watching.brainPath || acct?.folder || null)
  })
  ipcMain.handle('settings:addTeammate', async (_e, person: TeamPerson) => {
    const watching = readWatching()
    const acct = getAccount()
    const folder = watching.brainPath || acct?.folder || null
    const email = String(person.email || '').trim().toLowerCase()
    const brains = Array.isArray(person.brains)
      ? person.brains.map((b) => String(b || '').trim()).filter(Boolean)
      : person.brain && person.brain !== 'hq'
        ? [person.brain]
        : []
    const row: TeamPerson = {
      name: String(person.name || '').trim(),
      email,
      role: asSeat(person.role),
      brain: brains[0] || 'hq',
      client: String(person.client || '').trim(),
      brains
    }
    if (row.role === 'project') {
      const added = await addProjectSeat({ name: row.name, email, roots: brains })
      return { people: loadTeam(), roster: { ok: added.ok, detail: added.detail } }
    }
    const people = loadTeam()
    const rest = people.filter((p) => !(p.email === email && (p.client || '') === (row.client || '')))
    const saved = saveTeam([...rest, row])
    const wrote = upsertTeamMember(folder, {
      email,
      name: row.name,
      role: row.role,
      brains
    })
    if (folder && !isHqMiniFolder(folder)) startBrainSync(folder)
    return { people: saved, roster: wrote }
  })

  ipcMain.handle('auth:resolveCode', async (_e, raw: string) => {
    const code = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    const res = await ads2ai.resolveInvite(code)
    const m = res.member || {}
    const email = String(m.email || res.memberEmail || '').toLowerCase()
    saveAccount({
      email,
      name: String(m.name || res.memberName || ''),
      token: res.memberToken
    })
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

  ipcMain.handle('auth:requestCode', async (_e, email: string) => {
    const key = String(email || '').trim().toLowerCase()
    const kind = await classifyLogin(key)
    if (kind === 'hq-sync') {
      await requestHqCode(key)
      return { ok: true, via: 'hq-sync' as LoginVia }
    }
    try {
      await ads2ai.requestCode(key)
      return { ok: true, via: 'ads2ai' as LoginVia }
    } catch (err) {
      if (kind === 'ads2ai') throw err
      await requestHqCode(key)
      return { ok: true, via: 'hq-sync' as LoginVia }
    }
  })
  ipcMain.handle('auth:verify', async (_e, email: string, code: string, viaRaw?: LoginVia) => {
    const key = String(email || '').trim().toLowerCase()
    const classified = await classifyLogin(key)
    const via = viaRaw || (classified === 'unknown' ? null : classified)

    async function asProject() {
      const joined = await joinProject({ email: key, code })
      saveAccount({
        email: joined.email,
        name: joined.name,
        token: `local:${joined.email}`,
        role: 'project',
        source: 'hq-sync',
        folder: joined.brainPath,
        brains: joined.roots
      })
      saveRecent(joined.brainPath)
      return {
        ok: true,
        via: 'hq-sync' as const,
        member: { email: joined.email, name: joined.name, role: 'project' },
        teams: [] as { slug: string; name: string; role: string; kind?: string }[],
        brainPath: joined.brainPath,
        teamName: joined.teamName,
        role: 'project' as const
      }
    }

    async function asAgency() {
      const res = await ads2ai.verifyCode(key, code)
      saveAccount({
        email: String(res.member.email || key).toLowerCase(),
        name: res.member.name || '',
        token: res.token,
        source: 'ads2ai'
      })
      const teams = (await ads2ai.myTeams(res.token)).teams || []
      return { ok: true, via: 'ads2ai' as const, member: res.member, teams, role: '' }
    }

    if (via === 'hq-sync') {
      try {
        return await asProject()
      } catch {
        return asAgency()
      }
    }
    try {
      return await asAgency()
    } catch {
      return asProject()
    }
  })
  ipcMain.handle('auth:session', () => {
    const acct = getAccount() || loadAccount()
    if (!acct) return { signedIn: false, email: '', name: '', role: '', folder: '', source: '' }
    return {
      signedIn: true,
      email: acct.email,
      name: acct.name || '',
      role: acct.role || '',
      folder: acct.folder || '',
      source: acct.source || ''
    }
  })
  ipcMain.handle('auth:logout', () => {
    stopBrainSync()
    clearAccount()
    return { ok: true }
  })
  ipcMain.handle('auth:joinFolder', async (_e, emailRaw: string, folderRaw?: string) => {
    const email = String(emailRaw || '').trim().toLowerCase()
    if (!email.includes('@')) throw new Error('Type your work email first.')
    let folder = String(folderRaw || '').trim()
    if (!folder) {
      const watching = readWatching()
      folder = watching.brainPath || ''
    }
    if (!folder) {
      const pick = await dialog.showOpenDialog({
        title: 'Choose the shared brain folder',
        properties: ['openDirectory']
      })
      if (pick.canceled || !pick.filePaths[0]) throw new Error('Pick the shared folder the owner gave you.')
      folder = pick.filePaths[0]
    }
    const roster = readTeamRoster(folder)
    if (!roster) throw new Error('That folder is not a team brain (no .team-config/roles.json).')
    const member = readTeamMember(folder, email)
    if (!member) {
      throw new Error(`${email} is not on the ${roster.name} team list. Ask the owner to add you in .team-config/roles.json.`)
    }
    saveAccount({
      email: member.email,
      name: member.name,
      token: `local:${member.email}`,
      role: member.role,
      source: 'team-file',
      folder,
      brains: member.brains || []
    })
    saveRecent(folder)
    if (!isHqMiniFolder(folder)) startBrainSync(folder)
    return {
      ok: true,
      email: member.email,
      name: member.name,
      role: member.role,
      brainPath: folder,
      teamName: roster.name,
      teamSlug: roster.slug
    }
  })
  ipcMain.handle('auth:myTeams', async () => ads2ai.myTeams(getMemberToken()))
  ipcMain.handle('hqSync:requestCode', (_e, email: string) => requestHqCode(email))
  ipcMain.handle('hqSync:join', async (_e, opts: { email: string; code: string; folder?: string }) => {
    const joined = await joinProject(opts)
    saveAccount({
      email: joined.email,
      name: joined.name,
      token: `local:${joined.email}`,
      role: 'project',
      source: 'hq-sync',
      folder: joined.brainPath,
      brains: joined.roots
    })
    saveRecent(joined.brainPath)
    return joined
  })
  ipcMain.handle('hqSync:openExisting', async () => {
    const joined = await openExistingSeat()
    saveAccount({
      email: joined.email,
      name: joined.name,
      token: `local:${joined.email}`,
      role: 'project',
      source: 'hq-sync',
      folder: joined.brainPath,
      brains: joined.roots
    })
    saveRecent(joined.brainPath)
    return joined
  })
  ipcMain.handle('hqSync:ownerRequestCode', (_e, email: string) => requestHqCode(email))
  ipcMain.handle('hqSync:ownerLogin', (_e, opts: { email: string; code: string }) => ownerLogin(opts))
  ipcMain.handle('hqSync:ownerStatus', () => ownerStatus())
  ipcMain.handle('hqSync:watchedRepo', () => hqRepoFromFolder(readWatching().brainPath || ''))
  ipcMain.handle('hqSync:bind', (_e, hqRepo: string) =>
    ownerBindUntilReady(hqRepo, {
      openInstall: (url) => {
        openInApp(url, 'Authorize Brain Bridge')
      }
    })
  )
  ipcMain.handle('hqSync:revoke', (_e, seatId: string) => revokeProjectSeat(seatId))
  ipcMain.handle('hqSync:health', () => readSyncHealth())
  ipcMain.handle(
    'hqSync:addCompany',
    (
      _e,
      opts: { name: string; email: string; owner_name: string; role?: string }
    ) => addCompany(opts)
  )

  ipcMain.handle('setup:createTeam', async (_e, name: string) => {
    if (dryRun()) {
      return { skipped: true, reason: 'create-team skipped in dry-run', name }
    }
    return ads2ai.createTeam(getMemberToken(), name)
  })
  ipcMain.handle('setup:lookupOrg', async (_e, login: string) => ads2ai.lookupGithubAccount(login))
  ipcMain.handle('setup:openCreateOrg', () => openInApp(GITHUB_NEW_ORG, 'Create a GitHub organization'))
  ipcMain.handle('setup:openAppInstall', async (_e, slug: string, org?: string) => {
    const state = encodeURIComponent(slug)
    let url = `${GITHUB_APP_INSTALL}?state=${state}`
    const login = String(org || '').trim()
    if (login) {
      const look = await ads2ai.lookupGithubAccount(login)
      if (look.ok && look.id) {
        url = `${GITHUB_APP_INSTALL}/permissions?target_id=${look.id}&state=${state}`
      }
    }
    openInApp(url, 'Install Agency Brain Sync')
    return { ok: true, url }
  })
  ipcMain.handle('setup:pollInstall', (_e, slug: string) => ads2ai.installStatus(slug))
  ipcMain.handle('setup:ensureRepo', async (_e, slug: string) => {
    if (dryRun()) return { skipped: true }
    return ads2ai.ensureBrainRepo(getMemberToken(), slug)
  })
  ipcMain.handle('setup:applyFolder', async (_e, opts?: { teamSlug?: string; dest?: string }) => {
    const watching = readWatching()
    if (watching.brainPath) {
      startBrainSync(watching.brainPath)
      return { ok: true, skipped: true, brainPath: watching.brainPath, reason: 'already-on-this-computer' }
    }
    const acct = getAccount() || loadAccount()
    if (acct?.folder && existsSync(acct.folder)) {
      startBrainSync(acct.folder)
      return { ok: true, brainPath: acct.folder }
    }
    if (process.env.BRAIN_APP_DRY_RUN === '1') {
      return { ok: true, skipped: true, reason: 'dry-run', brainPath: null }
    }
    const slug = String(opts?.teamSlug || '').trim()
    if (!slug) throw new Error('No team to clone. Sign in first, or open the shared folder.')
    const git = await ads2ai.gitToken(getMemberToken(), slug)
    const rawUrl = String(git.cloneUrl || git.url || git.repoUrl || '')
    if (!rawUrl) throw new Error('Could not get a clone address for that brain.')
    const token = String(git.token || '')
    const cloneUrl = token && rawUrl.startsWith('https://') && !rawUrl.includes('@')
      ? rawUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
      : rawUrl
    const dest = String(opts?.dest || '').trim() || join(homedir(), 'Projects', `${slug}-brain`)
    const cloned = await cloneBrain({
      cloneUrl,
      dest,
      email: acct?.email || '',
      name: acct?.name || ''
    })
    if (!cloned.ok) throw new Error(cloned.detail || 'Clone failed.')
    if (acct) saveAccount({ ...acct, folder: cloned.dest })
    saveRecent(cloned.dest)
    startBrainSync(cloned.dest)
    return { ok: true, brainPath: cloned.dest, detail: cloned.detail }
  })

  ipcMain.handle('ab:detect', async () => detectApp())
  ipcMain.handle('ab:install', async () => installNeed('ab'))
  ipcMain.handle('ab:watching', async () => readWatching())

  ipcMain.handle('setup:status', async () => listNeeds())
  ipcMain.handle('setup:install', async (_e, id: string) => {
    if (!isNeedId(id)) return { ok: false, detail: 'Unknown tool.', wait: 'none' }
    return installNeed(id)
  })

  ipcMain.handle('ai:detect', async () => ai.detect())
  ipcMain.handle('ai:login', async (_e, which: AiKind) => loginCli(which))

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
  ipcMain.handle('files:stash', async (_e, name: string, bytes: unknown, mime: string) => {
    const buf = asAttachBuf(bytes)
    if (!buf.length) throw new Error('That file was empty.')
    if (buf.length > 20 * 1024 * 1024) throw new Error('That file is larger than 20 MB.')
    return stashBytes(String(name || 'drop'), buf, String(mime || ''))
  })
  ipcMain.handle('files:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return { files: [], skipped: [] as string[] }
    const files: { path: string; name: string; mime: string }[] = []
    const skipped: string[] = []
    for (const p of r.filePaths) {
      const hit = inspectAttach(p)
      if (hit.file) files.push(hit.file)
      else if (hit.skip) skipped.push(hit.skip)
    }
    return { files, skipped }
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
        attachments?: { path: string; name: string; mime: string }[]
      }
    ) => {
      const watching = readWatching()
      const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
      if (!cwd) throw new Error('No brain folder on this computer to talk against')
      const wc = e.sender
      const onEvent = (ev: ai.StreamEvent) => {
        const cli = payload.kind || 'grok'
        captureEvent({
          cli,
          sessionId: payload.sessionId || payload.tabId,
          ev,
          transport:
            payload.kind === 'claude' ? 'stream-json' : payload.kind === 'gpt' ? 'app-server' : 'acp'
        })
        const hint = skinHint({ cli, ev })
        wc.send('chat:event', {
          tabId: payload.tabId,
          ...ev,
          fingerprint: hint.fingerprint,
          skinLabel: hint.label
        })
      }
      const kind = payload.kind || 'grok'
      try {
        const reply = await promptWarm({
          kind,
          tabId: payload.tabId,
          cwd,
          text: payload.text,
          model: payload.model,
          effort: payload.effort,
          agentMode: payload.agentMode,
          alwaysApprove: payload.alwaysApprove,
          attachments: payload.attachments,
          onEvent
        })
        return { reply }
      } catch (err) {
        const msg = String((err as Error).message || err)
        onEvent({ kind: 'error', data: msg })
        onEvent({ kind: 'done' })
        return { reply: '' }
      }
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
        resumeId?: string
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
        agentMode: payload.agentMode,
        resumeId: payload.resumeId
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
      const live = await resetWarm({
        kind: payload.kind || 'grok',
        tabId: payload.tabId,
        cwd,
        model: payload.model,
        effort: payload.effort
      })
      return { ok: true, ...live }
    }
  )
  ipcMain.handle('chat:close', async (_e, tabId: string) => {
    closeWarm(tabId)
    ai.stopPrompt(tabId)
    return true
  })
  ipcMain.handle('chat:stop', async (_e, tabId: string) => cancelWarm(tabId) || ai.stopPrompt(tabId))
  ipcMain.handle(
    'chat:resume',
    async (_e, payload: { tabId: string; kind: AiKind; cwd?: string; sessionId: string }) => {
      const watching = readWatching()
      const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
      if (!cwd) return { ok: false, error: 'No folder.' }
      try {
        const live = await resumeSession({
          tabId: payload.tabId,
          kind: payload.kind || 'grok',
          cwd,
          sessionId: payload.sessionId
        })
        const messages = payload.kind === 'grok' ? grokTranscript(cwd, payload.sessionId) : []
        return { ok: true, sessionId: live.sessionId || payload.sessionId, messages }
      } catch (e) {
        return { ok: false, error: String((e as Error).message || e) }
      }
    }
  )
  ipcMain.handle('chat:fork', async (_e, payload: { tabId: string; kind: AiKind; cwd?: string }) => {
    const watching = readWatching()
    const cwd = payload.cwd && payload.cwd.length ? payload.cwd : watching.brainPath
    if (!cwd) return { ok: false, error: 'No folder.' }
    try {
      const sessionId = await forkSession({ tabId: payload.tabId, kind: payload.kind || 'grok', cwd })
      return { ok: true, sessionId }
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) }
    }
  })
  ipcMain.handle('chat:loadState', async (_e, cwd?: string) => loadChats(cwd))
  ipcMain.handle('chat:saveState', async (_e, state: SavedChats) => {
    saveChats(state)
    return true
  })
  ipcMain.on('chat:saveStateSync', (e, state: SavedChats) => {
    try {
      saveChats(state)
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
  ipcMain.handle('chat:needs', async () => ({ filled: {}, remaining: [] }))
  ipcMain.handle('slash:list', async (_e, cwd?: string, kind?: string) => {
    const watching = readWatching()
    return listSlash(cwd || watching.brainPath || process.cwd(), kind || 'grok')
  })
  ipcMain.handle('slash:context', async (_e, cwd?: string) => {
    const watching = readWatching()
    return contextBlurb(cwd || watching.brainPath || process.cwd())
  })
  ipcMain.handle('slash:sessions', async (_e, cwd?: string) => {
    const watching = readWatching()
    return listGrokSessions(cwd || watching.brainPath || process.cwd())
  })
  ipcMain.handle('files:saveText', async (e, suggested: string, text: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Export chat',
      defaultPath: String(suggested || 'chat.md'),
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, String(text || ''))
    return r.filePath
  })
  ipcMain.handle('slash:usage', async (_e, cwd?: string, kind?: string, sessionId?: string) => {
    const watching = readWatching()
    return usageBlurb(cwd || watching.brainPath || process.cwd(), kind || 'grok', sessionId)
  })
  ipcMain.handle('slash:cli', async (_e, args: string[], cwd?: string) => {
    const watching = readWatching()
    return grokCli(cwd || watching.brainPath || process.cwd(), args || [])
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
  })
}
