import { useEffect, useState } from 'react'

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

  useEffect(() => {
    return window.brain.setup.onBack((ev) => {
      const login = String(ev.org || '').trim()
      if (login) setOrg(login)
    })
  }, [])

  async function useOrg() {
    const typed = org.trim()
    if (typed.length < 2) {
      setErr('Create the GitHub organization, or paste the short name you already have.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const look = await window.brain.setup.lookupOrg(typed)
      if (!look.ok || look.type !== 'Organization' || !look.login) {
        setErr(look.detail || 'That short name is not a GitHub organization.')
        return
      }
      const placed = await window.brain.plyntr.place({ brainId, org: look.login })
      const created = await window.brain.setup.createPlyntrRepo(look.login, placed.slug || slug, placed.repo)
      if (!created.ok || !created.repo) {
        setErr(created.detail || 'Could not create the client brain repository.')
        return
      }
      setOrg(look.login)
      setNamed(created.repo)
      setStep('apps')
    } catch (e) {
      setErr(String((e as Error).message || e))
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
      if (!openedSync) {
        const opened = await window.brain.setup.openPlyntrInstall(brainId, org, named)
        setOpenedSync(true)
        if (!opened.ok) setErr(opened.detail || 'Could not open the Plyntr sync install page.')
        else setErr('In the browser, click Install, then Only select repositories. Come back and check again.')
        return
      }
      const installed = await window.brain.plyntr.installed(brainId, named)
      if (!installed.ready || installed.repositorySelection === 'all' || installed.repositorySelection === 'all_repositories') {
        setErr('Plyntr sync is not on this one repo yet. Choose Only select repositories, not All repositories.')
        return
      }
      const bridge = await window.brain.setup.bridgeOnRepo(named)
      const bridgeSel = String(bridge.repositorySelection || '').toLowerCase()
      const bridgeSelected = bridge.skipped || bridgeSel === 'selected' || bridgeSel === 'selected_repositories'
      if (!bridge.installed || !bridgeSelected) {
        if (bridge.installed && !bridgeSelected) {
          setErr('Brain Bridge is not limited to this one repo. Choose Only select repositories, not All repositories.')
          return
        }
        if (!openedBridge) {
          await window.brain.setup.openBridgeRepo(named)
          setOpenedBridge(true)
          setErr('Install Brain Bridge on this same repository. Only select repositories. Then check again.')
          return
        }
        setErr(bridge.detail || 'Brain Bridge is not on this repository yet.')
        return
      }
      const turned = await window.brain.setup.enableLocalSync({ folder, org, repo: named })
      onDone(turned.detail || 'GitHub sync is on.')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="biz-sync">
      <h3 className="set-h">GitHub sync</h3>
      <p>
        This brain is only on this computer. Set up GitHub sync when you want backup copies and more than one person
        editing. Create a GitHub organization, or use one you already have, then install Plyntr sync and Brain Bridge
        on this one repository. Choose Only select repositories.
      </p>
      {step === 'org' ? (
        <label className="field">
          GitHub organization
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
        </label>
      ) : (
        <p className="tiny">Repository {named}. Install both apps on that one repo.</p>
      )}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
        {step === 'org' ? (
          <>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                void window.brain.setup.openCreateOrg().then((r) => {
                  const login = String(r?.org || '').trim()
                  if (login) setOrg(login)
                })
              }}
            >
              Open GitHub
            </button>
            <button className="primary" type="button" disabled={busy} onClick={() => void useOrg()}>
              {busy ? 'Checking…' : 'Use this organization'}
            </button>
          </>
        ) : (
          <button className="primary" type="button" disabled={busy} onClick={() => void installApps()}>
            {busy ? 'Checking GitHub…' : openedSync ? 'Check GitHub' : 'Install the apps'}
          </button>
        )}
      </div>
    </div>
  )
}
