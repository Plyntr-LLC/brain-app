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
    noQuery.match(/github\.com\/(?:orgs|organizations)\/([^/\s]+)/i) ||
    noQuery.match(/github\.com\/([^/\s]+)/i)
  const name = String(fromUrl ? fromUrl[1] : noQuery).replace(/^@/, '')
  if (ORG_RESERVED.has(name.toLowerCase())) return ''
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(name)) return ''
  return name
}
