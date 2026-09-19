const GITHUB_APP_INSTALL = 'https://github.com/apps/agency-brain-sync/installations/new'

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

export function githubInstallReady(st: { installed?: boolean; repoUrl?: string; repo?: string } | null): boolean {
  if (!st) return false
  if (st.installed === true) return true
  return Boolean(String(st.repoUrl || st.repo || '').trim())
}
