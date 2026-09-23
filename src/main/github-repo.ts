/** owner/name from a git remote or a pasted GitHub URL. Empty if it is not GitHub. */
export function parseGithubHqRepo(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s
  const noGit = s.replace(/\.git$/i, '')
  const m = noGit.match(/github\.com[:/]([^/\s]+)\/([^/#?\s]+)/i)
  if (!m) return ''
  return `${m[1]}/${m[2]}`
}

const ORG_RESERVED = new Set([
  'account',
  'accounts',
  'apps',
  'login',
  'new',
  'orgs',
  'organizations',
  'settings',
  'signup'
])

/** Short org login from a name, @name, or github.com/orgs/name address. */
export function parseGithubOrgLogin(raw: string): string {
  const s = String(raw || '').trim().replace(/^@/, '')
  if (!s) return ''
  const noQuery = s.split(/[?#]/)[0].replace(/\/+$/, '')
  const fromUrl =
    noQuery.match(/github\.com\/account\/organizations\/([^/\s]+)/i) ||
    noQuery.match(/github\.com\/(?:orgs|organizations)\/([^/\s]+)/i) ||
    noQuery.match(/github\.com\/([^/\s]+)\/[^/\s]+/i) ||
    noQuery.match(/github\.com\/([^/\s]+)/i)
  const name = String(fromUrl ? fromUrl[1] : noQuery).replace(/^@/, '')
  if (ORG_RESERVED.has(name.toLowerCase())) return ''
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(name)) return ''
  return name
}

/** owner/name for this company's brain repository. */
export function plyntrRepoFullName(org: string, slug: string): string {
  const owner = parseGithubOrgLogin(org)
  const name = parseGithubOrgLogin(String(slug || '').replace(/-brain$/i, ''))
  if (!owner || !name) return ''
  return `${owner}/${name}-brain`
}

/** database id from `gh api graphql` organization(login). */
export function orgIdFromGraphql(raw: string): { login: string; id: number } | null {
  try {
    const data = JSON.parse(String(raw || '')) as {
      data?: { organization?: { login?: string; databaseId?: number } | null }
    }
    const org = data.data?.organization
    const id = Number(org?.databaseId)
    const login = String(org?.login || '')
    if (!login || !Number.isFinite(id) || id <= 0) return null
    return { login, id }
  } catch {
    return null
  }
}

/** Preferred login, then short suffixes, each still a valid GitHub name. */
export function orgLoginCandidates(preferred: string): string[] {
  const base = parseGithubOrgLogin(preferred)
  if (!base) return []
  const out: string[] = []
  for (const suffix of ['', '-hq', '-co', '-team']) {
    const name = `${base}${suffix}`
    if (name.length > 39) continue
    if (parseGithubOrgLogin(name) === name) out.push(name)
  }
  return out
}

/** Human text when `gh` did not run or printed nothing. */
export function ghCliDetail(opts: {
  bin: string | null
  status: number | null
  stdout?: string
  stderr?: string
  error?: string
}): string {
  if (!opts.bin) {
    return 'This Mac does not have the GitHub command (gh). Install GitHub CLI and sign in as an owner of the organization.'
  }
  const err = `${opts.stderr || ''}\n${opts.stdout || ''}\n${opts.error || ''}`.trim()
  if (err) return err
  if (opts.status == null) return 'This Mac could not start the GitHub command (gh).'
  return `GitHub did not create the repository (exit ${opts.status}).`
}
