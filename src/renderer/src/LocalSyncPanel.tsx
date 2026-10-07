import { useEffect, useState } from 'react'
import { ipcErrorText } from '@shared/plyntr-org-copy'

export function LocalSyncPanel({
  brainId,
  slug,
  repo,
  folder,
  onDone
}: {
  brainId: string
  slug: string
  repo: string
  folder: string
  onDone: (detail: string) => void
}) {
  const pending = !repo || repo.startsWith('pending/')
  const [org, setOrg] = useState(pending ? '' : repo.split('/')[0] || '')
  const [named, setNamed] = useState(pending ? '' : repo)
  const [step, setStep] = useState<'org' | 'apps'>(pending ? 'org' : 'apps')
  const [openedSync, setOpenedSync] = useState(false)
  const [openedBridge, setOpenedBridge] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [repoName, setRepoName] = useState(pending ? `${slug}-brain` : repo.split('/')[1] || `${slug}-brain`)
  const [accounts, setAccounts] = useState<{ login: string; id: number; kind: string; choosable: boolean }[]>([])
  const [orgId, setOrgId] = useState(0)
  const [repoId, setRepoId] = useState(0)

  useEffect(() => {
    return window.brain.setup.onBack((ev) => {
      const login = String(ev.org || '').trim()
      if (login) setOrg(login)
    })
  }, [])

  async function connectGithub() {
    const row = await window.brain.setup.githubConnect(brainId)
    setAccounts(row.accounts || [])
    if (!row.ok) {
      setErr(row.detail || 'Connect GitHub again.')
      return
    }
    if (row.org) setOrg(row.org)
    else if (!(row.accounts || []).some((account) => account.kind === 'org' && account.choosable)) {
      setErr('You do not own a GitHub organization yet. Choose your personal account, or create an organization.')
    }
  }

  useEffect(() => {
    return () => {
      if (brainId) void window.brain.setup.githubCancel(brainId)
    }
  }, [brainId])

  async function useOrg() {
    const typed = org.trim()
    const name = repoName.trim()
    if (typed.length < 2 || !name) {
      setErr('Choose a GitHub account you own, and confirm the repository name.')
      return
    }
    const picked = accounts.find((account) => account.login.toLowerCase() === typed.toLowerCase())
    if (!picked || !picked.choosable) {
      setErr('Choose a GitHub account you own.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const placed = await window.brain.plyntr.place({ brainId, org: picked.login })
      const full = `${picked.login}/${name}`
      const created = await window.brain.setup.createPlyntrRepo(picked.login, placed.slug || slug, full, brainId)
      if (!created.ok || !created.repo || !created.orgId || !created.repoId) {
        setErr(created.detail || 'Could not create the client brain repository.')
        return
      }
      setOrg(picked.login)
      setNamed(created.repo)
      setOrgId(created.orgId)
      setRepoId(created.repoId)
      setStep('apps')
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function installApps() {
    if (!named) {
      setErr('This brain has no GitHub repository name yet.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const realRepo = Boolean(named && named.includes('/') && !named.startsWith('pending/'))
      if ((!orgId || !repoId) && !realRepo) {
        setErr('Create the repository before opening GitHub.')
        return
      }
      const pinOrg = orgId || undefined
      const pinRepo = repoId || undefined
      if (!openedSync) {
        const opened = await window.brain.setup.openPlyntrInstall(brainId, org, named, pinOrg, pinRepo)
        setOpenedSync(true)
        if (!opened.ok) setErr(opened.detail || 'Could not open the Plyntr sync install page.')
        else setErr('In the browser, click Install, then Only select repositories. Then click Check GitHub.')
        return
      }
      const installed = await window.brain.plyntr.installed(brainId, named)
      if (!installed.ready || installed.repositorySelection === 'all' || installed.repositorySelection === 'all_repositories') {
        setErr('Plyntr sync is not on this one repo yet. Choose Only select repositories, not All repositories.')
        return
      }
      const bridge = await window.brain.setup.bridgeOnRepo(named)
      const bridgeSel = String(bridge.repositorySelection || '').toLowerCase()
      const bridgeAll = bridgeSel === 'all' || bridgeSel === 'all_repositories'
      if (!bridge.installed || (!bridge.skipped && bridgeAll)) {
        if (bridge.installed && bridgeAll) {
          setErr('Brain Bridge is not limited to this one repo. Choose Only select repositories, not All repositories.')
          return
        }
        if (!openedBridge) {
          await window.brain.setup.openBridgeRepo(named, pinOrg, pinRepo)
          setOpenedBridge(true)
          setErr('Install Brain Bridge on this same repository. Only select repositories. Then click Check GitHub.')
          return
        }
        setErr(bridge.detail || 'Brain Bridge is not on this repository yet.')
        return
      }
      const turned = await window.brain.setup.enableLocalSync({ folder, org, repo: named })
      onDone(turned.detail || 'GitHub sync is on.')
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="biz-sync">
      <h3 className="set-h">GitHub sync</h3>
      <p>
        Right now this brain is only on this Mac. Turn on sync for backups and sharing. You need a free GitHub account.
        We walk you through two GitHub pages.
      </p>
      {step === 'org' ? (
        <label className="field">
          GitHub organization
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
        </label>
      ) : null}
      {step === 'org' ? (
        <label className="field">
          Repository name
          <input value={repoName} onChange={(e) => setRepoName(e.target.value)} />
        </label>
      ) : null}
      {step === 'org' && accounts.length ? (
        <ul className="tiny">
          {accounts.map((account) => (
            <li key={account.login}>
              {account.choosable ? (
                <button className="ghost" type="button" onClick={() => setOrg(account.login)}>
                  {account.login}
                </button>
              ) : (
                <span>{account.login}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {step === 'org' ? null : (
        <p className="tiny">Repository {named}. Install both apps on that one repo.</p>
      )}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions tight">
        {step === 'org' ? (
          <>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setBusy(true)
                setErr('')
                void connectGithub()
                  .catch((e) => setErr(ipcErrorText(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Open GitHub
            </button>
            {accounts.length && !accounts.some((account) => account.kind === 'org' && account.choosable) ? (
              <button className="ghost" type="button" onClick={() => void window.brain.setup.openOrgForm()}>
                Create an organization
              </button>
            ) : null}
            <button className="primary" type="button" disabled={busy} onClick={() => void useOrg()}>
              {busy ? 'Checking…' : 'Use this organization'}
            </button>
          </>
        ) : (
          <button className="primary" type="button" disabled={busy} onClick={() => void installApps()}>
            {busy ? 'Checking GitHub…' : openedSync ? 'Check GitHub' : 'Open GitHub to install.'}
          </button>
        )}
      </div>
    </div>
  )
}
