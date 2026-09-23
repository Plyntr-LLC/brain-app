import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { redact } from './clone'
import { plyntrDeviceId, savePlyntrSeat, seatForBrain, seatTokenForBrain } from './plyntr-seats'
import { listedRoleForSeat, transferUsesOwnerToken } from '../shared/plyntr-transfer'
import { normalizePlyntrInviteCode, slugFromBusinessName } from '../shared/plyntr-invite'
import { dryRunInstalledBody, dryRunPlyntrBind, dryRunProjectInvite, type PlyntrBindActor } from './plyntr-dry-run'

const ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

export type PlyntrInstall = {
  installed?: boolean
  repositorySelection?: string
  repo?: string
  projectSeatCount?: number
}

export type PlyntrResolved = {
  seatToken: string
  role: string
  email: string
  name: string
  repo: string
  label: string
  brainId: string
  bootstrap: boolean
  roots?: string[]
}

function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

function fixtureRoot(): string {
  const candidates = [
    join(process.cwd(), 'resources/fixtures/plyntr-brain'),
    join(__dirname, '../../resources/fixtures/plyntr-brain')
  ]
  return candidates.find((p) => existsSync(p)) || candidates[0]
}

function fail(status: number, body: { error?: string; detail?: string }): never {
  const code = String(body.error || '')
  if (status === 409 && code === 'repo_missing') {
    throw new Error('Create the empty repo on GitHub first, then try again.')
  }
  if (status === 410 && code === 'used') throw new Error('That code was already used.')
  if (status === 410) throw new Error('That code was revoked.')
  if (status === 429 || code === 'rate') throw new Error('That code did not work.')
  const detail = redact(String(body.detail || body.error || 'Plyntr sync could not finish that.'))
  throw new Error(detail)
}

function dryRunPlyntrWorker(path: string, body: Record<string, unknown> | null, repoQuery: string): unknown {
  if (path === '/v1/companies' && body) {
    const role = String(body.role || 'owner')
    return {
      brainId: 'dry-brain',
      repo: 'pending/dry-brain',
      slug: slugFromBusinessName(String(body.label || 'dry')),
      label: String(body.label || 'Dry'),
      seatToken: 'pbt_dry_scout',
      code: role === 'owner' ? '184392' : 'TESTTEST12',
      role,
      emailed: true,
      ownerEmail: String(body.ownerEmail || ''),
      ownerName: String(body.ownerName || '')
    }
  }
  if (path === '/v1/companies') {
    return { companies: [] }
  }
  if (/^\/v1\/companies\/[^/]+$/.test(path)) {
    return {
      brainId: 'dry-brain',
      label: 'Dry',
      slug: 'dry',
      org: 'pending',
      repo: 'pending/dry-brain',
      seats: [],
      invites: []
    }
  }
  if (/^\/v1\/companies\/[^/]+\/invites$/.test(path)) {
    return { inviteId: 'dry-invite', code: 'TESTTEST12', expiresAt: '2099-01-01T00:00:00.000Z', emailed: false }
  }
  if (/^\/v1\/companies\/[^/]+\/mac$/.test(path)) {
    return {
      brainId: 'dry-brain',
      seatToken: 'pbt_dry_scout',
      role: 'scout',
      email: 'joe@plyntr.com',
      repo: 'pending/dry-brain',
      slug: 'dry',
      label: 'Dry',
      bootstrap: true
    }
  }
  if (path === '/v1/codes/email') {
    const email = String(body?.email || '')
    if (email === 'ada@example.com') return { ok: true, emailed: true }
    fail(404, { error: 'unknown', detail: 'That email is not on a company yet.' })
  }
  if (/^\/v1\/brains\/[^/]+\/place$/.test(path) && body) {
    const org = String(body.org || 'dry-org')
    return { ok: true, org, slug: 'dry', repo: `${org}/dry-brain` }
  }
  if (path === '/v1/brains' && body) {
    const slug = slugFromBusinessName(String(body.slug || body.label || 'dry'))
    const org = String(body.org || 'dry-org')
    return {
      brainId: 'dry-brain',
      repo: `${org}/${slug}-brain`,
      seatToken: body.rotate ? 'pbt_dry_scout' : 'pbt_dry_scout',
      role: 'scout',
      bootstrap: true
    }
  }
  if (/^\/v1\/brains\/[^/]+\/ensure-repo$/.test(path)) return { ok: true }
  if (path === '/v1/invites/resolve') {
    const code = normalizePlyntrInviteCode(String(body?.code || ''))
    if (code === 'PR0J3CT12X') {
      return {
        seatToken: '',
        role: 'project',
        email: 'pat@example.com',
        name: 'Pat',
        repo: 'plyntr-fixture/plyntr-fixture-brain',
        label: 'Plyntr fixture',
        brainId: 'dry-brain',
        bootstrap: false,
        roots: ['projects/fixture/']
      }
    }
    if (code !== 'TESTTEST12') fail(400, { error: 'bad', detail: 'That code did not work.' })
    return {
      seatToken: 'pbt_dry_scout',
      role: 'scout',
      email: 'joe@plyntr.com',
      name: 'Joe',
      repo: 'plyntr-fixture/plyntr-fixture-brain',
      label: 'Plyntr fixture',
      brainId: 'dry-brain',
      bootstrap: true
    }
  }
  if (path === '/v1/github/installed') {
    return dryRunInstalledBody(repoQuery)
  }
  if (path === '/v1/git/token') return { token: 'pbt_dry_git', repo: repoQuery, expiresIn: 600 }
  if (path === '/v1/invites') {
    if (body?.role === 'project') {
      const minted = dryRunProjectInvite(body.roots)
      if (!minted.ok) fail(400, { error: 'invalid', detail: minted.detail })
      return {
        inviteId: minted.inviteId,
        code: minted.code,
        expiresAt: minted.expiresAt,
        needsBridge: minted.needsBridge,
        projectSeatCount: minted.projectSeatCount,
        emailed: false
      }
    }
    return { inviteId: 'dry-invite', code: 'TESTTEST12', expiresAt: '2099-01-01T00:00:00.000Z', emailed: false }
  }
  if (path === '/v1/seats') return { seats: [], invites: [] }
  if (/^\/v1\/brains\/[^/]+\/transfer$/.test(path)) {
    return { ok: true, removed: true, email: 'scout@example.com' }
  }
  if (/\/revoke$/.test(path)) return { ok: true }
  fail(404, { error: 'not found' })
}

async function call(path: string, opts: { method: string; brainId?: string; body?: Record<string, unknown>; repo?: string; token?: string }): Promise<unknown> {
  const repoQuery = String(opts.repo || '')
  if (dryRun()) return dryRunPlyntrWorker(path, opts.body || null, repoQuery)
  const token = opts.token || (opts.brainId ? seatTokenForBrain(opts.brainId) : '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const url = new URL(path, ORIGIN)
  if (opts.repo) url.searchParams.set('repo', opts.repo)
  if (path.includes('/github/installed')) url.searchParams.set('app', 'plyntr-brain-sync')
  const r = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!r.ok) fail(r.status, body)
  return body
}

export async function createPlyntrBrain(
  platformToken: string,
  body: { label: string; org: string; slug: string; scoutEmail: string; rotate?: boolean }
): Promise<{ brainId: string; repo: string; seatToken: string | null; role?: string; bootstrap?: boolean }> {
  if (dryRun()) return dryRunPlyntrWorker('/v1/brains', body, '') as never
  const r = await fetch(`${ORIGIN}/v1/brains`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformToken}` },
    body: JSON.stringify(body)
  })
  const parsed = (await r.json().catch(() => ({}))) as { error?: string; detail?: string; brainId?: string; repo?: string; seatToken?: string | null }
  if (!r.ok) fail(r.status, parsed)
  return {
    brainId: String(parsed.brainId || ''),
    repo: String(parsed.repo || ''),
    seatToken: parsed.seatToken ? String(parsed.seatToken) : null,
    role: 'scout',
    bootstrap: true
  }
}

async function platformCall(platformToken: string, path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (dryRun()) return dryRunPlyntrWorker(path, body || null, '') as Record<string, unknown>
  const r = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformToken}` },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = (await r.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!r.ok) fail(r.status, json)
  return json as Record<string, unknown>
}

export type PlyntrCompanyRow = { brainId: string; label: string; slug: string; org: string; repo: string; createdAt: string }

export async function listPlyntrCompanies(platformToken: string): Promise<PlyntrCompanyRow[]> {
  const parsed = await platformCall(platformToken, '/v1/companies', 'GET')
  const rows = Array.isArray(parsed.companies) ? parsed.companies : []
  return rows.map((row) => {
    const c = row as Record<string, unknown>
    return {
      brainId: String(c.brainId || ''),
      label: String(c.label || ''),
      slug: String(c.slug || ''),
      org: String(c.org || ''),
      repo: String(c.repo || ''),
      createdAt: String(c.createdAt || '')
    }
  })
}

export async function readPlyntrCompany(platformToken: string, brainId: string): Promise<Record<string, unknown>> {
  return platformCall(platformToken, `/v1/companies/${encodeURIComponent(brainId)}`, 'GET')
}

export async function invitePlyntrCompany(
  platformToken: string,
  brainId: string,
  body: { email: string; name: string; role: string; roots?: string[] }
): Promise<{ code: string; emailed: boolean; pendingFolders: boolean }> {
  const parsed = await platformCall(platformToken, `/v1/companies/${encodeURIComponent(brainId)}/invites`, 'POST', body)
  return { code: String(parsed.code || ''), emailed: Boolean(parsed.emailed), pendingFolders: Boolean(parsed.pendingFolders) }
}

export async function claimPlyntrCompany(
  platformToken: string,
  brainId: string
): Promise<{ brainId: string; seatToken: string; role: string; email: string; repo: string; slug: string; label: string; bootstrap: boolean }> {
  const parsed = await platformCall(platformToken, `/v1/companies/${encodeURIComponent(brainId)}/mac`, 'POST', {})
  return {
    brainId: String(parsed.brainId || brainId),
    seatToken: String(parsed.seatToken || ''),
    role: String(parsed.role || 'scout'),
    email: String(parsed.email || ''),
    repo: String(parsed.repo || ''),
    slug: String(parsed.slug || ''),
    label: String(parsed.label || ''),
    bootstrap: Boolean(parsed.bootstrap)
  }
}

export async function openPlyntrCompany(
  platformToken: string,
  body: { label: string; ownerName: string; ownerEmail: string; role?: string }
): Promise<{ brainId: string; repo: string; slug: string; label: string; seatToken: string; code: string; emailed: boolean; ownerEmail: string; ownerName: string; role: string }> {
  const parsed = (dryRun()
    ? dryRunPlyntrWorker('/v1/companies', body, '')
    : await (async () => {
        const r = await fetch(`${ORIGIN}/v1/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformToken}` },
          body: JSON.stringify(body)
        })
        const json = (await r.json().catch(() => ({}))) as { error?: string; detail?: string }
        if (!r.ok) fail(r.status, json)
        return json
      })()) as {
    brainId?: string
    repo?: string
    slug?: string
    label?: string
    seatToken?: string
    code?: string
    emailed?: boolean
    ownerEmail?: string
    ownerName?: string
    role?: string
  }
  return {
    brainId: String(parsed.brainId || ''),
    repo: String(parsed.repo || ''),
    slug: String(parsed.slug || ''),
    label: String(parsed.label || body.label),
    seatToken: String(parsed.seatToken || ''),
    code: String(parsed.code || ''),
    emailed: Boolean(parsed.emailed),
    ownerEmail: String(parsed.ownerEmail || body.ownerEmail),
    ownerName: String(parsed.ownerName || body.ownerName),
    role: String(parsed.role || body.role || 'owner')
  }
}

export async function emailPlyntrCode(email: string): Promise<{ ok: boolean; emailed: boolean; role: string }> {
  const parsed = (await call('/v1/codes/email', { method: 'POST', body: { email } })) as { emailed?: boolean; role?: string }
  return { ok: true, emailed: Boolean(parsed.emailed), role: String(parsed.role || '') }
}

export async function placePlyntrBrain(brainId: string, org: string): Promise<{ repo: string; slug: string; org: string }> {
  const parsed = (await call(`/v1/brains/${encodeURIComponent(brainId)}/place`, {
    method: 'POST',
    brainId,
    body: { org }
  })) as { repo?: string; slug?: string; org?: string }
  return { repo: String(parsed.repo || ''), slug: String(parsed.slug || ''), org: String(parsed.org || org) }
}

export async function ensurePlyntrRepo(brainId: string): Promise<{ ok: boolean }> {
  await call(`/v1/brains/${encodeURIComponent(brainId)}/ensure-repo`, { method: 'POST', brainId, body: {} })
  return { ok: true }
}

export async function plyntrInstalled(brainId: string, repo: string): Promise<PlyntrInstall> {
  return (await call('/v1/github/installed', { method: 'GET', brainId, repo })) as PlyntrInstall
}

export async function plyntrGitToken(brainId: string): Promise<{ token: string; repo: string }> {
  const body = (await call('/v1/git/token', { method: 'POST', brainId, body: {} })) as { token?: string; repo?: string }
  return { token: String(body.token || ''), repo: String(body.repo || '') }
}

export function dryRunProjectFolder(resolved: PlyntrResolved): {
  ok: true
  email: string
  name: string
  role: 'project'
  brainPath: string
  teamName: string
  teamSlug: string
  roots: string[]
} {
  const dest = join(homedir(), 'Projects', 'plyntr-project-dry-run')
  mkdirSync(dest, { recursive: true })
  return {
    ok: true,
    email: resolved.email,
    name: resolved.name,
    role: 'project',
    brainPath: dest,
    teamName: resolved.label || 'Brain',
    teamSlug: resolved.repo.split('/')[1] || 'brain',
    roots: resolved.roots || []
  }
}

export async function resolvePlyntrCode(code: string): Promise<PlyntrResolved> {
  if (dryRun()) {
    return dryRunPlyntrWorker('/v1/invites/resolve', { code }, '') as never
  }
  const r = await fetch(`${ORIGIN}/v1/invites/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceId: plyntrDeviceId() })
  })
  const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string }
  if (!r.ok) fail(r.status, body)
  return body as never
}

export type PlyntrBindResult = {
  ok: boolean
  hq_repo?: string
  install_url?: string
  detail: string
  projects?: string[]
  ownerToken?: string
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function plyntrBindOnce(brainId: string, actor: (PlyntrBindActor & { repo?: string }) | null): Promise<PlyntrBindResult> {
  const repo = String(actor?.repo || '')
  if (dryRun()) return dryRunPlyntrBind(repo, actor)
  const token = seatTokenForBrain(brainId)
  if (!token) return { ok: false, hq_repo: repo, detail: 'company login only' }
  const r = await fetch(`${ORIGIN}/v1/brains/${encodeURIComponent(brainId)}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}'
  })
  const body = (await r.json().catch(() => ({}))) as {
    error?: string
    detail?: string
    hq_repo?: string
    install_url?: string
    projects?: string[]
    ownerToken?: string
  }
  if (r.status === 409 && body.install_url) {
    return {
      ok: false,
      hq_repo: String(body.hq_repo || repo),
      install_url: String(body.install_url),
      detail: String(body.detail || 'Authorize Brain Bridge on that one repo, then come back.')
    }
  }
  if (!r.ok) fail(r.status, body)
  return {
    ok: true,
    hq_repo: String(body.hq_repo || repo),
    projects: Array.isArray(body.projects) ? body.projects : [],
    detail: String(body.detail || 'Connected.'),
    ownerToken: body.ownerToken ? String(body.ownerToken) : undefined
  }
}

export async function plyntrBindUntilReady(
  brainId: string,
  actor: (PlyntrBindActor & { repo?: string }) | null,
  opts?: { openInstall?: (url: string) => void; timeoutMs?: number }
): Promise<PlyntrBindResult> {
  const until = Date.now() + (opts?.timeoutMs ?? 120000)
  let opened = false
  while (true) {
    const res = await plyntrBindOnce(brainId, actor)
    if (res.ok || !res.install_url) return res
    if (!opened) {
      opts?.openInstall?.(res.install_url)
      opened = true
    }
    if (Date.now() >= until) {
      return {
        ...res,
        detail: 'GitHub is not on that repo yet. Authorize Brain Bridge on that one repo, then Connect this brain again.'
      }
    }
    await wait(2000)
  }
}

export async function plyntrMintInvite(
  brainId: string,
  body: { email: string; name: string; role: string; roots?: string[] }
) {
  return call('/v1/invites', { method: 'POST', brainId, body }) as Promise<{
    inviteId: string
    code: string
    expiresAt: string
    emailed?: boolean
    needsBridge?: boolean
    projectSeatCount?: number
  }>
}

export async function plyntrTransferScout(brainId: string) {
  const seat = seatForBrain(brainId)
  if (!seat?.seatToken) throw new Error('Only the owner can remove the Plyntr scout.')
  let seats: { email: string; role: string; status: string; plyntrScout?: boolean; bootstrap?: boolean }[] | null = null
  if (!dryRun()) {
    const listed = await plyntrListSeats(brainId)
    seats = listed.seats
    const synced = listedRoleForSeat(seat, listed.seats)
    if (synced && (synced.role !== seat.role || synced.bootstrap !== Boolean(seat.bootstrap))) {
      savePlyntrSeat(brainId, { ...seat, role: synced.role, bootstrap: synced.bootstrap })
      seat.role = synced.role
    }
  }
  const gate = transferUsesOwnerToken({
    seatRole: seat.role,
    seatEmail: seat.email,
    seatToken: seat.seatToken,
    seats
  })
  if (!gate.ok) throw new Error(gate.detail)
  return call(`/v1/brains/${encodeURIComponent(brainId)}/transfer`, {
    method: 'POST',
    brainId,
    body: {},
    token: gate.token
  }) as Promise<{
    ok: boolean
    removed?: boolean
    email?: string
  }>
}

export async function plyntrListSeats(brainId: string) {
  return call('/v1/seats', { method: 'GET', brainId }) as Promise<{
    seats: {
      id: string
      email: string
      name: string
      role: string
      status: string
      bootstrap?: boolean
      plyntrScout?: boolean
    }[]
    invites: { inviteId: string; email: string; name: string; role: string; status: string; expiresAt: string }[]
  }>
}

export async function plyntrRevokeSeat(brainId: string, seatId: string) {
  await call(`/v1/seats/${encodeURIComponent(seatId)}/revoke`, { method: 'POST', brainId, body: {} })
  return { ok: true }
}

export async function plyntrRevokeInvite(brainId: string, inviteId: string) {
  await call(`/v1/invites/${encodeURIComponent(inviteId)}/revoke`, { method: 'POST', brainId, body: {} })
  return { ok: true }
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('git init failed'))))
  })
}

export async function copyDryRunFixture(opts: { dest: string; org: string; slug: string }): Promise<void> {
  const dest = opts.dest
  mkdirSync(dest, { recursive: true })
  cpSync(fixtureRoot(), dest, { recursive: true })
  const repo = `${opts.org}/${opts.slug}-brain`
  const syncPath = join(dest, '.team-config', 'sync.json')
  const sync = JSON.parse(readFileSync(syncPath, 'utf8')) as Record<string, unknown>
  sync.version = 1
  sync.mode = 'plyntr'
  sync.repo = repo
  sync.githubApp = 'plyntr-brain-sync'
  writeFileSync(syncPath, JSON.stringify(sync, null, 2))
  await git(dest, ['init'])
  await git(dest, ['remote', 'remove', 'origin']).catch(() => {})
  await git(dest, ['remote', 'add', 'origin', `https://github.com/${repo}.git`])
}
