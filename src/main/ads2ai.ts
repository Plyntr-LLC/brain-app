import { API_BASE } from '../shared/contracts'
import { parseGithubOrgLogin } from './github-repo'

function assertNoSecretLog(): void {
  /* tokens never go to console */
}

export type InviteResolve = {
  memberToken: string
  teamSlug: string
  teamName?: string
  repoUrl?: string
  kind?: string
  scoutSeats?: number | null
  packageTier?: string | null
  member?: { email?: string; name?: string; role?: string }
  memberEmail?: string
  memberName?: string
  memberRole?: string
}

export async function resolveInvite(token: string): Promise<InviteResolve> {
  const r = await fetch(
    `${API_BASE}/api/team-brain/invite-resolve?token=${encodeURIComponent(token)}`
  )
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    if (r.status === 404) throw new Error('not found')
    if (r.status === 410) throw new Error('expired')
    if (r.status === 409) throw new Error('github app')
    throw new Error(body.slice(0, 200) || `HTTP ${r.status}`)
  }
  return r.json() as Promise<InviteResolve>
}

export async function requestCode(email: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${API_BASE}/api/auth/request-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, app: true })
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Could not send a code (HTTP ${r.status})`)
  }
  return { ok: true }
}

export async function verifyCode(email: string, code: string): Promise<{
  token: string
  member: { email: string; name?: string }
}> {
  const r = await fetch(`${API_BASE}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `That code did not work (HTTP ${r.status})`)
  }
  const json = await r.json() as { token: string; member?: { email?: string; name?: string } }
  assertNoSecretLog()
  return {
    token: json.token,
    member: { email: json.member?.email || email, name: json.member?.name }
  }
}

export async function myTeams(token: string): Promise<{
  teams: { slug: string; name: string; role: string; kind?: string }[]
}> {
  const r = await fetch(`${API_BASE}/api/team-brain/my-teams`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Could not list teams (HTTP ${r.status})`)
  }
  return r.json() as Promise<{ teams: { slug: string; name: string; role: string; kind?: string }[] }>
}

export async function createTeam(token: string, name: string): Promise<{
  team: { id?: string; slug: string; name: string }
  member?: { id?: string; role?: string }
}> {
  const r = await fetch(`${API_BASE}/api/team-brain/create-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name })
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Could not create the team (HTTP ${r.status})`)
  }
  return r.json() as Promise<{ team: { slug: string; name: string } }>
}

export async function installStatus(teamSlug: string): Promise<{
  installed?: boolean
  repoUrl?: string
}> {
  const r = await fetch(
    `${API_BASE}/api/team-brain/install-status?team=${encodeURIComponent(teamSlug)}`
  )
  if (!r.ok) throw new Error(`Install status failed (HTTP ${r.status})`)
  return r.json() as Promise<{ installed?: boolean; repoUrl?: string }>
}

export async function gitToken(
  token: string,
  teamSlug: string
): Promise<{ cloneUrl?: string; token?: string; repoUrl?: string; url?: string }> {
  const r = await fetch(`${API_BASE}/api/team-brain/git-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamSlug })
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Could not get a clone token (HTTP ${r.status})`)
  }
  return r.json() as Promise<{ cloneUrl?: string; token?: string; repoUrl?: string; url?: string }>
}

export async function ensureBrainRepo(token: string, teamSlug: string): Promise<unknown> {
  const r = await fetch(`${API_BASE}/api/team-brain/ensure-brain-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamSlug })
  })
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Could not finish the GitHub repo (HTTP ${r.status})`)
  }
  return r.json()
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
  if (!name) {
    return {
      ok: false,
      reason: 'invalid-name',
      detail: 'Paste the GitHub organization name (one short word, like harolds-books) or its github.com address.',
      login: String(login || '').trim()
    }
  }
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'brain-app' }
    })
    const body = await r.json().catch(() => null) as { login?: string; type?: string; id?: number } | null
    if (r.status === 404) {
      return {
        ok: false,
        reason: 'not-found',
        detail: `GitHub has no organization named ${name}. Copy the name from the GitHub page after you create it.`,
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
      detail: `${body?.login || name} is a person on GitHub, not an organization. Create a free organization, then paste that name.`,
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
