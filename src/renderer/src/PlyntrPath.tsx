import { useEffect, useRef, useState } from 'react'
import { slugFromBusinessName } from '@shared/plyntr-invite'

const PLATFORM =
  'Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login.'

type CreatePending = {
  createId: string
  wizardStep: number
  label: string
  org: string
  slug: string
  scoutEmail: string
  brainId?: string
}

export function ForkScreen({
  signedOutFolder,
  pendingCreate,
  pendingJoin,
  onAgency,
  onHaveCode,
  onCreate,
  onProject,
  onContinueCreate,
  onContinueJoin
}: {
  signedOutFolder: boolean
  pendingCreate: boolean
  pendingJoin: boolean
  onAgency: () => void
  onHaveCode: () => void
  onCreate: () => void
  onProject: () => void
  onContinueCreate: () => void
  onContinueJoin: () => void
}) {
  return (
    <>
      <p className="kicker">Start</p>
      <h1>{signedOutFolder ? 'Pick how to sign in.' : 'How does this brain sync?'}</h1>
      {pendingCreate ? (
        <button className="primary" type="button" onClick={onContinueCreate}>
          Continue company brain setup
        </button>
      ) : null}
      {pendingJoin ? (
        <button className="primary" type="button" onClick={onContinueJoin}>
          Continue joining this brain
        </button>
      ) : null}
      <div className="actions">
        <button className="primary" type="button" onClick={onAgency}>
          With Agency Brain
        </button>
        <p className="tiny">You have a setup code from Your Clients.</p>
        <button className="ghost" type="button" onClick={onHaveCode}>
          I have a Plyntr code
        </button>
        <button className="ghost" type="button" onClick={onCreate}>
          Set up a new company brain
        </button>
        <p className="tiny">This brain stays in Brain.app. Agency Brain is not required.</p>
        <button className="linkish" type="button" onClick={onProject}>
          Project-only code
        </button>
      </div>
    </>
  )
}

export function PlyntrCodeScreen({
  onResolved
}: {
  onResolved: (row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) => void
}) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p className="kicker">Plyntr</p>
      <h1>Paste the Plyntr code.</h1>
      <label className="field">
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XX" />
      </label>
      {err ? <p className="note">{err}</p> : null}
      <button
        className="primary"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setErr('')
          try {
            const row = await window.brain.plyntr.resolve(code)
            onResolved(row)
          } catch (e) {
            setErr(String((e as Error).message || e))
          } finally {
            setBusy(false)
          }
        }}
      >
        Continue
      </button>
    </>
  )
}

export function PlyntrCreateScreen({
  initial,
  onCloned
}: {
  initial: CreatePending | null
  onCloned: (brainPath: string) => void
}) {
  const [step, setStep] = useState(initial?.wizardStep ?? 0)
  const [label, setLabel] = useState(initial?.label || '')
  const [org, setOrg] = useState(initial?.org || '')
  const [slug, setSlug] = useState(initial?.slug || '')
  const [email, setEmail] = useState(initial?.scoutEmail || '')
  const [brainId, setBrainId] = useState(initial?.brainId || '')
  const [repo, setRepo] = useState(initial?.org && initial?.slug ? `${initial.org}/${initial.slug}-brain` : '')
  const [made, setMade] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const createId = initial?.createId || ''
  const stop = useRef(false)
  useEffect(() => {
    stop.current = false
    return () => {
      stop.current = true
    }
  }, [])

  async function save(next: number, patch?: Partial<CreatePending>) {
    const row = {
      createId,
      wizardStep: next,
      label: patch?.label ?? label,
      org: patch?.org ?? org,
      slug: patch?.slug ?? slug,
      scoutEmail: patch?.scoutEmail ?? email,
      brainId: patch?.brainId ?? (brainId || undefined)
    }
    await window.brain.plyntr.saveCreate(row)
    setStep(next)
  }

  async function pollInstall() {
    const want = repo || `${org}/${slug}-brain`
    while (!stop.current) {
      const st = await window.brain.plyntr.installed(brainId, want).catch(() => null)
      if (st?.ready) return true
      await new Promise((r) => setTimeout(r, 3000))
    }
    return false
  }

  return (
    <>
      <p className="kicker">New company brain</p>
      <h1>
        {step === 0
          ? 'Platform sign-in'
          : step === 1
            ? 'Business name'
            : step === 2
              ? 'GitHub organization'
              : step === 3
                ? 'Create the brain'
                : step === 4
                  ? 'Create the empty repo'
                  : step === 5
                    ? 'Install Plyntr sync'
                    : 'Copy the folder'}
      </h1>
      {step === 0 ? <p>{PLATFORM}</p> : null}
      {step === 1 ? (
        <label className="field">
          Business name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
      ) : null}
      {step === 2 ? (
        <label className="field">
          GitHub organization
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
        </label>
      ) : null}
      {step === 3 && !brainId ? <p className="tiny">This creates your scout seat. The code for the client comes later in Settings.</p> : null}
      {step === 4 ? (
        <label className="need-row">
          <input type="checkbox" checked={made} onChange={(e) => setMade(e.target.checked)} />
          <span>I created {org}/{slug}-brain</span>
        </label>
      ) : null}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
        {step === 3 && brainId ? null : null}
        {step === 3 ? (
          <button
            className="ghost"
            type="button"
            onClick={async () => {
              setBusy(true)
              setErr('')
              try {
                const res = await window.brain.plyntr.createBrain({ label, org, slug, scoutEmail: email, rotate: true })
                if (!res.hasToken) {
                  setErr('The scout token did not come back. Try Recover again.')
                  return
                }
                setBrainId(res.brainId)
                setRepo(res.repo)
                await save(4, { brainId: res.brainId })
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Recover scout token
          </button>
        ) : null}
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={async () => {
            setErr('')
            setBusy(true)
            try {
              if (step === 0) {
                const pend = await window.brain.plyntr.pending()
                if (!pend.platform) {
                  setErr(PLATFORM)
                  return
                }
                await save(1)
                return
              }
              if (step === 1) {
                const next = slugFromBusinessName(label)
                if (!next) {
                  setErr('That name does not make a usable short name.')
                  return
                }
                setSlug(next)
                await save(2, { label, slug: next })
                return
              }
              if (step === 2) {
                const look = await window.brain.setup.lookupOrg(org)
                if (!look.ok || look.type !== 'Organization') {
                  setErr(look.detail || 'That GitHub name is not an organization.')
                  return
                }
                const login = look.login || org
                setOrg(login)
                await save(3, { org: login })
                return
              }
              if (step === 3) {
                const acct = await window.brain.auth.session()
                const scoutEmail = email || acct.email
                if (!scoutEmail) {
                  setErr('Platform sign-in has no email.')
                  return
                }
                setEmail(scoutEmail)
                if (brainId) {
                  await save(4, { scoutEmail, brainId })
                  return
                }
                const res = await window.brain.plyntr.createBrain({ label, org, slug, scoutEmail })
                if (!res.hasToken) {
                  setErr('The scout token did not come back. Use Recover scout token.')
                  setBrainId(res.brainId)
                  setRepo(res.repo)
                  return
                }
                setBrainId(res.brainId)
                setRepo(res.repo)
                await save(4, { scoutEmail, brainId: res.brainId })
                return
              }
              if (step === 4) {
                if (!made) {
                  await window.brain.setup.openPlyntrRepo(org, slug)
                  setErr(`Create ${org}/${slug}-brain with README unchecked, then check the box.`)
                  return
                }
                await save(5)
                return
              }
              if (step === 5) {
                await window.brain.setup.openPlyntrInstall(brainId, org)
                const ready = await pollInstall()
                if (!ready) {
                  setErr('This brain is not ready on GitHub yet. Ask whoever set it up to finish install on the repo.')
                  return
                }
                await save(6)
                return
              }
              const applied = await window.brain.setup.putFolderPlyntr({
                brainId,
                org,
                slug,
                repo: repo || `${org}/${slug}-brain`
              })
              await save(7, { brainId })
              onCloned(applied.brainPath || '')
            } catch (e) {
              setErr(String((e as Error).message || e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {step === 6 ? 'Copy the folder' : 'Next'}
        </button>
      </div>
    </>
  )
}
