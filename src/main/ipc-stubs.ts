import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { asSeat, canTurnOnGithubSync, GITHUB_NEW_ORG, type AiKind } from '../shared/contracts'
import { parseGithubHqRepo } from '../shared/github-org'
import { openInApp } from './in-app-browse'
import * as ads2ai from './ads2ai'
import { homedir, userInfo } from 'node:os'
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
import { cloneBrain, defaultBrainDest, hasBrainMarker, removeFailedBrainCheckout } from './clone'
import { takeFirstWelcome } from './first-chat'
import {
  bridgeInstallUrl,
  githubAppInstallUrl,
  githubInstallReady,
  plyntrCreateRepoUrl,
  bridgeSelectionBlocksSync,
  plyntrGithubInstallReady,
  plyntrInstallPin,
  reuseExistingFolder
} from './setup-folder'
import { adoptFolder as recordKeyless, brainRowForPath, currentBrainFolder, folderForSlug, listBrains, rememberBrain, switchBrain } from './brains'
import { acceptBrainCode, bindBrainFolder, initShellVault, listAllowed, logoutShell as logoutVault, resumeShellAccount as resumeVault, seatForId, setFlag, shellEmail, shellView, signInEmailOnly, switchShellBrain as switchVault } from './shell-vault'
import { clearPendingJoin, getPendingJoin, pendingFromInvite, setPendingJoin } from './join-pending'
import { ensurePendingJoinForFolder } from './watch-handoff'
import { bringAppFront, clipOrgLogin, stopClipboardOrgWatch, watchClipboardOrg } from './bring-front'
import { setBrainSyncBlockedReason, startBrainSync, stopBrainSync } from './brain-sync'
import { publishLocalToGithub, stripOriginToken } from './local-brain'
import {
  addCompany,
  addProjectSeat,
  assertJoeSuper,
  existingProjectSeat,
  isHqMiniFolder,
  isPlatformOwnerSession,
  loadOwnerSession,
  rememberBrainOwnerSession,
  joinProject,
  openExistingSeat,
  HQ_SYNC_ORIGIN,
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
import { cloudflaredPresent, gitPresent, installNeed, isNeedId, listNeeds, loginCli, loginCliUntilDone } from './install'
import { cliSignedIn } from './cli-auth'
import { explainSetup } from './setup-explain'
import { mergeDraftContext } from './setup-draft'
import { agencyPretend, installPretend, isPretendJoinCode } from './setup-pretend'
import { setupTrace } from './setup-trace'
import * as ai from './ai-cli'
import { asAttachBuf, inspectAttach, stashBytes } from './attach'
import { browseDocs, listDir, matchExisting, readSafe, tree, underRoot, writeSafe } from './files'
import { brainWriteBlock } from './write-guard'
import { roleForBrainWrite } from './write-guard-role'
import {
  MOVE_NO_REPO,
  brainRepoParts,
  folderCanMoveToPlyntr,
  gitRemoteRepo,
  runPlyntrMove,
  writePlyntrSyncFile
} from './plyntr-move'
import { adviseGithubOrg, ensureRemoteBrainRepo, resolveGithubOrg, resolveGithubRepoId } from './github-account'
import { resolvePlyntrRepoName } from './github-repo'
import { loadAnyChats, loadChats, saveChats, type SavedChats } from './persist'
import { rememberPhoneChats } from './phone'
import { emitChat, markChatBusy } from './chat-fan'
import { cancelWarm, closeWarm, forkSession, promptWarm, resetWarm, resumeSession, warmSession } from './warm'
import { justUpdated } from './update'
import { contextBlurb, grokCli, grokTranscript, listGrokSessions, listSlash, usageBlurb } from './slash'
import { clearAccount, getAccount, getMemberToken, loadAccount, saveAccount } from './session-token'
import { authCodeRoute, isPlyntrCompanyCode, normalizePlyntrInviteCode } from '../shared/plyntr-invite'
import { listedRoleForSeat, plyntrSessionRole } from '../shared/plyntr-transfer'
import { readSyncManifest, readSyncMode } from './sync-manifest'
import { AB_OWNS_PLYNTR, chooseWatcher } from './watcher-choice'
import {
  brainIdForFolder,
  clearPendingCreate,
  clearPendingJoinPlyntr,
  loginToken,
  readPendingCreate,
  readPendingJoin as readPendingPlyntrJoin,
  roleForKeylessWrite,
  savePlyntrSeat,
  seatForBrain,
  seatTokenForBrain,
  seatTokenForFolder,
  writePendingCreate,
  writePendingJoin
} from './plyntr-seats'
import {
  copyDryRunFixture,
  seedLocalBrain,
  seedSetupDraft,
  claimPlyntrCompany,
  createPlyntrBrain,
  dryRunProjectFolder,
  emailPlyntrCode,
  ensurePlyntrRepo,
  invitePlyntrCompany,
  listPlyntrCompanies,
  openPlyntrCompany,
  setPlyntrCompanyPack,
  readPlyntrCompany,
  placePlyntrBrain,
  plyntrBindUntilReady,
  plyntrGitToken,
  plyntrInstalled,
  plyntrListSeats,
  plyntrMintInvite,
  plyntrRevokeInvite,
  plyntrRevokeSeat,
  plyntrTransferScout,
  resolvePlyntrCode
} from './plyntr-sync'
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

async function pinnedPlyntrInstall(
  brainId: string,
  org: string,
  repo: string
): Promise<{ ok: boolean; url: string; detail?: string }> {
  const look = await resolveGithubOrg(org)
  const orgName = look.login || String(org || '').trim()
  if (!look.ok || look.type !== 'Organization' || !look.id) {
    return {
      ok: false,
      url: '',
      detail: look.detail || `GitHub did not confirm the organization ${orgName || 'you entered'}.`
    }
  }
  const named = plyntrInstallPin({ brainId, orgName, repo })
  if (!named.ok || !named.want) {
    return { ok: false, url: '', detail: named.detail || 'This brain has no GitHub repository name yet.' }
  }
  const rid = await resolveGithubRepoId(named.want)
  if (!rid.ok || !rid.id) {
    return {
      ok: false,
      url: '',
      detail: rid.detail || `GitHub did not return an id for ${named.want}.`
    }
  }
  const pin = plyntrInstallPin({
    brainId,
    orgName,
    repo: named.want,
    orgId: look.id,
    repoId: rid.id,
    repoOwner: rid.owner
  })
  if (!pin.ok || !pin.url) {
    return {
      ok: false,
      url: '',
      detail:
        pin.detail ||
        `This Mac could not build the install page for ${orgName}: the organization or repository id is missing.`
    }
  }
  openInApp(pin.url, 'Install Plyntr sync on GitHub')
  return { ok: true, url: pin.url }
}

async function openPlyntrProject(code: string) {
  const normalized = normalizePlyntrInviteCode(code)
  const resolved = await resolvePlyntrCode(normalized)
  if (resolved.role !== 'project') {
    throw new Error('That code is for a full seat. Use I have a Plyntr code.')
  }
  const joined = dryRun()
    ? dryRunProjectFolder(resolved)
    : await joinProject({ email: resolved.email, code: normalized })
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
  if (readSyncMode(row.path) === 'local') {
    applyAccountForFolder(row.path)
    stopBrainSync()
    return {
      ...row,
      agency: { ok: true, detail: 'On this computer only.' },
      hq: { ok: true, detail: 'Project sync was left as-is.' }
    }
  }
  if (readSyncMode(row.path) === 'plyntr') {
    applyAccountForFolder(row.path)
    const watchingNow = readWatching()
    const choice = chooseWatcher({
      mode: 'plyntr',
      abInstalled: detectApp().installed,
      abWatchingPath: Boolean(watchingNow.watching && watchingNow.brainPath === row.path),
      mini: false
    })
    if (choice === 'blocked') setBrainSyncBlockedReason(row.path, AB_OWNS_PLYNTR)
    else startBrainSync(row.path)
    return {
      ...row,
      agency: { ok: choice !== 'blocked', detail: choice === 'blocked' ? AB_OWNS_PLYNTR : 'Plyntr sync' },
      hq: { ok: true, detail: 'Project sync was left as-is.' }
    }
  }
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
  initShellVault(app.getPath('userData'))
  ensureShell()
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
  function rosterPeople(folder: string | null) {
    const roster = readTeamRoster(folder)
    return (roster?.members || []).map((m) => ({
      name: m.name,
      email: m.email,
      role: asSeat(m.role),
      brain: (m.brains && m.brains[0]) || 'hq',
      brains: m.brains || []
    }))
  }
  ipcMain.handle('settings:roster', () => {
    const watching = readWatching()
    const acct = getAccount()
    const folder = currentBrainFolder() || watching.brainPath || acct?.folder || null
    return rosterPeople(folder)
  })
  ipcMain.handle('settings:rosterAt', (_e, folder: string) => {
    const path = String(folder || '').trim()
    if (!path || !listBrains().some((b) => b.path === path)) return []
    return rosterPeople(path)
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
  ipcMain.handle('shell:view', () => {
    refreshFlag()
    const folder = currentBrainFolder()
    const known = folder ? brainRowForPath(folder) : null
    const allowed = listAllowed()
    const id = known?.brainId && allowed.includes(known.brainId) ? known.brainId : folder && allowed.includes(folder) ? folder : ''
    const live = id ? seatForId(id) : { email: '', label: '', token: '' }
    const local = listBrains().filter((b) => b.path && existsSync(b.path)).map((b) => ({ path: b.path, brainId: b.brainId || '' }))
    return {
      ...shellView(),
      local,
      seat: { email: live.email || '', label: live.label || '', token: live.token ? 'seat' : '' }
    }
  })
  /** Startup only: an install that already has account.json signs that shell in once. Codes never call this. */
  function ensureShell(): void {
    const acct = getAccount() || loadAccount()
    if (acct?.email && !shellEmail()) signInEmailOnly(acct.email)
    refreshFlag()
  }
  function refreshFlag(): void {
    setFlag(isJoeSuperAdmin(getAccount() || loadAccount(), getSettings()))
  }
  function switchShellBrain(selectedFolderId: string) {
    refreshFlag()
    const known = brainRowForPath(selectedFolderId) || listBrains().find((b) => b.brainId && b.brainId === selectedFolderId) || null
    const folder = known?.path || selectedFolderId
    if (!folder || !existsSync(folder)) throw new Error('That brain folder is not on this computer.')
    const view = shellView()
    const joe = view.email === 'joe@plyntr.com' && view.flag
    if (known?.brainId) {
      // A keyed folder opens only with that brain's own sign-in and key, never as keyless.
      if (joe && !view.signedIn.includes(known.brainId)) throw new Error('Sign in to that brain first.')
      switchVault(known.brainId)
      bindBrainFolder(folder, known.brainId)
    } else {
      // Joe can open any brain folder on this Mac. One with no brainId is remembered by path.
      if (joe) recordKeyless(folder, 'agency-seat')
      switchVault(folder)
    }
    return adoptFolder(folder)
  }
  ipcMain.handle('brains:switch', (_e, selectedFolderId: string) => {
    return switchShellBrain(selectedFolderId)
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
    setPendingJoin(pendingFromInvite(res))
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
    if (!githubInstallReady(st)) {
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
    if (folder) {
      const blocked = brainWriteBlock(brainIdForFolder(folder) ? roleForBrainWrite(folder) : roleForKeylessWrite(folder), folder, join(folder, '.team-config', 'roles.json'))
      if (blocked) return { people: loadTeam(), roster: { ok: false, detail: blocked } }
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
    if (authCodeRoute(raw) === 'plyntr') {
      throw new Error('That is a Plyntr code. Go back and choose Plyntr sync only.')
    }
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
    setPendingJoin(pendingFromInvite(res))
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

  ipcMain.handle('auth:requestCode', async (_e, email: string, viaRaw?: LoginVia) => {
    const key = String(email || '').trim().toLowerCase()
    if (viaRaw === 'hq-sync') {
      await requestHqCode(key)
      return { ok: true, via: 'hq-sync' as LoginVia }
    }
    if (viaRaw === 'ads2ai') {
      await ads2ai.requestCode(key)
      return { ok: true, via: 'ads2ai' as LoginVia }
    }
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
        email: key,
        appEmail: key,
        name: joined.name,
        token: `local:${key}`,
        role: 'project',
        source: 'hq-sync',
        folder: joined.brainPath,
        brains: joined.roots
      })
      saveRecent(joined.brainPath)
      const codeEmail = String(joined.email || key).toLowerCase()
      acceptBrainCode('', key, codeEmail, 'project', '')
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
        email: key,
        appEmail: key,
        appName: res.member.name || '',
        name: res.member.name || '',
        token: res.token,
        source: 'ads2ai'
      })
      const teams = (await ads2ai.myTeams(res.token)).teams || []
      const codeEmail = String(res.member.email || key).toLowerCase()
      acceptBrainCode('', key, codeEmail, '', '')
      return { ok: true, via: 'ads2ai' as const, member: res.member, teams, role: '' }
    }

    if (authCodeRoute(code) === 'plyntr') {
      const resolved = await resolvePlyntrCode(normalizePlyntrInviteCode(code))
      const slug = resolved.repo.split('/')[1]?.replace(/-brain$/, '') || ''
      if (resolved.role === 'project') {
        const joined = dryRun()
          ? dryRunProjectFolder(resolved)
          : await joinProject({ email: resolved.email, code: normalizePlyntrInviteCode(code) })
        acceptBrainCode(resolved.brainId, key, resolved.email, resolved.role, resolved.seatToken, slug, resolved.repo)
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
      writePendingJoin({
        brainId: resolved.brainId,
        repo: resolved.repo,
        role: resolved.role,
        email: resolved.email,
        name: resolved.name,
        slug,
        label: resolved.label,
        bootstrap: resolved.bootstrap,
        wizardStep: 5
      })
      acceptBrainCode(resolved.brainId, key, resolved.email, resolved.role, resolved.seatToken, slug, resolved.repo)
      const current = getAccount() || loadAccount()
      if (!isJoeSuperAdmin(current, getSettings())) {
        saveAccount({
          email: resolved.email,
          name: resolved.name,
          token: loginToken(),
          role: resolved.role,
          source: 'plyntr'
        })
      }
      return {
        ok: true,
        via: 'plyntr' as const,
        member: { email: resolved.email, name: resolved.name, role: resolved.role },
        teams: [] as { slug: string; name: string; role: string; kind?: string }[],
        brainPath: '',
        role: resolved.role,
        brainId: resolved.brainId,
        repo: resolved.repo,
        slug
      }
    }
    if (via === 'hq-sync') return asProject()
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
  function logoutShell(): void {
    logoutVault()
    clearAccount()
  }
  ipcMain.handle('auth:logout', () => {
    logoutShell()
    stopBrainSync()
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
    if (readSyncMode(folder) === 'plyntr') throw new Error('This brain uses a Plyntr code.')
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
  ipcMain.handle('setup:lookupOrg', async (_e, login: string) => resolveGithubOrg(login))
  ipcMain.handle('setup:createPlyntrRepo', async (_e, org: string, slug: string, repo?: string) => {
    if (dryRun()) {
      const name = resolvePlyntrRepoName(org, slug, repo)
      return { ok: Boolean(name), repo: name, detail: name ? undefined : 'This brain has no GitHub repository name yet.' }
    }
    return ensureRemoteBrainRepo(org, slug, repo)
  })
  ipcMain.handle('setup:adviseOrg', async (_e, login: string) => adviseGithubOrg(login))
  ipcMain.handle('setup:openCreateOrg', async () => {
    openInApp(GITHUB_NEW_ORG, 'Create a GitHub short name')
    const org = await watchClipboardOrg()
    return { ok: true, org }
  })
  ipcMain.handle('setup:openAppInstall', async (_e, slug: string, org?: string) => {
    setupTrace({ event: 'ipc', channel: 'setup:openAppInstall' })
    if (process.env.BRAIN_APP_SETUP_DRIVE === '1') return { ok: true, url: 'https://github.com/apps/agency-brain-sync/installations/new' }
    stopClipboardOrgWatch()
    const look = String(org || '').trim() ? await ads2ai.lookupGithubAccount(org || '') : { ok: false as const }
    const url = githubAppInstallUrl(slug, look.ok ? look.id : undefined)
    openInApp(url, 'Install sharing on GitHub')
    return { ok: true, url }
  })
  ipcMain.handle('setup:pollInstall', (_e, slug: string) => {
    const ag = agencyPretend()
    if (ag) {
      setupTrace({ event: 'agency', handler: 'setup:pollInstall', app: ag.app, bridge: ag.bridge, copy: ag.copy })
      return { ok: true, installed: ag.app, repo: ag.app ? 'agency/example-brain' : '' }
    }
    return ads2ai.installStatus(slug)
  })
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
    return { ok: false, detail: 'The app is not installed on GitHub yet. In the browser, click Install, then Only select repositories, and try again.' }
  })
  async function openPinnedBridge(repo: string): Promise<{ ok: boolean; repo: string; url: string }> {
    const named = parseGithubHqRepo(repo)
    if (!named) throw new Error('This brain has no GitHub repository name yet.')
    const owner = named.split('/')[0]
    const look = await resolveGithubOrg(owner)
    if (!look.ok || look.type !== 'Organization' || !look.id) {
      throw new Error(look.detail || `GitHub did not confirm the organization ${owner}.`)
    }
    const rid = await resolveGithubRepoId(named)
    if (!rid.ok || !rid.id) throw new Error(rid.detail || `GitHub did not return an id for ${named}.`)
    if (rid.owner && rid.owner.toLowerCase() !== String(look.login || owner).toLowerCase()) {
      throw new Error(`${named} is not a repository in ${look.login || owner}.`)
    }
    const url = bridgeInstallUrl(named, look.id, rid.id)
    openInApp(url, 'Install Brain Bridge')
    return { ok: true, repo: named, url }
  }

  async function bridgeInstallStatus(repo: string): Promise<{ installed: boolean; repositorySelection: string }> {
    const r = await fetch(`${HQ_SYNC_ORIGIN}/github/installed?repo=${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(15000)
    })
    const body = (await r.json().catch(() => null)) as { installed?: boolean; repositorySelection?: string } | null
    return {
      installed: r.ok && body?.installed === true,
      repositorySelection: String(body?.repositorySelection || '')
    }
  }

  async function bridgeInstalled(repo: string): Promise<boolean> {
    return (await bridgeInstallStatus(repo)).installed
  }

  ipcMain.handle('setup:bridgeStatus', async (_e, folder: string) => {
    const ag = agencyPretend()
    if (ag) {
      setupTrace({ event: 'agency', handler: 'setup:bridgeStatus', app: ag.app, bridge: ag.bridge, copy: ag.copy })
      return { ok: true, installed: ag.bridge, skipped: false, repo: 'agency/example-brain' }
    }
    const bridgeMode = readSyncMode(String(folder || ''))
    if (bridgeMode === 'plyntr' || bridgeMode === 'local') {
      return { ok: true, installed: true, skipped: true, repo: '' }
    }
    if (dryRun()) return { ok: true, installed: true, skipped: true, repo: '' }
    const repo = hqRepoFromFolder(String(folder || ''))
    if (!repo) return { ok: false, installed: false, repo: '', detail: 'This folder has no GitHub repo yet.' }
    try {
      const installed = await bridgeInstalled(repo)
      return {
        ok: true,
        installed,
        repo,
        detail: installed ? '' : 'Brain Bridge is not on this repo yet.'
      }
    } catch {
      return { ok: false, installed: false, repo, detail: 'Could not check Brain Bridge.' }
    }
  })
  ipcMain.handle('setup:openBridge', async (_e, folder: string) => {
    const repo = hqRepoFromFolder(String(folder || ''))
    if (!repo) throw new Error('This folder has no GitHub repo yet.')
    return openPinnedBridge(repo)
  })
  ipcMain.handle('setup:openBridgeRepo', async (_e, repo: string) => openPinnedBridge(String(repo || '')))
  ipcMain.handle('setup:bridgeOnRepo', async (_e, repo: string) => {
    const ag = agencyPretend()
    if (ag) {
      setupTrace({ event: 'agency', handler: 'setup:bridgeOnRepo', app: ag.app, bridge: ag.bridge, copy: ag.copy })
      return {
        ok: true,
        installed: ag.bridge,
        repositorySelection: ag.bridge ? 'selected' : '',
        repo: String(repo || ''),
        detail: ag.bridge ? '' : 'Brain Bridge is not on this repo yet.'
      }
    }
    const name = parseGithubHqRepo(String(repo || ''))
    if (!name) return { ok: false, installed: false, repo: '', detail: 'This brain has no GitHub repository name yet.' }
    if (dryRun()) return { ok: true, installed: true, skipped: true, repo: name }
    try {
      const status = await bridgeInstallStatus(name)
      return {
        ok: true,
        installed: status.installed,
        repositorySelection: status.repositorySelection,
        repo: name,
        detail: status.installed ? '' : 'Brain Bridge is not on this repo yet.'
      }
    } catch {
      return { ok: false, installed: false, repo: name, detail: 'Could not check Brain Bridge.' }
    }
  })
  ipcMain.handle('setup:waitBridge', async (_e, folder: string) => {
    const ag = agencyPretend()
    if (ag) {
      setupTrace({ event: 'agency', handler: 'setup:waitBridge', app: ag.app, bridge: ag.bridge, copy: ag.copy })
      return {
        ok: ag.bridge,
        installed: ag.bridge,
        skipped: false,
        repo: 'agency/example-brain',
        detail: ag.bridge ? '' : 'Brain Bridge is not installed on this repo yet.'
      }
    }
    if (dryRun()) return { ok: true, installed: true, skipped: true, repo: '' }
    const repo = hqRepoFromFolder(String(folder || ''))
    if (!repo) return { ok: false, installed: false, detail: 'This folder has no GitHub repo yet.' }
    const until = Date.now() + 180000
    while (Date.now() < until) {
      const installed = await bridgeInstalled(repo).catch(() => false)
      if (installed) {
        bringAppFront()
        return { ok: true, installed: true, repo }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    bringAppFront()
    return {
      ok: false,
      installed: false,
      repo,
      detail: 'Brain Bridge is not installed on this repo yet. In the browser, click Install, choose Only select repositories, pick this repo, then try again.'
    }
  })
  ipcMain.handle('setup:tryOpen', async (e, kind: AiKind, folder?: string) => {
    const signedIn = cliSignedIn(kind)
    const git = gitPresent()
    const cloud = cloudflaredPresent()
    const opened = Boolean(signedIn && git && cloud)
    let model = ''
    let effort = ''
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) {
      try {
        const painted = (await win.webContents.executeJavaScript(
          `(() => {
            const keys = [...document.querySelectorAll('.runmeta-k')].map((n) => (n.textContent || '').trim())
            const vals = [...document.querySelectorAll('.runmeta-v')].map((n) => (n.textContent || '').trim())
            const at = (name) => {
              const i = keys.indexOf(name)
              return i >= 0 ? vals[i] || '' : ''
            }
            return { model: at('Model'), effort: at('Effort') }
          })()`
        )) as { model?: string; effort?: string }
        model = String(painted?.model || '')
        effort = String(painted?.effort || '')
      } catch {
        model = ''
        effort = ''
      }
    }
    const aiName = kind === 'gpt' ? 'ChatGPT' : kind === 'cursor' ? 'Cursor' : kind === 'claude' ? 'Claude' : kind === 'grok' ? 'Grok' : 'the AI you picked'
    const detail = opened
      ? ''
      : !signedIn
        ? `Next, sign in to ${aiName}. A browser opens.`
        : !git
          ? 'Git is still missing.'
          : 'Cloudflare Tunnel is still missing.'
    setupTrace({ event: 'chat-open', signedIn, git, opened, model, effort, folder: String(folder || '') })
    return { opened, signedIn, git, model, effort, detail }
  })
  ipcMain.handle(
    'setup:explain',
    async (e, body: { heading?: string; kinds?: AiKind[]; strip?: boolean; cwd?: string; token?: number }) =>
      explainSetup(
        {
          heading: String(body?.heading || ''),
          kinds: Array.isArray(body?.kinds) ? body.kinds : [],
          strip: Boolean(body?.strip),
          cwd: body?.cwd,
          token: Number.isFinite(body?.token) ? Number(body?.token) : undefined
        },
        BrowserWindow.fromWebContents(e.sender)
      )
  )
  ipcMain.handle('setup:ensureDraft', async (_e, id: string) => {
    const driveRoot = process.env.BRAIN_APP_SETUP_DRIVE === '1' ? String(process.env.BRAIN_APP_SETUP_ROOT || '').trim() : ''
    const base = driveRoot
      ? join(driveRoot, 'setup-drafts')
      : join(userInfo().homedir, 'Library/Application Support/brain-app/setup-drafts')
    const dest = join(base, String(id || 'draft'))
    await seedSetupDraft(dest, gitPresent())
    const { spawnSync } = await import('node:child_process')
    const remote = spawnSync('git', ['remote'], { cwd: dest, encoding: 'utf8' })
    const row = {
      event: 'draft',
      path: dest,
      sync: existsSync(join(dest, '.team-config', 'sync.json')),
      remote: Boolean(String(remote.stdout || '').trim())
    }
    setupTrace(row)
    return { ok: true, path: dest, sync: row.sync, remote: row.remote }
  })
  ipcMain.handle('setup:mergeDraft', async (_e, draft: string, clone: string) => mergeDraftContext(String(draft || ''), String(clone || '')))
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

  async function settleSync(folder: string): Promise<void> {
    const drive = process.env.BRAIN_APP_SETUP_DRIVE === '1'
    if (!drive && dryRun() && readSyncMode(folder) !== 'plyntr') return
    const watchingNow = readWatching()
    const choice = chooseWatcher({
      mode: readSyncMode(folder),
      abInstalled: detectApp().installed,
      abWatchingPath: Boolean(watchingNow.watching && watchingNow.brainPath === folder),
      mini: isHqMiniFolder(folder)
    })
    if (choice === 'none') return
    if (choice === 'blocked') {
      setBrainSyncBlockedReason(folder, AB_OWNS_PLYNTR)
      return
    }
    if (choice === 'activate') {
      if (!drive && dryRun()) return
      if (!dryRun()) ensurePendingJoinForFolder(folder)
      const watched = await activateWatching(folder)
      if (drive) return
      if (watched.ok) {
        stopBrainSync()
        return
      }
    }
    startBrainSync(folder)
  }

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
    if (reuse && hasBrainMarker(reuse)) {
      switchBrain(reuse)
      applyAccountForFolder(reuse)
      await settleSync(reuse)
      rememberBrain({ path: reuse, slug, name: readTeamIdentity(reuse)?.name || slug })
      return { ok: true, skipped: true, brainPath: reuse, reason: 'already-on-this-computer', detail: reuse }
    }
    if (dryRun()) {
      return { ok: true, skipped: true, reason: 'clone skipped in dry-run', brainPath: currentBrainFolder() || null }
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
    switchBrain(cloned.dest)
    applyAccountForFolder(cloned.dest)
    rememberBrain({ path: cloned.dest, slug, name: readTeamIdentity(cloned.dest)?.name || slug })
    await settleSync(cloned.dest)
    return { ok: true, brainPath: cloned.dest, detail: cloned.detail }
  }

  ipcMain.handle('setup:applyFolder', async (_e, opts?: { teamSlug?: string; dest?: string }) => applyFolderImpl(opts))
  ipcMain.handle(
    'setup:putFolder',
    async (_e, opts?: { teamSlug?: string; org?: string; retry?: boolean }) => {
      const ag = agencyPretend()
      if (ag) setupTrace({ event: 'agency', handler: 'setup:putFolder', app: ag.app, bridge: ag.bridge, copy: ag.copy })
      if (ag && !ag.copy) {
        return {
          ok: false,
          detail: 'The app is not installed on GitHub yet. Click Install in the browser, then try again.'
        }
      }
      if (ag && ag.copy) {
        const root = process.env.BRAIN_APP_SETUP_DRIVE === '1' ? String(process.env.BRAIN_APP_SETUP_ROOT || '').trim() : ''
        const dest = join(root || join(homedir(), 'Projects'), 'setup-trace-agency-brain')
        mkdirSync(dest, { recursive: true })
        if (!existsSync(join(dest, 'AGENTS.md'))) writeFileSync(join(dest, 'AGENTS.md'), 'agency copy\n')
        switchBrain(dest)
        await settleSync(dest)
        return { ok: true, brainPath: dest }
      }
      const slug = String(opts?.teamSlug || '').trim()
      const org = String(opts?.org || '').trim()
      if (!slug) throw new Error('No team to clone. Finish GitHub first.')
      if (dryRun()) {
        return applyFolderImpl({ teamSlug: slug })
      }
      const token = tokenForSlug(slug)
      if (org) {
        await ads2ai.adoptOrgInstallation(token, slug, org).catch((e) => {
          const msg = String((e as Error).message || e)
          if (!/404|not found/i.test(msg)) throw e
        })
      }
      const st = (await ads2ai.installStatus(slug).catch(() => null)) as {
        installed?: boolean
        repoUrl?: string
        repo?: string
      } | null
      if (!githubInstallReady(st)) {
        throw new Error('The app is not installed on GitHub yet. Click Install in the browser, then try again.')
      }
      const dest = defaultBrainDest(slug)
      if (opts?.retry) removeFailedBrainCheckout(dest)

      const emptyMsg = /empty folder|not in the repo/i
      for (let attempt = 0; attempt < 3; attempt++) {
        await ads2ai.ensureBrainRepo(token, slug)
        try {
          return await applyFolderImpl({ teamSlug: slug })
        } catch (err) {
          const msg = String((err as Error).message || err)
          if (!emptyMsg.test(msg) || attempt === 2) throw err
          await new Promise((r) => setTimeout(r, 2500))
          removeFailedBrainCheckout(dest)
        }
      }
      throw new Error('Could not copy the shared folder onto this computer.')
    }
  )

  const PLATFORM_GATE =
    'Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login.'

  async function putFolderPlyntr(opts: { brainId?: string; org?: string; slug?: string; repo?: string }) {
    const brainId = String(opts.brainId || '').trim()
    const slug = String(opts.slug || '').trim()
    const org = String(opts.org || '').trim()
    const repo = resolvePlyntrRepoName(org, slug, opts.repo)
    if (!brainId || !slug || !repo) throw new Error('This brain is missing its Plyntr id.')
    const dest = defaultBrainDest(slug)
    const seatBefore = seatForBrain(brainId)
    if (dryRun()) {
      await copyDryRunFixture({ dest, org: org || repo.split('/')[0], slug })
    } else {
      if (seatBefore?.role === 'owner' || (seatBefore?.role === 'scout' && seatBefore.bootstrap)) {
        await ensurePlyntrRepo(brainId)
      }
      const st = await plyntrInstalled(brainId, repo)
      if (!plyntrGithubInstallReady(st, repo)) {
        throw new Error('The app is not installed on GitHub yet. Click Install in the browser, then try again.')
      }
      const git = await plyntrGitToken(brainId)
      if (!git.token) throw new Error('Could not get a git token for this brain.')
      const cloned = await cloneBrain({
        cloneUrl: `https://x-access-token:${git.token}@github.com/${repo}.git`,
        dest,
        email: seatForBrain(brainId)?.email || '',
        name: getAccount()?.name || ''
      })
      if (!cloned.ok) throw new Error(cloned.detail || 'Could not copy the shared folder onto this computer.')
    }
    const seat = seatForBrain(brainId)
    switchBrain(dest)
    const acct = getAccount() || loadAccount()
    if (acct) saveAccount({ ...acct, folder: dest, source: 'plyntr', token: acct.token.startsWith('login:') ? acct.token : loginToken() })
    rememberBrain({
      path: dest,
      slug,
      name: readTeamIdentity(dest)?.name || slug,
      role: seat?.role,
      syncMode: 'plyntr',
      brainId,
      seatToken: seat?.seatToken
    })
    saveRecent(dest)
    await settleSync(dest)
    return { ok: true, brainPath: dest }
  }

  async function putFolderLocal(opts: {
    brainId?: string
    org?: string
    slug?: string
    repo?: string
    email?: string
    name?: string
  }) {
    const brainId = String(opts.brainId || '').trim()
    const slug = String(opts.slug || '').trim() || brainId.slice(0, 8)
    const org = String(opts.org || '').trim()
    const rawRepo = String(opts.repo || '')
    const pending = !rawRepo || rawRepo.startsWith('pending/')
    const repo = pending ? '' : resolvePlyntrRepoName(org, slug, rawRepo)
    if (!brainId || !slug) throw new Error('This brain is missing its Plyntr id.')
    const dest = defaultBrainDest(slug)
    const seat = seatForBrain(brainId)
    const email = seat?.email || String(opts.email || '')
    const name = String(opts.name || getAccount()?.name || '')
    let seeded = false
    if (!hasBrainMarker(dest)) {
      const existed = existsSync(dest)
      let cloned = false
      let attempted = false
      let cloneDetail = ''
      if (repo && !dryRun()) {
        let token = ''
        try {
          token = (await plyntrGitToken(brainId)).token
        } catch {
          token = ''
        }
        if (token) {
          attempted = true
          try {
            const result = await cloneBrain({
              cloneUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
              dest,
              email,
              name
            })
            cloned = result.ok
            cloneDetail = result.detail || ''
          } catch (err) {
            cloned = false
            cloneDetail = String((err as Error).message || err)
          }
          if (cloned) await stripOriginToken(dest).catch(() => undefined)
        }
      }
      if (!cloned && existed) {
        throw new Error(cloneDetail || 'That folder already has files and is not this brain. Pick another place, then try again.')
      }
      if (!cloned && attempted) removeFailedBrainCheckout(dest)
      if (!cloned) {
        await seedLocalBrain(dest)
        seeded = true
      }
    }
    if (!hasBrainMarker(dest)) throw new Error('Could not copy the client brain onto this computer.')
    switchBrain(dest)
    const acct = getAccount() || loadAccount()
    if (acct) {
      saveAccount({
        ...acct,
        folder: dest,
        source: 'plyntr',
        token: acct.token.startsWith('login:') ? acct.token : loginToken()
      })
    }
    rememberBrain({
      path: dest,
      slug,
      name: readTeamIdentity(dest)?.name || name || slug,
      role: seat?.role,
      syncMode: 'local',
      brainId,
      seatToken: seat?.seatToken
    })
    saveRecent(dest)
    stopBrainSync()
    setupTrace({ event: 'local', brainPath: dest, seeded })
    return { ok: true, brainPath: dest, seeded }
  }

  async function enableLocalSync(opts: { folder?: string; org?: string; repo?: string }) {
    const folder = String(opts.folder || currentBrainFolder() || '')
    if (!folder || readSyncMode(folder) !== 'local') {
      throw new Error('This brain is not the local-only one.')
    }
    const row = brainRowForPath(folder)
    const brainId = String(row?.brainId || '')
    if (!brainId) throw new Error('Sign in with the owner code for this brain before turning on GitHub sync.')
    const acct = getAccount() || loadAccount()
    const seat = seatForBrain(brainId)
    const joe = isJoeSuperAdmin(acct, getSettings())
    if (!canTurnOnGithubSync(seat?.role || row?.role, joe)) {
      throw new Error('Only an owner or a scout can turn on GitHub sync.')
    }
    if (dryRun()) throw new Error('This is a dry-run window. Use the packed Brain app to finish GitHub.')
    const slug = String(row?.slug || '')
    const org = String(opts.org || '').trim()
    const repo = resolvePlyntrRepoName(org, slug, opts.repo)
    if (!repo) throw new Error('This brain has no GitHub repository name yet.')
    if (seat?.role === 'owner' || (seat?.role === 'scout' && seat.bootstrap)) await ensurePlyntrRepo(brainId)
    const st = await plyntrInstalled(brainId, repo)
    if (!plyntrGithubInstallReady(st, repo)) {
      throw new Error('Install Plyntr sync on this one repo first. Choose Only select repositories.')
    }
    const bridge = await bridgeInstallStatus(repo)
    if (!bridge.installed || bridgeSelectionBlocksSync(bridge.repositorySelection)) {
      throw new Error('Install Brain Bridge on this one repo. Choose Only select repositories, not All repositories.')
    }
    writePlyntrSyncFile(folder, repo, new Date().toISOString())
    const git = await plyntrGitToken(brainId)
    if (!git.token) throw new Error('Could not get a git token for this brain.')
    const published = await publishLocalToGithub({
      folder,
      repo,
      token: git.token,
      email: seat?.email || acct?.email || '',
      name: acct?.name || ''
    })
    if (!published.ok) throw new Error(published.detail || 'Could not copy this brain to GitHub.')
    rememberBrain({
      path: folder,
      slug: slug || repo.split('/')[1]?.replace(/-brain$/, '') || '',
      name: row?.name,
      role: seat?.role || row?.role,
      syncMode: 'plyntr',
      brainId,
      seatToken: seat?.seatToken
    })
    await settleSync(folder)
    return { ok: true, detail: published.detail, repo }
  }

  ipcMain.handle('setup:putFolderPlyntr', async (_e, opts: { brainId?: string; org?: string; slug?: string; repo?: string }) =>
    putFolderPlyntr(opts)
  )
  ipcMain.handle(
    'setup:putFolderLocal',
    async (
      _e,
      opts: { brainId?: string; org?: string; slug?: string; repo?: string; email?: string; name?: string }
    ) => putFolderLocal(opts)
  )
  ipcMain.handle('setup:enableLocalSync', async (_e, opts: { folder?: string; org?: string; repo?: string }) =>
    enableLocalSync(opts || {})
  )
  ipcMain.handle('setup:syncMode', async (_e, folder: string) => readSyncMode(String(folder || '')) || '')
  ipcMain.handle('setup:openPlyntrInstall', async (_e, brainId: string, org?: string, repo?: string) => {
    setupTrace({ event: 'ipc', channel: 'setup:openPlyntrInstall' })
    if (process.env.BRAIN_APP_SETUP_DRIVE === '1') {
      return { ok: true, url: 'https://github.com/apps/plyntr-brain-sync/installations/new' }
    }
    return pinnedPlyntrInstall(brainId, org || '', repo || '')
  })
  ipcMain.handle('setup:openPlyntrRepo', async (_e, org: string, slug: string) => {
    const url = plyntrCreateRepoUrl(org, slug)
    openInApp(url, 'Create the GitHub repo')
    return { ok: true, url }
  })

  ipcMain.handle('plyntr:pending', () => {
    const create = readPendingCreate()
    const join = readPendingPlyntrJoin()
    let wizardStep = create?.wizardStep ?? 0
    if (create?.brainId && wizardStep === 7) {
      const has = listBrains().some((r) => r.brainId === create.brainId && r.path)
      if (!has) wizardStep = 6
    }
    return {
      platform: isPlatformOwnerSession(),
      create: create ? { ...create, wizardStep } : null,
      join: join
        ? {
            brainId: join.brainId,
            repo: join.repo,
            role: join.role,
            email: join.email,
            name: join.name || '',
            slug: join.slug,
            label: join.label || '',
            wizardStep: join.wizardStep
          }
        : null
    }
  })
  ipcMain.handle('plyntr:saveCreate', (_e, raw: {
    createId?: string
    wizardStep?: number
    label?: string
    org?: string
    slug?: string
    scoutEmail?: string
    brainId?: string
  }) => {
    const prev = readPendingCreate()
    writePendingCreate({
      createId: String(raw.createId || prev?.createId || `c-${Date.now()}`),
      wizardStep: Number(raw.wizardStep ?? prev?.wizardStep ?? 0),
      label: String(raw.label ?? prev?.label ?? ''),
      org: String(raw.org ?? prev?.org ?? ''),
      slug: String(raw.slug ?? prev?.slug ?? ''),
      scoutEmail: String(raw.scoutEmail ?? prev?.scoutEmail ?? ''),
      brainId: raw.brainId || prev?.brainId
    })
    return { ok: true }
  })
  ipcMain.handle('plyntr:clearCreate', () => {
    clearPendingCreate()
    return { ok: true }
  })
  ipcMain.handle('plyntr:clearJoin', () => {
    clearPendingJoinPlyntr()
    return { ok: true }
  })
  ipcMain.handle('plyntr:createBrain', async (_e, body: { label: string; org: string; slug: string; scoutEmail: string; rotate?: boolean }) => {
    if (!isPlatformOwnerSession()) throw new Error(PLATFORM_GATE)
    const session = loadOwnerSession()
    if (!session) throw new Error(PLATFORM_GATE)
    const created = await createPlyntrBrain(session.token, body)
    const hasToken = storeSetupSeat(session.email, created.brainId, created.seatToken, {
      email: String(body.scoutEmail || '').trim().toLowerCase(),
      role: 'scout',
      slug: created.slug,
      repo: created.repo
    })
    return {
      brainId: created.brainId,
      repo: created.repo,
      slug: created.slug || body.slug,
      label: created.label || body.label,
      email: body.scoutEmail,
      code: created.code,
      emailed: created.emailed,
      role: String(created.role || 'scout'),
      hasToken
    }
  })
  /** Store a company setup seat for the signed-in shell. Stores nothing without a string token, seat email and role. Signs in the platform email only when no shell is signed in. True when the vault now holds this token for the brain. */
  function storeSetupSeat(
    platformEmail: string,
    brainId: string,
    token: unknown,
    seat: { email: string; role: string; slug?: string; repo?: string }
  ): boolean {
    const id = String(brainId || '').trim()
    if (!id || typeof token !== 'string' || !token.trim() || !String(seat.email || '').trim() || !String(seat.role || '').trim()) return false
    if (!shellEmail()) signInEmailOnly(platformEmail)
    savePlyntrSeat(id, { seatToken: token, email: seat.email, role: seat.role, slug: seat.slug || '', repo: seat.repo || '' })
    return seatForBrain(id)?.seatToken === token
  }
  function platformSession(): { token: string; email: string } {
    if (!isJoeSuperAdmin(getAccount() || loadAccount(), getSettings())) {
      throw new Error('Only the Plyntr superadmin can add a company.')
    }
    if (!isPlatformOwnerSession()) throw new Error(PLATFORM_GATE)
    const session = loadOwnerSession()
    if (!session) throw new Error(PLATFORM_GATE)
    return session
  }

  ipcMain.handle('plyntr:companies', async () => listPlyntrCompanies(platformSession().token))
  ipcMain.handle('plyntr:company', async (_e, brainId: string) => readPlyntrCompany(platformSession().token, String(brainId || '')))
  ipcMain.handle(
    'plyntr:companyInvite',
    async (_e, brainId: string, body: { email: string; name: string; role: string; roots?: string[] }) =>
      invitePlyntrCompany(platformSession().token, String(brainId || ''), body)
  )
  ipcMain.handle('plyntr:claimCompany', async (_e, brainId: string) => {
    const session = platformSession()
    const claimed = await claimPlyntrCompany(session.token, String(brainId || ''))
    const hasToken = storeSetupSeat(session.email, claimed.brainId, claimed.seatToken, {
      email: claimed.email,
      role: claimed.role,
      slug: claimed.slug,
      repo: claimed.repo
    })
    return {
      brainId: claimed.brainId,
      repo: claimed.repo,
      slug: claimed.slug,
      label: claimed.label,
      email: claimed.email,
      role: claimed.role,
      code: claimed.code,
      bootstrap: claimed.bootstrap,
      hasToken
    }
  })
  ipcMain.handle('plyntr:setPack', async (_e, brainId: string, pack: string) => {
    const session = platformSession()
    return setPlyntrCompanyPack(session.token, String(brainId || ''), String(pack || ''))
  })
  ipcMain.handle('plyntr:openCompany', async (_e, body: { label: string; ownerName: string; ownerEmail: string; role?: string; pack?: string }) => {
    const session = platformSession()
    const created = await openPlyntrCompany(session.token, body)
    const hasToken = storeSetupSeat(session.email, created.brainId, created.seatToken, {
      email: created.ownerEmail,
      role: created.role,
      slug: created.slug,
      repo: created.repo
    })
    return {
      brainId: created.brainId,
      repo: created.repo,
      slug: created.slug,
      label: created.label,
      code: created.code,
      emailed: created.emailed,
      ownerEmail: created.ownerEmail,
      ownerName: created.ownerName,
      role: created.role,
      hasToken
    }
  })
  ipcMain.handle('plyntr:emailCode', async (_e, email: string) => emailPlyntrCode(email))
  ipcMain.handle('plyntr:place', async (_e, body: { brainId: string; org: string }) => {
    const placed = await placePlyntrBrain(body.brainId, body.org)
    const seat = seatForBrain(body.brainId)
    if (seat) savePlyntrSeat(body.brainId, { ...seat, slug: placed.slug || seat.slug, repo: placed.repo })
    return placed
  })
  function resumePlyntrAccount(brainId: string): { ok: boolean; email: string; role: string } {
    const seat = seatForBrain(brainId)
    if (!seat?.seatToken) return { ok: false, email: '', role: '' }
    const acct = getAccount() || loadAccount()
    if (isJoeSuperAdmin(acct, getSettings())) {
      return { ok: true, email: String(acct?.email || ''), role: String(acct?.role || '') }
    }
    if (!acct || acct.source !== 'plyntr') {
      saveAccount({
        email: seat.email,
        name: acct?.name || seat.email,
        token: loginToken(),
        role: seat.role,
        source: 'plyntr',
        folder: acct?.folder || '',
        brains: acct?.brains || []
      })
    }
    return { ok: true, email: seat.email, role: seat.role }
  }

  ipcMain.handle('plyntr:hasSeat', (_e, brainId: string) => Boolean(seatTokenForBrain(String(brainId || ''))))
  function resumeShellAccount() {
    const email = resumeVault()
    if (email) return { ok: true, email, role: '' }
    const pending = readPendingCreate()
    if (pending?.brainId && isPlatformOwnerSession()) return resumePlyntrAccount(pending.brainId)
    const join = readPendingPlyntrJoin()
    if (join?.brainId) return resumePlyntrAccount(join.brainId)
    return { ok: false, email: '', role: '' }
  }
  ipcMain.handle('plyntr:resumeAccount', () => {
    return resumeShellAccount()
  })
  ipcMain.handle('plyntr:joinProject', async (_e, code: string) => {
    if (authCodeRoute(code) !== 'plyntr') throw new Error('That code did not work.')
    return openPlyntrProject(code)
  })
  ipcMain.handle('plyntr:resolve', async (_e, code: string, typedRaw?: string) => {
    const pretendJoin = isPretendJoinCode(code)
    if (!pretendJoin && authCodeRoute(code) !== 'plyntr' && !isPlyntrCompanyCode(code)) {
      throw new Error('That code did not work.')
    }
    const resolved = await resolvePlyntrCode(normalizePlyntrInviteCode(code))
    const slug = resolved.repo.split('/')[1]?.replace(/-brain$/, '') || ''
    writePendingJoin({
      brainId: resolved.brainId,
      repo: resolved.repo,
      role: resolved.role,
      email: resolved.email,
      name: resolved.name,
      slug,
      label: resolved.label,
      bootstrap: resolved.bootstrap,
      wizardStep: 5
    })
    const brainId = resolved.brainId
    const typedEmail = String(typedRaw || '').trim().toLowerCase() || resolved.email
    const codeEmail = resolved.email
    const role = resolved.role
    const token = resolved.seatToken
    acceptBrainCode(brainId, typedEmail, codeEmail, role, token, slug, resolved.repo)
    const current = getAccount() || loadAccount()
    if (!isJoeSuperAdmin(current, getSettings())) {
      saveAccount({
        email: resolved.email,
        name: resolved.name,
        token: loginToken(),
        role: resolved.role,
        source: 'plyntr'
      })
    }
    return {
      brainId: resolved.brainId,
      repo: resolved.repo,
      role: resolved.role,
      email: resolved.email,
      name: resolved.name,
      label: resolved.label,
      slug,
      bootstrap: resolved.bootstrap,
      hasToken: Boolean(token)
    }
  })
  ipcMain.handle('plyntr:installed', async (_e, brainId: string, repo: string) => {
    const st = installPretend(repo) || (await plyntrInstalled(brainId, repo))
    return {
      ready: plyntrGithubInstallReady(st, repo),
      installed: Boolean(st.installed),
      repo: st.repo || '',
      repositorySelection: String(st.repositorySelection || ''),
      projectSeatCount: Number(st.projectSeatCount || 0)
    }
  })
  ipcMain.handle('plyntr:seats', async (_e, brainId: string) => {
    const id = String(brainId || '')
    const rows = await plyntrListSeats(id)
    const local = seatForBrain(id)
    const synced = local ? listedRoleForSeat(local, rows.seats) : null
    if (local && synced && (synced.role !== local.role || synced.bootstrap !== Boolean(local.bootstrap))) {
      savePlyntrSeat(id, { ...local, role: synced.role, bootstrap: synced.bootstrap })
    }
    return rows
  })
  ipcMain.handle('plyntr:bind', async (_e, brainId: string) => {
    const id = String(brainId || '')
    const seat = seatForBrain(id)
    const bound = await plyntrBindUntilReady(id, seat, {
      openInstall: (url) => {
        openInApp(url, 'Authorize Brain Bridge')
      }
    })
    if (bound.ok && bound.ownerToken && seat) {
      rememberBrainOwnerSession({
        email: seat.email,
        token: bound.ownerToken,
        hq_repo: bound.hq_repo || seat.repo,
        kind: 'owner'
      })
    }
    return {
      ok: bound.ok,
      hq_repo: bound.hq_repo || '',
      detail: bound.detail,
      install_url: bound.install_url,
      projects: bound.projects || []
    }
  })
  ipcMain.handle(
    'plyntr:invite',
    async (_e, brainId: string, body: { email: string; name: string; role: string; roots?: string[] }) =>
      plyntrMintInvite(brainId, body)
  )
  ipcMain.handle('plyntr:revokeSeat', async (_e, brainId: string, seatId: string) => plyntrRevokeSeat(brainId, seatId))
  ipcMain.handle('plyntr:revokeInvite', async (_e, brainId: string, inviteId: string) => plyntrRevokeInvite(brainId, inviteId))
  ipcMain.handle('plyntr:transfer', async (_e, brainId: string) => plyntrTransferScout(brainId))
  ipcMain.handle('plyntr:active', () => {
    const folder = currentBrainFolder()
    const rows = listBrains()
    const row = rows.find((r) => r.path === folder)
    const manifest = readSyncManifest(folder)
    const repo = manifest?.ok ? manifest.manifest.repo : ''
    const [org = '', repoName = ''] = repo.split('/')
    const slug = row?.slug || repoName.replace(/-brain$/, '')
    const brainId = row?.brainId || ''
    const acct = getAccount()
    const seat = brainId ? seatForBrain(brainId) : null
    const syncMode = readSyncMode(folder) || ''
    return {
      folder,
      syncMode,
      brainId,
      role: plyntrSessionRole({ seatRole: seat?.role, accountRole: acct?.role, rowRole: row?.role }),
      accountRole: String(acct?.role || ''),
      seatEmail: String(seat?.email || ''),
      hasSeat: Boolean(seatTokenForFolder(folder)),
      org,
      slug,
      label: row?.name || slug,
      scoutEmail: acct?.email || '',
      canMove: folderCanMoveToPlyntr({
        joe: isJoeSuperAdmin(acct, getSettings()),
        syncMode,
        mini: isHqMiniFolder(folder),
        hasMarker: Boolean(folder) && hasBrainMarker(folder)
      })
    }
  })
  ipcMain.handle('plyntr:move', async () => {
    const acct = getAccount() || loadAccount()
    const folder = currentBrainFolder()
    const repo = gitRemoteRepo(folder)
    const parts = brainRepoParts(repo)
    const ident = readTeamIdentity(folder)
    let issuedId = ''
    const abOnFolder = () => {
      const w = readWatching()
      return Boolean(w.watching && w.brainPath && folder && w.brainPath === folder)
    }
    return runPlyntrMove({
      joe: isJoeSuperAdmin(acct, getSettings()),
      syncMode: readSyncMode(folder),
      mini: isHqMiniFolder(folder),
      hasMarker: hasBrainMarker(folder),
      abWatching: abOnFolder,
      repo,
      installed: async () => {
        if (!issuedId || !parts) return false
        const st = await plyntrInstalled(issuedId, parts.repo)
        return plyntrGithubInstallReady(st, parts.repo)
      },
      issueToken: async () => {
        if (!parts) return { brainId: '', hasToken: false }
        if (!isPlatformOwnerSession()) throw new Error(PLATFORM_GATE)
        const session = loadOwnerSession()
        if (!session) throw new Error(PLATFORM_GATE)
        const existing = brainRowForPath(folder)
        if (existing?.brainId && seatTokenForBrain(existing.brainId)) {
          issuedId = existing.brainId
          return { brainId: existing.brainId, hasToken: true }
        }
        const body = {
          label: ident?.name || parts.slug,
          org: parts.org,
          slug: parts.slug,
          scoutEmail: String(acct?.email || session.email || '').trim().toLowerCase()
        }
        let created = await createPlyntrBrain(session.token, { ...body, rotate: Boolean(existing?.brainId) })
        if (!created.seatToken && created.brainId) {
          created = await createPlyntrBrain(session.token, { ...body, rotate: true })
        }
        issuedId = created.brainId
        if (created.seatToken) {
          savePlyntrSeat(created.brainId, {
            seatToken: created.seatToken,
            slug: parts.slug,
            email: body.scoutEmail,
            role: 'scout',
            repo: created.repo || parts.repo,
            bootstrap: true
          })
        }
        return { brainId: created.brainId, hasToken: Boolean(created.seatToken) }
      },
      openInstall: async () => {
        if (!issuedId || !parts) return
        const opened = await pinnedPlyntrInstall(issuedId, parts.org, parts.repo)
        if (!opened.ok) {
          throw new Error(opened.detail || `GitHub did not confirm the organization ${parts.org}.`)
        }
      },
      writeManifest: () => {
        if (!parts) throw new Error(MOVE_NO_REPO)
        writePlyntrSyncFile(folder, parts.repo, new Date().toISOString())
      },
      remember: (brainId) => {
        const seat = seatForBrain(brainId)
        rememberBrain({
          path: folder,
          slug: ident?.slug || parts?.slug || '',
          name: ident?.name || parts?.slug || '',
          role: seat?.role || 'scout',
          syncMode: 'plyntr',
          brainId,
          seatToken: seat?.seatToken
        })
      },
      holdSync: () => {
        stopBrainSync()
        setBrainSyncBlockedReason(folder, AB_OWNS_PLYNTR)
      },
      startSync: () => {
        startBrainSync(folder)
      },
      poll: true
    })
  })

  ipcMain.handle('ab:detect', async () => detectApp())
  ipcMain.handle('ab:install', async () => installNeed('ab'))
  ipcMain.handle('ab:watching', async () => readWatching())

  ipcMain.handle('setup:status', async (_e, kind?: AiKind) => listNeeds(kind))
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
  ipcMain.handle('files:write', async (_e, root: string, abs: string, text: string) => {
    const folder = String(root || '')
    const block = brainWriteBlock(brainIdForFolder(folder) ? roleForBrainWrite(folder) : roleForKeylessWrite(folder), folder, String(abs || ''))
    if (block) throw new Error(block)
    return writeSafe(folder, String(abs || ''), String(text ?? ''))
  })
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
      _e,
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
      const kind = payload.kind || 'grok'
      markChatBusy(payload.tabId, true)
      const onEvent = (ev: ai.StreamEvent) => {
        emitChat({
          tabId: payload.tabId,
          cli: kind,
          sessionId: payload.sessionId || payload.tabId,
          ev
        })
      }
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
  ipcMain.handle('chat:loadState', async (_e, cwd?: string) => loadAnyChats(cwd) || loadChats(cwd))
  ipcMain.handle('chat:saveState', async (_e, state: SavedChats) => {
    saveChats(rememberPhoneChats(state))
    return true
  })
  ipcMain.on('chat:saveStateSync', (e, state: SavedChats) => {
    try {
      saveChats(rememberPhoneChats(state))
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
  ipcMain.handle('chat:needs', async () => ({ filled: {}, remaining: [] }))
  ipcMain.handle('chat:firstWelcome', (_e, cwd?: string) => {
    const watching = readWatching()
    const folder = String(cwd || currentBrainFolder() || watching.brainPath || '')
    const place = folder.split(/[/\\]/).filter(Boolean).pop() || 'this brain'
    return takeFirstWelcome(folder, place)
  })
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
    const brain = currentBrainFolder()
    if (brain) {
      const blocked = brainWriteBlock(brainIdForFolder(brain) ? roleForBrainWrite(brain) : roleForKeylessWrite(brain), brain, r.filePath)
      if (blocked) throw new Error(blocked)
    }
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
