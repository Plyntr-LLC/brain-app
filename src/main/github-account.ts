import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { extraPath, binEnv } from './ai-cli'
import { ghCliDetail, orgIdFromGraphql, orgLoginCandidates, parseGithubHqRepo, parseGithubOrgLogin, resolvePlyntrRepoName, repoIdFromGh } from './github-repo'

const execFileAsync = promisify(execFile)

type GhRun = {
  bin: string | null
  status: number | null
  stdout: string
  stderr: string
  error?: string
}

export async function lookupGithubAccount(login: string): Promise<{
  ok: boolean
  reason?: string
  detail?: string
  login?: string
  type?: string
  id?: number
}> {
  const name = parseGithubOrgLogin(login)
  if (process.env.BRAIN_APP_DRY_RUN === '1') {
    if (!name) {
      return {
        ok: false,
        reason: 'invalid-name',
        detail: 'Paste the GitHub short name (one word, like harolds-books, not your business name) or its github.com address.',
        login: String(login || '').trim()
      }
    }
    return { ok: true, login: name, type: 'Organization', id: 1 }
  }
  if (!name) {
    return {
      ok: false,
      reason: 'invalid-name',
      detail: 'Paste the GitHub short name (one word, like harolds-books, not your business name) or its github.com address.',
      login: String(login || '').trim()
    }
  }
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'brain-app' }
    })
    const body = (await r.json().catch(() => null)) as { login?: string; type?: string; id?: number } | null
    if (r.status === 404) {
      return {
        ok: false,
        reason: 'not-found',
        detail: `GitHub has no organization named ${name}. After you create it, the address bar is github.com/orgs/${name}. Paste that address.`,
        login: name
      }
    }
    if (!r.ok) {
      return {
        ok: false,
        reason: 'github',
        detail: 'GitHub did not answer. Try again in a minute.',
        login: name
      }
    }
    if (body?.type === 'Organization') {
      return { ok: true, login: body.login || name, type: 'Organization', id: Number(body.id) || undefined }
    }
    return {
      ok: false,
      reason: 'personal-account',
      detail: `${body?.login || name} is already a person's GitHub login, so an organization cannot use that name. Choose a different organization name, then paste the address bar.`,
      login: body?.login || name,
      type: body?.type
    }
  } catch {
    return {
      ok: false,
      reason: 'offline',
      detail: 'This computer could not reach GitHub.',
      login: name
    }
  }
}

/** Whether the preferred org login is free, and a name that is free to create. */
export async function adviseGithubOrg(preferred: string): Promise<{
  preferred: string
  free: boolean
  takenType: string
  suggestion: string
}> {
  const names = orgLoginCandidates(preferred)
  const base = names[0] || ''
  if (!base) return { preferred: '', free: false, takenType: '', suggestion: '' }
  let takenType = ''
  for (const name of names) {
    const look = await lookupGithubAccount(name)
    if (look.reason === 'not-found') {
      return { preferred: base, free: name === base, takenType, suggestion: name }
    }
    if (name === base) takenType = look.type || look.reason || 'taken'
  }
  return { preferred: base, free: false, takenType, suggestion: base }
}

function resolveGhBin(): string | null {
  const dirs = `${extraPath()}${delimiter}${process.env.PATH || ''}`.split(delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh'] : ['gh']
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function runGh(args: string[]): Promise<GhRun> {
  const bin = resolveGhBin()
  if (!bin) return { bin: null, status: null, stdout: '', stderr: '' }
  try {
    const r = await execFileAsync(bin, args, {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...binEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    })
    return { bin, status: 0, stdout: r.stdout || '', stderr: r.stderr || '' }
  } catch (e) {
    const err = e as {
      status?: number
      code?: string | number
      stdout?: string
      stderr?: string
      killed?: boolean
      message?: string
    }
    const status = typeof err.status === 'number' ? err.status : typeof err.code === 'number' ? err.code : null
    return {
      bin,
      status,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
      error: err.killed ? 'The GitHub command timed out.' : undefined
    }
  }
}

/** REST lookup, then the signed-in GitHub account when the public API hides a new organization. */
export async function resolveGithubOrg(login: string): Promise<{
  ok: boolean
  reason?: string
  detail?: string
  login?: string
  type?: string
  id?: number
}> {
  const look = await lookupGithubAccount(login)
  if (look.ok && look.type === 'Organization' && look.id) return look
  if (look.reason === 'personal-account') return look
  const name = parseGithubOrgLogin(login)
  if (!name) return look
  const query = 'query($login:String!){ organization(login:$login){ login databaseId } }'
  const r = await runGh(['api', 'graphql', '-f', `query=${query}`, '-f', `login=${name}`])
  const hit = orgIdFromGraphql(r.stdout || '')
  if (hit) return { ok: true, login: hit.login, type: 'Organization', id: hit.id }
  if (!r.bin || r.status !== 0) {
    return { ok: false, reason: 'gh', detail: ghCliDetail(r), login: name }
  }
  return look
}

export async function resolveGithubRepoId(repo: string): Promise<{ ok: boolean; id?: number; detail?: string }> {
  const name = parseGithubHqRepo(repo)
  if (!name) return { ok: false, detail: 'This brain has no GitHub repository name yet.' }
  const r = await runGh(['api', `repos/${name}`, '--jq', '.id'])
  const id = repoIdFromGh(r.stdout || '')
  if (id) return { ok: true, id }
  return { ok: false, detail: ghCliDetail(r) }
}

/** Create the named brain repo with the signed-in GitHub account, or keep it if it is already there. */
export async function ensureRemoteBrainRepo(
  org: string,
  slug: string,
  repoName?: string
): Promise<{ ok: boolean; repo: string; detail?: string }> {
  const repo = resolvePlyntrRepoName(org, slug, repoName)
  if (!repo) return { ok: false, repo: '', detail: 'This brain has no GitHub repository name yet.' }
  const view = await runGh(['repo', 'view', repo, '--json', 'name'])
  if (view.bin && view.status === 0) return { ok: true, repo }
  const made = await runGh(['repo', 'create', repo, '--private', '--clone=false'])
  if (made.bin && made.status === 0) return { ok: true, repo }
  const err = `${made.stderr || ''}\n${made.stdout || ''}\n${view.stderr || ''}\n${view.stdout || ''}`
  if (/already exists/i.test(err)) return { ok: true, repo }
  return {
    ok: false,
    repo,
    detail: ghCliDetail(made.bin ? made : view.bin ? view : { bin: null, status: null })
  }
}
