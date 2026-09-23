import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { extraPath, binEnv } from './ai-cli'
import { ghCliDetail, orgIdFromGraphql, orgLoginCandidates, parseGithubOrgLogin, plyntrRepoFullName } from './github-repo'

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

function runGh(args: string[]): { bin: string | null; status: number | null; stdout: string; stderr: string; error?: string } {
  const bin = resolveGhBin()
  if (!bin) return { bin: null, status: null, stdout: '', stderr: '' }
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...binEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
  })
  return {
    bin,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : undefined
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
  const r = runGh(['api', 'graphql', '-f', `query=${query}`, '-f', `login=${name}`])
  const hit = orgIdFromGraphql(r.stdout || '')
  if (!hit) return look
  return { ok: true, login: hit.login, type: 'Organization', id: hit.id }
}

/** Create org/slug-brain with the signed-in GitHub account, or keep it if it is already there. */
export function ensureRemoteBrainRepo(org: string, slug: string): { ok: boolean; repo: string; detail?: string } {
  const repo = plyntrRepoFullName(org, slug)
  if (!repo) return { ok: false, repo: '', detail: 'That organization name cannot be used.' }
  const view = runGh(['repo', 'view', repo, '--json', 'name'])
  if (view.bin && view.status === 0) return { ok: true, repo }
  const made = runGh(['repo', 'create', repo, '--private', '--clone=false'])
  if (made.bin && made.status === 0) return { ok: true, repo }
  const err = `${made.stderr || ''}\n${made.stdout || ''}\n${view.stderr || ''}\n${view.stdout || ''}`
  if (/already exists/i.test(err)) return { ok: true, repo }
  return {
    ok: false,
    repo,
    detail: ghCliDetail(made.bin ? made : view.bin ? view : { bin: null, status: null })
  }
}
