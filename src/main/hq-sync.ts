import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { parseGithubHqRepo } from './github-repo'
import { getAccount, loadAccount } from './session-token'
import { getSettings } from './settings-store'
import { isJoeSuperAdmin } from './super-admin'

export const HQ_SYNC_ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

type Agent = {
  createApi: (opts: { origin: string; getToken: () => string }) => {
    json: (path: string, opts?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>
  }
  exchangeAndCompose: (opts: {
    origin: string
    email: string
    code: string
    miniRoot?: string
    skipService?: boolean
    nodePath?: string
    cliPath?: string
  }) => Promise<{
    ok: boolean
    detail?: string
    miniRoot?: string
    seat?: {
      seat_id: string
      kind: string
      name?: string
      email?: string
      brain_label?: string
      hq_repo?: string
      roots?: string[]
      owner_email?: string
    }
  }>
  installAgentService: (opts: { seatId: string; nodePath: string; cliPath: string; logs: string }) => unknown
  listSeats: () => string[]
  readState: (dir: string) => {
    mini_root?: string
    brain_label?: string
    origin?: string
    last_sync_at?: string
    offline?: boolean
    last_error?: string
    roots?: string[]
  } | null
  readToken: (dir: string) => string
  seatDir: (seatId: string) => string
  logDir: (seatId: string) => string
  watchLoop: (opts: { seatId: string }) => Promise<{ ok?: boolean; wiped?: boolean; message?: string }>
  randomHex: (n: number) => string
}

let agent: Agent | null = null
const watching = new Set<string>()

export function syncRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'hq-sync')
  const fromApp = join(app.getAppPath(), 'vendor', 'brain-sync')
  if (existsSync(fromApp)) return fromApp
  return join(process.cwd(), 'vendor', 'brain-sync')
}

async function loadAgent(): Promise<Agent> {
  if (agent) return agent
  const root = syncRoot()
  const src = join(root, 'app', 'src')
  const setup = (await import(pathToFileURL(join(src, 'setup.js')).href)) as Agent
  const health = (await import(pathToFileURL(join(src, 'health.js')).href)) as Agent
  const paths = (await import(pathToFileURL(join(src, 'paths.js')).href)) as Agent
  const loop = (await import(pathToFileURL(join(src, 'watch-loop.js')).href)) as Agent
  const api = (await import(pathToFileURL(join(src, 'api.js')).href)) as Agent
  const tokens = (await import(pathToFileURL(join(root, 'src', 'tokens.js')).href)) as Agent
  agent = {
    createApi: api.createApi,
    exchangeAndCompose: setup.exchangeAndCompose,
    installAgentService: setup.installAgentService,
    listSeats: health.listSeats,
    readState: setup.readState,
    readToken: setup.readToken,
    seatDir: paths.seatDir,
    logDir: paths.logDir,
    watchLoop: loop.watchLoop,
    randomHex: tokens.randomHex
  }
  return agent
}

function ownerPath(): string {
  return join(app.getPath('userData'), 'hq-owner.json')
}

export type OwnerSession = { email: string; token: string; hq_repo?: string; kind?: string }

export type PlatformBusiness = {
  id: string
  name: string
  hq_repo: string
  owners: { email: string; name: string; role: string }[]
}

export function loadOwnerSession(): OwnerSession | null {
  try {
    const raw = JSON.parse(readFileSync(ownerPath(), 'utf8')) as OwnerSession
    const email = String(raw.email || '').trim().toLowerCase()
    const token = String(raw.token || '')
    if (!email || !token) return null
    return { email, token, hq_repo: String(raw.hq_repo || ''), kind: String(raw.kind || '') }
  } catch {
    return null
  }
}

function saveOwnerSession(next: OwnerSession | null): void {
  const p = ownerPath()
  if (!next) {
    try {
      writeFileSync(p, '{}')
    } catch {
      /* */
    }
    return
  }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next))
  try {
    chmodSync(p, 0o600)
  } catch {
    /* windows */
  }
}

function deviceId(): string {
  const p = join(homedir(), '.brain-bridge', 'device_id')
  try {
    const cur = readFileSync(p, 'utf8').trim()
    if (/^[a-f0-9]{32}$/i.test(cur)) return cur
  } catch {
    /* */
  }
  return ''
}

async function ensureDeviceId(mod: Agent): Promise<string> {
  const existing = deviceId()
  if (existing) return existing
  const id = mod.randomHex(16)
  const p = join(homedir(), '.brain-bridge', 'device_id')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, id, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* */
  }
  return id
}

function cliPath(): string {
  return join(syncRoot(), 'app', 'src', 'cli.js')
}

function watchingHq(folder: string): boolean {
  if (!folder) return false
  const git = join(folder, '.git')
  return existsSync(git)
}

export function isHqMiniFolder(folder: string | null | undefined): boolean {
  if (!folder) return false
  return existsSync(folder) && !watchingHq(folder) && existsSync(join(folder, 'CLAUDE.local.md'))
}

export async function localProjectEmail(emailRaw: string): Promise<boolean> {
  const email = String(emailRaw || '').trim().toLowerCase()
  if (!email.includes('@')) return false
  const mod = await loadAgent()
  for (const id of mod.listSeats()) {
    const token = mod.readToken(mod.seatDir(id))
    const payload = payloadFromToken(token)
    if (String(payload?.email || '').trim().toLowerCase() === email) return true
  }
  return false
}

export async function existingProjectSeat(): Promise<{
  seatId: string
  folder: string
  label: string
  lastSync: string
} | null> {
  const mod = await loadAgent()
  const ids = mod.listSeats()
  for (const id of ids) {
    const state = mod.readState(mod.seatDir(id))
    const token = mod.readToken(mod.seatDir(id))
    if (!state?.mini_root || !token) continue
    if (!existsSync(state.mini_root)) continue
    return {
      seatId: id,
      folder: state.mini_root,
      label: String(state.brain_label || id),
      lastSync: String(state.last_sync_at || '')
    }
  }
  return null
}

async function startWatch(seatId: string): Promise<void> {
  if (watching.has(seatId)) return
  const mod = await loadAgent()
  watching.add(seatId)
  if (app.isPackaged) {
    try {
      mod.installAgentService({
        seatId,
        nodePath: process.execPath,
        cliPath: cliPath(),
        logs: mod.logDir(seatId)
      })
      return
    } catch (err) {
      console.error(err)
    }
  }
  void mod.watchLoop({ seatId }).catch((err) => {
    watching.delete(seatId)
    console.error(err)
  })
}

function payloadFromToken(token: string): { email?: string; kind?: string; hq_repo?: string } | null {
  try {
    const body = String(token || '').split('.')[0]
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      email?: string
      kind?: string
      hq_repo?: string
    }
  } catch {
    return null
  }
}

export async function openExistingSeat(): Promise<{
  ok: boolean
  email: string
  name: string
  role: 'project'
  brainPath: string
  teamName: string
  teamSlug: string
  roots: string[]
}> {
  const seat = await existingProjectSeat()
  if (!seat) throw new Error('No project brain on this computer yet.')
  const mod = await loadAgent()
  const token = mod.readToken(mod.seatDir(seat.seatId))
  const payload = payloadFromToken(token)
  const email = String(payload?.email || '').trim().toLowerCase()
  if (!email.includes('@')) throw new Error('That project folder has no sign-in on this computer. Enter the invite code.')
  if (payload?.kind && payload.kind !== 'client-project') {
    throw new Error('This sign-in is for project people.')
  }
  const state = mod.readState(mod.seatDir(seat.seatId))
  await startWatch(seat.seatId)
  return {
    ok: true,
    email,
    name: email.split('@')[0],
    role: 'project',
    brainPath: seat.folder,
    teamName: seat.label,
    teamSlug: String(payload?.hq_repo || '').split('/')[1] || 'brain',
    roots: state?.roots || []
  }
}

export async function ensureHqSyncAgent(): Promise<{ ok: boolean; folder?: string; label?: string }> {
  const seat = await existingProjectSeat()
  if (!seat) return { ok: false }
  await startWatch(seat.seatId)
  return { ok: true, folder: seat.folder, label: seat.label }
}

export type HqAgentHealth = {
  present: boolean
  label: string
  lastSync: string
  offline: boolean
  error: string
}

export async function hqAgentHealth(): Promise<HqAgentHealth> {
  const empty: HqAgentHealth = { present: false, label: '', lastSync: '', offline: false, error: '' }
  try {
    const mod = await loadAgent()
    for (const id of mod.listSeats()) {
      const state = mod.readState(mod.seatDir(id))
      if (!state?.mini_root) continue
      return {
        present: true,
        label: String(state.brain_label || id),
        lastSync: String(state.last_sync_at || ''),
        offline: Boolean(state.offline),
        error: String(state.last_error || '')
      }
    }
  } catch {
    /* vendor missing in tests */
  }
  return empty
}

export async function requestHqCode(email: string): Promise<{ ok: boolean }> {
  const key = String(email || '').trim().toLowerCase()
  if (!key.includes('@')) throw new Error('Type your work email first.')
  const mod = await loadAgent()
  const api = mod.createApi({ origin: HQ_SYNC_ORIGIN, getToken: () => '' })
  await api.json('/auth/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: key })
  })
  return { ok: true }
}

export async function joinProject(opts: {
  email: string
  code: string
  folder?: string
}): Promise<{
  ok: boolean
  email: string
  name: string
  role: 'project'
  brainPath: string
  teamName: string
  teamSlug: string
  roots: string[]
}> {
  const email = String(opts.email || '').trim().toLowerCase()
  const code = String(opts.code || '').replace(/\s/g, '')
  if (!email.includes('@')) throw new Error('Type the email you were invited with.')
  if (code.length < 4) throw new Error('Type the six-digit code from the second email.')
  const mod = await loadAgent()
  const out = await mod.exchangeAndCompose({
    origin: HQ_SYNC_ORIGIN,
    email,
    code,
    miniRoot: opts.folder || undefined,
    skipService: true,
    nodePath: process.execPath,
    cliPath: cliPath()
  })
  if (!out.ok) throw new Error(out.detail || 'That code did not work.')
  if (out.seat?.kind === 'owner' || out.seat?.kind === 'platform') {
    throw new Error('This sign-in is for project people. Owners add people in Settings.')
  }
  const mini = String(out.miniRoot || '')
  if (!mini) throw new Error('Could not make the project folder.')
  if (watchingHq(mini)) throw new Error('That folder looks like a full git clone. Project people never clone HQ.')
  await startWatch(String(out.seat?.seat_id || ''))
  return {
    ok: true,
    email,
    name: String(out.seat?.name || email),
    role: 'project',
    brainPath: mini,
    teamName: String(out.seat?.brain_label || 'Brain'),
    teamSlug: String(out.seat?.hq_repo || '').split('/')[1] || 'brain',
    roots: out.seat?.roots || []
  }
}

async function ownerApi(token?: string) {
  const mod = await loadAgent()
  const session = loadOwnerSession()
  const t = token || session?.token || ''
  return mod.createApi({ origin: HQ_SYNC_ORIGIN, getToken: () => t })
}

export async function ownerLogin(opts: { email: string; code: string }): Promise<{
  ok: boolean
  email: string
  kind: string
  hq_repo: string
  brain_label: string
}> {
  const email = String(opts.email || '').trim().toLowerCase()
  const code = String(opts.code || '').replace(/\s/g, '')
  const mod = await loadAgent()
  const api = mod.createApi({ origin: HQ_SYNC_ORIGIN, getToken: () => '' })
  const device_id = await ensureDeviceId(mod)
  const res = await api.json('/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code, device_id })
  })
  if (!res.ok) {
    throw new Error(String((res.body && (res.body.detail || res.body.error)) || 'That code did not work.'))
  }
  const seat = (res.body.seat || {}) as { kind?: string; hq_repo?: string; brain_label?: string; name?: string }
  const token = String(res.body.seat_token || '')
  if (!token) throw new Error('No session came back.')
  if (seat.kind === 'client-project') {
    throw new Error('That email is a project person. They sign in on the first screen, not in Settings.')
  }
  const kind = String(seat.kind || 'owner')
  saveOwnerSession({ email, token, hq_repo: String(seat.hq_repo || ''), kind })
  return {
    ok: true,
    email,
    kind,
    hq_repo: String(seat.hq_repo || ''),
    brain_label: String(seat.brain_label || '')
  }
}

function emptyOwnerStatus(): {
  signedIn: boolean
  email: string
  kind: string
  hq_repo: string
  brain_label: string
  projects: { slug: string; path: string }[]
  seats: {
    seat_id: string
    email: string
    name: string
    status: string
    roots: string[]
    kind: string
  }[]
  businesses: PlatformBusiness[]
} {
  return {
    signedIn: false,
    email: '',
    kind: '',
    hq_repo: '',
    brain_label: '',
    projects: [],
    seats: [],
    businesses: []
  }
}

export async function ownerStatus(): Promise<{
  signedIn: boolean
  email: string
  kind: string
  hq_repo: string
  brain_label: string
  projects: { slug: string; path: string }[]
  seats: {
    seat_id: string
    email: string
    name: string
    status: string
    roots: string[]
    kind: string
  }[]
  businesses: PlatformBusiness[]
}> {
  const session = loadOwnerSession()
  if (!session) return emptyOwnerStatus()
  const api = await ownerApi(session.token)
  const plat = await api.json('/platform/status')
  const businesses = plat.ok && Array.isArray(plat.body.businesses) ? (plat.body.businesses as PlatformBusiness[]) : []
  const st = await api.json('/owner/status')
  if (plat.ok && !st.ok) {
    if (session.kind !== 'platform') saveOwnerSession({ ...session, kind: 'platform' })
    return {
      ...emptyOwnerStatus(),
      signedIn: true,
      email: session.email,
      kind: 'platform',
      businesses
    }
  }
  if (!st.ok) {
    saveOwnerSession(null)
    return emptyOwnerStatus()
  }
  const projects = await api.json('/owner/projects')
  const seats = await api.json('/owner/seats')
  const hq = String(st.body.hq_repo || session.hq_repo || '')
  if (hq && hq !== session.hq_repo) saveOwnerSession({ ...session, hq_repo: hq })
  const fromSeats = Array.isArray(seats.body.seats) ? seats.body.seats : []
  const fromStatus = Array.isArray(st.body.people) ? st.body.people : []
  const rows = (fromSeats.length ? fromSeats : fromStatus) as {
    seat_id: string
    email: string
    name: string
    status: string
    roots?: string[]
    kind: string
    projects?: string[]
  }[]
  return {
    signedIn: true,
    email: session.email,
    kind: String(session.kind || 'owner'),
    hq_repo: hq,
    brain_label: String(st.body.brain_label || ''),
    businesses,
    projects: Array.isArray(projects.body.projects)
      ? (projects.body.projects as { slug: string; path: string }[])
      : Array.isArray(st.body.projects)
        ? (st.body.projects as { slug: string; path: string }[])
        : [],
    seats: rows.map((p) => ({
      seat_id: p.seat_id,
      email: p.email,
      name: p.name,
      status: p.status,
      kind: p.kind,
      roots: p.roots || (p.projects || []).map((slug) => `projects/${slug}/`)
    }))
  }
}

function assertJoeSuper(): void {
  if (!isJoeSuperAdmin(getAccount() || loadAccount(), getSettings())) {
    throw new Error('Only the superadmin can add a company.')
  }
}

export async function addCompany(opts: {
  name: string
  email: string
  owner_name: string
  role?: string
}): Promise<{ ok: true; business: PlatformBusiness; detail: string }> {
  assertJoeSuper()
  const session = loadOwnerSession()
  if (!session) {
    throw new Error('Sign in for project sync first. Use joe@plyntr.com and the code from your email.')
  }
  const api = await ownerApi(session.token)
  const res = await api.json('/platform/businesses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: String(opts.name || '').trim(),
      email: String(opts.email || '')
        .trim()
        .toLowerCase(),
      owner_name: String(opts.owner_name || '').trim(),
      role: opts.role === 'scout' ? 'scout' : 'owner'
    })
  })
  if (!res.ok) {
    throw new Error(String((res.body && (res.body.detail || res.body.error)) || 'Could not add that company.'))
  }
  const business = (res.body.business || {}) as PlatformBusiness
  return { ok: true, business, detail: 'Login email sent.' }
}

export function hqRepoFromFolder(folder: string): string {
  const root = String(folder || '').trim()
  if (!root || !existsSync(join(root, '.git'))) return ''
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 4000
    }).trim()
    return parseGithubHqRepo(url)
  } catch {
    return ''
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function ownerBindUntilReady(
  hqRepo: string,
  opts?: { openInstall?: (url: string) => void; timeoutMs?: number }
): Promise<{
  ok: boolean
  hq_repo?: string
  install_url?: string
  detail: string
  projects?: string[]
}> {
  const repo = parseGithubHqRepo(hqRepo) || String(hqRepo || '').trim()
  if (!repo.includes('/')) throw new Error('Paste owner/name, like acme-org/acme-hq-brain')
  const until = Date.now() + (opts?.timeoutMs ?? 120000)
  let opened = false
  while (true) {
    const res = await ownerBind(repo)
    if (res.ok) return res
    if (!res.install_url) return res
    if (!opened) {
      opts?.openInstall?.(res.install_url)
      opened = true
    }
    if (Date.now() >= until) {
      return {
        ...res,
        detail: 'GitHub is not on that repo yet. Authorize Brain Bridge on that one repo, then Connect this HQ again.'
      }
    }
    await wait(2000)
  }
}

export async function ownerBind(hqRepo: string): Promise<{
  ok: boolean
  hq_repo?: string
  install_url?: string
  detail: string
  projects?: string[]
}> {
  const session = loadOwnerSession()
  if (!session) throw new Error('Sign in for project sync first.')
  const api = await ownerApi(session.token)
  const res = await api.json('/owner/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hq_repo: String(hqRepo || '').trim() })
  })
  if (res.status === 409 && res.body.install_url) {
    return {
      ok: false,
      install_url: String(res.body.install_url),
      hq_repo: String(res.body.hq_repo || hqRepo),
      detail: String(res.body.detail || 'Authorize Brain Bridge on that one repo, then come back.')
    }
  }
  if (!res.ok) {
    throw new Error(String(res.body.detail || res.body.error || 'Could not connect that repo.'))
  }
  saveOwnerSession({ ...session, hq_repo: String(res.body.hq_repo || hqRepo) })
  return {
    ok: true,
    hq_repo: String(res.body.hq_repo || hqRepo),
    projects: Array.isArray(res.body.projects) ? (res.body.projects as string[]) : [],
    detail: 'Connected.'
  }
}

export async function addProjectSeat(opts: {
  name: string
  email: string
  roots: string[]
}): Promise<{ ok: boolean; detail: string; seat_id?: string }> {
  const session = loadOwnerSession()
  if (!session) throw new Error('Sign in for project sync first. Settings will email you a code.')
  const roots = (opts.roots || []).map((r) => {
    const s = String(r || '').trim().replace(/^\/+|\/+$/g, '')
    if (s.startsWith('projects/')) return `${s}/`
    return `projects/${s}/`
  })
  if (!roots.length) throw new Error('Tick at least one project.')
  const api = await ownerApi(session.token)
  const res = await api.json('/owner/seats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: String(opts.name || '').trim(),
      email: String(opts.email || '').trim().toLowerCase(),
      roots
    })
  })
  if (!res.ok) {
    throw new Error(String(res.body.detail || res.body.error || 'Could not add that person.'))
  }
  const seat = (res.body.seat || {}) as { seat_id?: string; email?: string }
  return {
    ok: true,
    seat_id: seat.seat_id,
    detail: `${opts.name || seat.email} will get an invite. They open this app, type their email and the code, and only those folders land on their computer.`
  }
}

export async function revokeProjectSeat(seatId: string): Promise<{ ok: boolean; detail: string }> {
  const session = loadOwnerSession()
  if (!session) throw new Error('Sign in for project sync first.')
  const id = String(seatId || '').trim()
  if (!id) throw new Error('Missing seat.')
  const api = await ownerApi(session.token)
  const res = await api.json(`/owner/seats/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' })
  if (!res.ok) throw new Error(String(res.body.detail || res.body.error || 'Could not remove access.'))
  return { ok: true, detail: 'Access removed. Their next sync deletes those folders and leaves personal/ alone.' }
}
