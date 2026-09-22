const GITHUB_APP_INSTALL = 'https://github.com/apps/agency-brain-sync/installations/new'
const BRIDGE_APP_INSTALL = 'https://github.com/apps/plyntr-brain-bridge/installations/new'
const BRIDGE_ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

/** Reuse a folder only when it is already this team. Never hand a new brain the old one. */
export function reuseExistingFolder(opts: {
  slug: string
  watchingPath: string | null
  watchingSlug: string | null
  accountFolder: string | null
  accountSlug: string | null
}): string | null {
  const slug = String(opts.slug || '').trim().toLowerCase()
  const watch = String(opts.watchingPath || '').trim()
  const acct = String(opts.accountFolder || '').trim()
  if (!slug) return watch || acct || null
  const wSlug = String(opts.watchingSlug || '').trim().toLowerCase()
  const aSlug = String(opts.accountSlug || '').trim().toLowerCase()
  if (watch && wSlug === slug) return watch
  if (acct && aSlug === slug) return acct
  return null
}

/** Agency Brain Sync install URL. state must stay on /installations/new so ads2ai can link the team. */
export function githubAppInstallUrl(slug: string, orgId?: number): string {
  const state = encodeURIComponent(String(slug || '').trim())
  const id = Number(orgId)
  if (state && Number.isFinite(id) && id > 0) {
    return `${GITHUB_APP_INSTALL}?state=${state}&suggested_target_id=${Math.floor(id)}`
  }
  if (state) return `${GITHUB_APP_INSTALL}?state=${state}`
  return GITHUB_APP_INSTALL
}

/** What to do when the clone destination is already on disk. */
export function clonePlan(opts: {
  destExists: boolean
  isGit: boolean
  sameOrigin: boolean
  hasMarker: boolean
  empty: boolean
}): 'clone' | 'reuse' | 'replace-empty' | 'refuse-other-repo' | 'refuse-not-empty' | 'refuse-empty-brain' {
  if (!opts.destExists) return 'clone'
  if (opts.isGit && opts.sameOrigin && opts.hasMarker) return 'reuse'
  if (opts.isGit && opts.sameOrigin) return 'refuse-empty-brain'
  if (opts.isGit) return 'refuse-other-repo'
  if (opts.empty) return 'replace-empty'
  return 'refuse-not-empty'
}

/** Install URL for Brain Bridge on one repo. state matches the worker's payload. */
export function bridgeInstallUrl(hqRepo: string): string {
  const repo = String(hqRepo || '').trim()
  const state = Buffer.from(JSON.stringify({ hq_repo: repo, origin: BRIDGE_ORIGIN })).toString('base64')
  return `${BRIDGE_APP_INSTALL}?state=${encodeURIComponent(state)}`
}

/** A repo address is not an install. GitHub has to say the app is installed on this repo. */
export function githubInstallReady(
  st: {
    installed?: boolean
    repoUrl?: string
    repo?: string
    allRepositories?: boolean
    repositorySelection?: string
  } | null
): boolean {
  if (st?.installed !== true) return false
  if (st.allRepositories === true) return false
  const sel = String(st.repositorySelection || '').toLowerCase()
  if (sel === 'all' || sel === 'all_repositories') return false
  const repo = String(st.repoUrl || st.repo || '').trim()
  return repo.length > 0
}
