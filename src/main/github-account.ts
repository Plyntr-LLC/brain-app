import { orgLoginCandidates, parseGithubOrgLogin } from './github-repo'

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
