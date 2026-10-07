import { bringAppFront } from './bring-front'
import { openInApp } from './in-app-browse'
import {
  cancelGithubSetup,
  createGithubSetupRepo,
  githubSetupStatus,
  signOutGithubSetup,
  startGithubSetup,
  type GithubAccount
} from './plyntr-sync'

const ORG_NEW = 'https://github.com/account/organizations/new'

const setups = new Map<string, { setupId: string; orgId: number; repoId: number }>()

function dry(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function connectGithub(brainId: string): Promise<{
  ok: boolean
  org?: string
  detail?: string
  accounts?: GithubAccount[]
}> {
  const id = String(brainId || '').trim()
  if (!id) return { ok: false, detail: 'Create the brain before connecting GitHub.' }
  if (dry()) {
    return {
      ok: true,
      org: 'dry-org',
      accounts: [{ login: 'dry-org', id: 1, kind: 'org', choosable: true }]
    }
  }
  let known = setups.get(id)
  if (!known?.setupId) {
    const started = await startGithubSetup(id)
    known = { setupId: started.setupId, orgId: 0, repoId: 0 }
    setups.set(id, known)
    openInApp(started.authorizeUrl, 'Sign in to GitHub')
  }
  const until = Date.now() + 180000
  while (Date.now() < until) {
    const st = await githubSetupStatus(id, known.setupId).catch(() => null)
    if (!st) {
      await wait(2000)
      continue
    }
    if (st.phase === 'revoked') {
      setups.delete(id)
      return { ok: false, detail: 'That GitHub sign-in expired. Connect again.' }
    }
    const accounts = st.accounts || []
    if (st.phase === 'authorized' && accounts.length) {
      const org = accounts.find((account) => account.kind === 'org' && account.choosable)
      bringAppFront()
      return { ok: true, org: org?.login || '', accounts }
    }
    await wait(2000)
  }
  bringAppFront()
  return { ok: false, detail: 'GitHub did not finish. Connect again.' }
}

export async function createSetupRepo(
  brainId: string,
  org: string,
  repo: string
): Promise<{ ok: boolean; repo: string; orgId?: number; repoId?: number; detail?: string }> {
  const full = String(repo || '').trim()
  const owner = full.split('/')[0] || String(org || '').trim()
  const name = full.split('/')[1] || ''
  if (!owner || !name) return { ok: false, repo: '', detail: 'This brain has no GitHub repository name yet.' }
  if (dry()) return { ok: true, repo: full, orgId: 1, repoId: 2 }
  const made = await createGithubSetupRepo(brainId, owner, name)
  const prev = setups.get(brainId)
  setups.set(brainId, { setupId: prev?.setupId || '', orgId: made.orgId, repoId: made.repoId })
  return { ok: true, repo: made.repo, orgId: made.orgId, repoId: made.repoId }
}

export async function cancelGithub(brainId: string): Promise<void> {
  const id = String(brainId || '')
  const known = setups.get(id)
  if (!known?.setupId) return
  setups.delete(id)
  if (dry()) return
  await cancelGithubSetup(id, known.setupId).catch(() => undefined)
}

export async function signOutGithub(): Promise<void> {
  const rows = [...setups.entries()]
  setups.clear()
  if (dry()) return
  await Promise.all(
    rows.map(([brainId, known]) => (known.setupId ? signOutGithubSetup(brainId, known.setupId).catch(() => undefined) : undefined))
  )
}

export function openOrgForm(): void {
  openInApp(ORG_NEW, 'Create a GitHub organization')
}
