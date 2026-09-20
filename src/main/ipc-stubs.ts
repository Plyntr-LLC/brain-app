import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { asSeat, GITHUB_NEW_ORG, type AiKind } from '../shared/contracts'
import { openInApp } from './in-app-browse'
import * as ads2ai from './ads2ai'
import { homedir } from 'node:os'
import {
  activateWatching,
  detectApp,
  listProjectFolders,
  memberTokenForTeam,
  plyntrOwnerProfile,
  readTeamIdentity,
  readTeamMember,
  readTeamRoster,
  readWatching,
  upsertTeamMember
} from './agency-brain'
import { helloName } from './login-identity'
import { cloneBrain } from './clone'
import { githubAppInstallUrl, githubInstallReady, reuseExistingFolder } from './setup-folder'
import { currentBrainFolder, folderForSlug, listBrains, rememberBrain, switchBrain } from './brains'
import { clearPendingJoin, getPendingJoin, setPendingJoin } from './join-pending'
import { bringAppFront, clipOrgLogin, stopClipboardOrgWatch, watchClipboardOrg } from './bring-front'
import { startBrainSync, stopBrainSync } from './brain-sync'
import {
  addCompany,
  addProjectSeat,
  assertJoeSuper,
  existingProjectSeat,
  isHqMiniFolder,
  joinProject,
  openExistingSeat,
  hqRepoFromFolder,
  ownerBindUntilReady,
  ownerLogin,
  ownerStatus,
  requestHqCode,
  retargetHqSync,
  revokeProjectSeat
} from './hq-sync'
import { readSyncHealth } from './sync-health'
import { isJoeSuperAdmin } from './super-admin'
import { classifyLogin, type LoginVia } from './login-route'
import { installNeed, isNeedId, listNeeds, loginCli, loginCliUntilDone } from './install'
import { cliSignedIn } from './cli-auth'
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

/** Dev only (`npm run dev`). Packed Brain skips Ads2AI create-team. Join, clone, and Agency Brain switch still run. */
export function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

function tokenForSlug(slug: string): string {
  const t = memberTokenForTeam(slug)
  if (t) return t
  return getMemberToken()
}

function applyAccountForFolder(folder: string): void {
  const acct = getAccount()
  if (!acct) return
  saveAccount({
    ...acct,
    appEmail: acct.appEmail || acct.email,
    folder
  })
}

async function adoptFolder(path: string): Promise<{
  path: string
  name: string
  slug: string
  agency: { ok: boolean; detail: string }
  hq: { ok: boolean; detail: string }
}> {
  const row = switchBrain(path)
  saveRecent(row.path)
  const agency = await activateWatching(row.path)
  applyAccountForFolder(row.path)
  stopBrainSync()
  const hq = await retargetHqSync(row.path)
  if (!isHqMiniFolder(row.path)) startBrainSync(row.path)
  const pending = getPendingJoin()
  if (pending && row.slug && pending.teamSlug.toLowerCase() === row.slug.toLowerCase()) clearPendingJoin()
  return { ...row, agency, hq }
}

function joinCodeError(err: unknown): Error {
  const msg = String((err as Error)?.message || err)
  if (/not found|404/i.test(msg)) {
    return new Error(
      'That code is not a company brain. Create the company in Ads2AI first, then paste the code it shows.'
    )
  }
  if (/expired|410/i.test(msg)) return new Error('That code has expired. Open Ads2AI and get a new one.')
  if (/github app|409/i.test(msg)) {
    return new Error('GitHub is not finished on that company yet. Wait a minute, then paste the code again.')
  }
  return new Error(msg.slice(0, 200) || 'That code did not work.')
}

export function registerStubIpc(): void {
  loadAccount()
  ipcMain.handle('env:get', async () => {
    const watching = readWatching()
    const folder = currentBrainFolder() || watching.brainPath
    const ident = readTeamIdentity(folder)
    const seat = await existingProjectSeat(folder || undefined).catch(() => null)
    return {
      dryRun: dryRun(),
      chatLive: true,
      existingBrain: {
        ...watching,
        brainPath: folder || watching.brainPath,
        name: ident?.name || watching.name,
        teamSlug: ident?.slug || watching.teamSlug,
        teamName: ident?.name || watching.teamName
      },
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
    const email = String(acct?.appEmail || acct?.email || '').trim().toLowerCase()
    const folder = currentBrainFolder() || watching.brainPath || acct?.folder || null
    const roster = readTeamRoster(folder)
    const member = readTeamMember(folder, email)
    const displayName = helloName(acct, plyntrOwnerProfile())
    const ident = readTeamIdentity(folder)
    const brainName = String(ident?.name || roster?.name || watching.teamName || watching.name || '').trim()
    const plyntrBrain = (ident?.slug || roster?.slug || watching.teamSlug) === 'plyntr'
    const superAdmin = isJoeSuperAdmin(acct, file)
    const hqMini = (acct?.source === 'hq-sync' || isHqMiniFolder(acct?.folder)) && !watching.brainPath
    return {
      superAdmin,
      email,
      name: displayName,
      role: String(acct?.role || member?.role || ''),
      signedIn: Boolean(acct?.email),
      watching: hqMini ? true : watching.watching,
      brainPath: folder,
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
    const folder = currentBrainFolder() || watching.brainPath || acct?.folder || null
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
    return listProjectFolders(folder || currentBrainFolder() || watching.brainPath || acct?.folder || null)
  })
  ipcMain.handle('brains:list', () => listBrains())
  ipcMain.handle('brains:switch', async (_e, folder: string) => {
    assertJoeSuper('switch brains')
    return adoptFolder(folder)
  })
  ipcMain.handle('brains:add', async (_e, opts: { code?: string }) => {
    assertJoeSuper('add a company brain')
    const code = String(opts?.code || '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 6)
    if (code.length < 4) throw new Error('Paste the code Ads2AI showed after you created the company.')
    let res: ads2ai.InviteResolve
    try {
      res = await ads2ai.resolveInvite(code)
    } catch (err) {
      throw joinCodeError(err)
    }
    const slug = String(res.teamSlug || '').trim()
    if (!slug) throw new Error('That code did not name a company brain.')
    const member = res.member || {}
    const name = String(res.teamName || slug)
    setPendingJoin({
      memberToken: res.memberToken,
      teamSlug: slug,
      teamName: String(res.teamName || slug),
      repoUrl: String(res.repoUrl || ''),
      kind: String(res.kind || 'agency'),
      brandName: String(res.teamName || slug),
      memberEmail: String(member.email || res.memberEmail || '').toLowerCase(),
      memberName: String(member.name || res.memberName || ''),
      memberRole: String(member.role || res.memberRole || 'owner'),
      scoutSeats: res.scoutSeats ?? null,
      packageTier: res.packageTier ?? null
    })
    const local = folderForSlug(slug)
    if (local) {
      const adopted = await adoptFolder(local)
      clearPendingJoin()
      return {
        ok: true,
        slug,
        name: adopted.name || name,
        already: true,
        brainPath: adopted.path,
        agency: adopted.agency
      }
    }
    const st = await ads2ai.installStatus(slug).catch(() => null)
    const setup = !githubInstallReady(st) && !String(res.repoUrl || '').trim()
    if (setup) {
      return { ok: true, slug, name, setup: true }
    }
    const applied = await applyFolderImpl({ teamSlug: slug })
    const path = String(applied?.brainPath || '')
    if (!path) throw new Error(applied?.detail || 'Could not copy the shared folder onto this computer.')
    const adopted = await adoptFolder(path)
    clearPendingJoin()
    return {
      ok: true,
      slug,
      name: adopted.name || name,
      brainPath: adopted.path,
      agency: adopted.agency
    }
  })
  ipcMain.handle('brains:remember', (_e, row: { path?: string; name?: string; slug?: string; role?: string }) =>
    rememberBrain(row)
  )
  ipcMain.handle('settings:addTeammate', async (_e, person: TeamPerson) => {
    const watching = readWatching()
    const acct = getAccount()
    const folder = currentBrainFolder() || watching.brainPath || acct?.folder || null
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
      appEmail: email,
      appName: String(m.name || res.memberName || ''),
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
      appEmail: String(res.member.email || key).toLowerCase(),
      appName: res.member.name || '',
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
      email: acct.appEmail || acct.email,
      name: helloName(acct, plyntrOwnerProfile()),
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
  ipcMain.handle('hqSync:watchedRepo', () =>
    hqRepoFromFolder(currentBrainFolder() || readWatching().brainPath || '')
  )
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
    try {
      return await ads2ai.createTeam(getMemberToken(), name)
    } catch (e) {
      const want = String(name || '').trim().toLowerCase()
      const list = await ads2ai.myTeams(getMemberToken()).catch(() => ({ teams: [] as { slug: string; name: string }[] }))
      const hit = (list.teams || []).find((t) => String(t.name || '').trim().toLowerCase() === want)
      if (hit) return { team: hit, reused: true }
      throw e
    }
  })
  ipcMain.handle('setup:lookupOrg', async (_e, login: string) => ads2ai.lookupGithubAccount(login))
  ipcMain.handle('setup:openCreateOrg', async () => {
    openInApp(GITHUB_NEW_ORG, 'Create a GitHub short name')
    const org = await watchClipboardOrg()
    return { ok: true, org }
  })
  ipcMain.handle('setup:openAppInstall', async (_e, slug: string, org?: string) => {
    stopClipboardOrgWatch()
    const look = String(org || '').trim() ? await ads2ai.lookupGithubAccount(org || '') : { ok: false as const }
    const url = githubAppInstallUrl(slug, look.ok ? look.id : undefined)
    openInApp(url, 'Install sharing on GitHub')
    return { ok: true, url }
  })
  ipcMain.handle('setup:pollInstall', (_e, slug: string) => ads2ai.installStatus(slug))
  ipcMain.handle('setup:waitInstall', async (_e, slug: string) => {
    stopClipboardOrgWatch()
    const id = String(slug || '').trim()
    if (!id) return { ok: false, detail: 'No GitHub team to wait on.' }
    const until = Date.now() + 180000
    while (Date.now() < until) {
      const st = (await ads2ai.installStatus(id).catch(() => null)) as {
        installed?: boolean
        repoUrl?: string
        repo?: string
      } | null
      if (githubInstallReady(st)) {
        bringAppFront()
        return { ok: true, installed: true, repoUrl: st?.repoUrl || st?.repo || '' }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    bringAppFront()
    return { ok: false, detail: 'GitHub is not finished. Click Install in the browser, then try again.' }
  })
  ipcMain.handle('setup:bringFront', () => {
    bringAppFront()
    return { ok: true }
  })
  ipcMain.handle('setup:clipOrg', () => ({ ok: true, org: clipOrgLogin() }))
  ipcMain.handle('setup:ensureRepo', async (_e, slug: string) => {
    const id = String(slug || '').trim()
    if (!id) throw new Error('No GitHub team.')
    return ads2ai.ensureBrainRepo(tokenForSlug(id), id)
  })

  async function applyFolderImpl(opts?: { teamSlug?: string; dest?: string }): Promise<{
    ok: boolean
    brainPath?: string | null
    skipped?: boolean
    reason?: string
    detail?: string
  }> {
    const slug = String(opts?.teamSlug || '').trim()
    const watching = readWatching()
    const acct = getAccount() || loadAccount()
    const watchIdent = readTeamIdentity(watching.brainPath)
    const acctIdent = readTeamIdentity(acct?.folder || null)
    const reuse =
      reuseExistingFolder({
        slug,
        watchingPath: watching.brainPath,
        watchingSlug: watchIdent?.slug || watching.teamSlug,
        accountFolder: acct?.folder && existsSync(acct.folder) ? acct.folder : null,
        accountSlug: acctIdent?.slug || null
      }) || folderForSlug(slug)
    if (reuse) {
      startBrainSync(reuse)
      rememberBrain({ path: reuse, slug, name: readTeamIdentity(reuse)?.name || slug })
      return { ok: true, skipped: true, brainPath: reuse, reason: 'already-on-this-computer', detail: reuse }
    }
    if (!slug) throw new Error('No team to clone. Sign in first, or finish GitHub.')
    const git = await ads2ai.gitToken(tokenForSlug(slug), slug)
    const rawUrl = String(git.cloneUrl || git.url || git.repoUrl || '')
    if (!rawUrl) throw new Error('GitHub is not on this brain yet. Click Install in the browser, then try again.')
    const token = String(git.token || '')
    const cloneUrl = token && rawUrl.startsWith('https://') && !rawUrl.includes('@')
      ? rawUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
      : rawUrl
    const dest = String(opts?.dest || '').trim() || join(homedir(), 'Projects', `${slug}-brain`)
    const pending = getPendingJoin()
    const cloned = await cloneBrain({
      cloneUrl,
      dest,
      email: pending?.memberEmail || acct?.email || '',
      name: pending?.memberName || acct?.name || ''
    })
    if (!cloned.ok) throw new Error(cloned.detail || 'Could not copy the shared folder onto this computer.')
    saveRecent(cloned.dest)
    rememberBrain({ path: cloned.dest, slug, name: readTeamIdentity(cloned.dest)?.name || slug })
    startBrainSync(cloned.dest)
    return { ok: true, brainPath: cloned.dest, detail: cloned.detail }
  }

  ipcMain.handle('setup:applyFolder', async (_e, opts?: { teamSlug?: string; dest?: string }) => applyFolderImpl(opts))
  ipcMain.handle('setup:putFolder', async (_e, opts?: { teamSlug?: string; org?: string }) => {
    const slug = String(opts?.teamSlug || '').trim()
    const org = String(opts?.org || '').trim()
    if (!slug) throw new Error('No team to clone. Finish GitHub first.')
    const token = tokenForSlug(slug)
    if (org) {
      await ads2ai.adoptOrgInstallation(token, slug, org).catch((e) => {
        const msg = String((e as Error).message || e)
        if (!/404|not found/i.test(msg)) throw e
      })
    }
    await ads2ai.ensureBrainRepo(token, slug)
    return applyFolderImpl({ teamSlug: slug })
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
  ipcMain.handle('ai:loginWait', async (_e, which: AiKind) => loginCliUntilDone(which))
  ipcMain.handle('ai:signedIn', (_e, which: AiKind) => ({ ok: true, signedIn: cliSignedIn(which) }))

  ipcMain.handle('files:tree', async (_e, root?: string) => {
    const watching = readWatching()
    const cwd = root || currentBrainFolder() || watching.brainPath
    if (!cwd) return []
    return tree(cwd)
  })
  ipcMain.handle('files:list', async (_e, root: string, dir?: string) => listDir(root, dir || root))
  ipcMain.handle('files:match', async (_e, cwd: string, text: string) => matchExisting(cwd || '', text || ''))
  ipcMain.handle('files:read', async (_e, root: string, abs: string) => readSafe(root, abs))
  ipcMain.handle('files:browse', async (_e, root?: string) => {
    const watching = readWatching()
    return browseDocs(root || currentBrainFolder() || watching.brainPath || '')
  })
  ipcMain.handle('files:fileUrl', async (_e, root: string, abs: string) => {
    if (!underRoot(root, abs)) throw new Error('That file is not in this brain.')
    return 'file://' + abs
  })
  ipcMain.handle('files:recents', async () => {
    const w = readWatching()
    const rec = loadRecents()
    const known = listBrains().map((b) => ({ path: b.path, name: b.name, watching: Boolean(b.watching) }))
    const watched =
      w.brainPath && existsSync(w.brainPath)
        ? [{ path: w.brainPath, name: basename(w.brainPath), watching: true as const }]
        : []
    const seen = new Set<string>()
    const out: { path: string; name: string; watching?: boolean }[] = []
    for (const row of [...known, ...watched, ...rec]) {
      if (!row.path || seen.has(row.path)) continue
      seen.add(row.path)
      out.push(row)
    }
    return out
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
