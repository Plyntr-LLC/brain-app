import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import * as ads2ai from './ads2ai'
import { brainRowForPath, rememberBrain } from './brains'
import { cloneBrain, defaultBrainDest } from './clone'
import { tryCodeEverywhere } from './code-fanout'
import { joinProject } from './hq-sync'
import { plyntrGitToken, plyntrInstalled, resolvePlyntrCode } from './plyntr-sync'
import { inviteTryOrder, normalizePlyntrInviteCode } from '../shared/plyntr-invite'
import { githubInstallReady, plyntrGithubInstallReady } from './setup-folder'
import { bindBrainFolder, forgetJoinedSeat, shellEmail, shellView, storeJoinedSeat } from './shell-vault'

const NOT_ON_GITHUB = 'The app is not installed on GitHub yet. Click Install in the browser, then try again.'

type Joined = { ok: true; brainPath: string; already?: boolean }

function sameOrInside(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const base = resolve(parent)
  const path = resolve(child)
  return path === base || path.startsWith(base + sep)
}

function strippedOrigin(url: string): string {
  return url
    .trim()
    .replace(/https:\/\/x-access-token:[^@]+@/gi, 'https://')
    .replace(/https:\/\/[^:]+:[^@]+@/gi, 'https://')
    .replace(/\.git$/i, '')
}

function gitOrigin(folder: string): string {
  if (!folder) return ''
  try {
    return execFileSync('/usr/bin/git', ['-C', folder, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    }).trim()
  } catch {
    return ''
  }
}

function projectMini(open: string, brainId: string): string {
  const id = String(brainId || '').replace(/[^A-Za-z0-9._-]/g, '') || 'project'
  const dest = join(homedir(), 'Projects', `${id}-mini`)
  if (sameOrInside(open, dest)) throw new Error('That folder is the brain already open on this Mac.')
  mkdirSync(dest, { recursive: true })
  return dest
}

function sameOpenBrain(open: string, repo: string, brainId: string): boolean {
  const row = open ? brainRowForPath(open) : null
  const origin = strippedOrigin(gitOrigin(open))
  const want = `https://github.com/${repo}`
  return Boolean((origin && origin === want) || (row?.brainId && row.brainId === brainId))
}

function repoText(st: { repoUrl?: string; repo?: string } | null): string {
  return String(st?.repoUrl || st?.repo || '').trim()
}

function rememberJoined(path: string, slug: string, name: string, role: string, brainId: string, token: string, syncMode?: 'plyntr' | 'agency-brain'): void {
  rememberBrain({
    path,
    slug,
    name,
    role,
    brainId,
    seatToken: token,
    ...(syncMode ? { syncMode } : {})
  })
  bindBrainFolder(path, brainId)
}

async function joinProjectSeat(open: string, email: string, code: string, brainId: string, token: string, role: string, label: string, slug: string): Promise<Joined> {
  const mini = projectMini(open, brainId)
  const joined = await joinProject({ email, code: normalizePlyntrInviteCode(code), folder: mini })
  if (sameOrInside(open, joined.brainPath)) throw new Error('That folder is the brain already open on this Mac.')
  storeJoinedSeat(brainId, email, role, token, slug, '')
  rememberJoined(joined.brainPath, slug, joined.teamName || label || slug, role, brainId, token)
  return { ok: true, brainPath: joined.brainPath }
}

async function joinCompanySeat(
  open: string,
  email: string,
  brainId: string,
  repo: string,
  role: string,
  token: string,
  slug: string,
  label: string,
  name: string
): Promise<Joined> {
  if (sameOpenBrain(open, repo, brainId)) return { ok: true, already: true, brainPath: open }
  const had = shellView().signedIn.includes(brainId)
  let held = false
  try {
    // GitHub install and the git token read the seat stored for this brain. A miss removes it again.
    storeJoinedSeat(brainId, email, role, token, slug, repo)
    held = !had
    const st = await plyntrInstalled(brainId, repo)
    if (!plyntrGithubInstallReady(st, repo)) throw new Error(NOT_ON_GITHUB)
    const git = await plyntrGitToken(brainId)
    if (!git.token) throw new Error('Could not get a git token for this brain.')
    const dest = defaultBrainDest(slug)
    const cloned = await cloneBrain({
      cloneUrl: `https://x-access-token:${git.token}@github.com/${repo}.git`,
      dest,
      email: shellEmail() || email,
      name: name || email
    })
    if (!cloned.ok) throw new Error(cloned.detail || 'Could not copy the shared folder onto this computer.')
    rememberJoined(cloned.dest, slug, label || slug, role, brainId, token, 'plyntr')
    held = false
    return { ok: true, brainPath: cloned.dest }
  } catch (err) {
    if (held) forgetJoinedSeat(brainId)
    throw err
  }
}

async function plyntrLeg(open: string, email: string, code: string): Promise<Joined> {
  const resolved = await resolvePlyntrCode(normalizePlyntrInviteCode(code))
  const slug = String(resolved.repo.split('/')[1] || '').replace(/-brain$/, '')
  if (!resolved.brainId || !resolved.seatToken) throw new Error('That code did not work.')
  if (resolved.role === 'project') {
    return joinProjectSeat(open, email, code, resolved.brainId, resolved.seatToken, resolved.role, resolved.label, slug || resolved.brainId)
  }
  if (!slug || !resolved.repo.includes('/')) throw new Error('That code did not name a brain repo.')
  return joinCompanySeat(open, email, resolved.brainId, resolved.repo, resolved.role, resolved.seatToken, slug, resolved.label, resolved.name)
}

async function agencyLeg(open: string, email: string, code: string): Promise<Joined> {
  const res = await ads2ai.verifyCode(email, code)
  const teams = (await ads2ai.myTeams(res.token)).teams || []
  const team = teams.find((row) => String(row.slug || '').trim())
  const slug = String(team?.slug || '').trim()
  if (!slug) throw new Error('That code did not name a company brain.')
  const st = await ads2ai.installStatus(slug).catch(() => null)
  if (!githubInstallReady(st)) throw new Error(NOT_ON_GITHUB)
  const repoUrl = repoText(st)
  const repo = repoUrl.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  if (repo && sameOpenBrain(open, repo, slug)) return { ok: true, already: true, brainPath: open }
  const git = await ads2ai.gitToken(res.token, slug)
  const cloneUrl = String(git.cloneUrl || git.url || '').trim()
  if (!cloneUrl) throw new Error('Could not copy the shared folder onto this computer.')
  const dest = defaultBrainDest(slug)
  const cloned = await cloneBrain({
    cloneUrl,
    dest,
    email: shellEmail() || email,
    name: res.member.name || email
  })
  if (!cloned.ok) throw new Error(cloned.detail || 'Could not copy the shared folder onto this computer.')
  const token = String(res.token || '').trim()
  storeJoinedSeat(slug, email, String(team?.role || ''), token, slug, repo)
  rememberJoined(cloned.dest, slug, String(team?.name || slug), String(team?.role || ''), slug, token, 'agency-brain')
  return { ok: true, brainPath: cloned.dest }
}

async function signinLeg(open: string, email: string, code: string): Promise<Joined> {
  return tryCodeEverywhere([
    () => agencyLeg(open, email, code),
    () => joinProjectSeat(open, email, code, 'signin-project', `local:${email}`, 'project', 'Project', 'signin-project'),
    () => plyntrLeg(open, email, code)
  ])
}

export async function joinSecondBrain(opts: { email?: string; code?: string; openFolder?: string }): Promise<Joined> {
  if (!shellEmail()) throw new Error('Sign in on this Mac first.')
  const email = String(opts.email || '').trim().toLowerCase() || shellEmail()
  const code = String(opts.code || '')
  const open = String(opts.openFolder || '').trim()
  if (!normalizePlyntrInviteCode(code)) throw new Error('Type the code from the email.')
  const order = inviteTryOrder(code, email.includes('@'))
  const legs: Record<(typeof order)[number], () => Promise<Joined>> = {
    plyntr: () => plyntrLeg(open, email, code),
    agency: () => agencyLeg(open, email, code),
    signin: () => signinLeg(open, email, code)
  }
  return tryCodeEverywhere(order.map((kind) => legs[kind]))
}
