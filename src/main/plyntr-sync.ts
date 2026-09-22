import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { redact } from './clone'
import { plyntrDeviceId, seatTokenForBrain } from './plyntr-seats'
import { slugFromBusinessName } from '../shared/plyntr-invite'

const ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

export type PlyntrInstall = {
  installed?: boolean
  repositorySelection?: string
  repo?: string
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
    const code = String(body?.code || '')
    if (code !== 'TESTTEST12') fail(400, { error: 'bad', detail: 'That code did not work.' })
    return {
      seatToken: 'pbt_dry_join',
      role: 'team',
      email: 'jeen@example.com',
      name: 'Jeen',
      repo: 'plyntr-fixture/plyntr-fixture-brain',
      label: 'Plyntr fixture',
      brainId: 'dry-brain',
      bootstrap: false
    }
  }
  if (path === '/v1/github/installed') {
    return { installed: true, repositorySelection: 'selected', repo: repoQuery }
  }
  if (path === '/v1/git/token') return { token: 'pbt_dry_git', repo: repoQuery, expiresIn: 600 }
  if (path === '/v1/invites') return { inviteId: 'dry-invite', code: 'TESTTEST12', expiresAt: '2099-01-01T00:00:00.000Z' }
  if (path === '/v1/seats') return { seats: [], invites: [] }
  if (/\/revoke$/.test(path)) return { ok: true }
  fail(404, { error: 'not found' })
}

async function call(path: string, opts: { method: string; brainId?: string; body?: Record<string, unknown>; repo?: string }): Promise<unknown> {
  const repoQuery = String(opts.repo || '')
  if (dryRun()) return dryRunPlyntrWorker(path, opts.body || null, repoQuery)
  const token = opts.brainId ? seatTokenForBrain(opts.brainId) : ''
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

export async function resolvePlyntrCode(code: string): Promise<{
  seatToken: string
  role: string
  email: string
  name: string
  repo: string
  label: string
  brainId: string
  bootstrap: boolean
}> {
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

export async function plyntrMintInvite(brainId: string, body: { email: string; name: string; role: string }) {
  return call('/v1/invites', { method: 'POST', brainId, body }) as Promise<{ inviteId: string; code: string; expiresAt: string }>
}

export async function plyntrListSeats(brainId: string) {
  return call('/v1/seats', { method: 'GET', brainId }) as Promise<{
    seats: { id: string; email: string; name: string; role: string; status: string; bootstrap?: boolean }[]
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
