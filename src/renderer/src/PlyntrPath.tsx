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
  err,
  onAgency,
  onHaveCode,
  onProject,
  onEmailCode,
  onContinueCreate,
  onContinueJoin
}: {
  signedOutFolder: boolean
  pendingCreate: boolean
  pendingJoin: boolean
  err: string
  onAgency: () => void
  onHaveCode: () => void
  onProject: () => void
  onEmailCode: () => void
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
      {err ? <p className="note">{err}</p> : null}
      <button className="choice" type="button" onClick={onAgency}>
        <h3>With Agency Brain</h3>
        <p>You have a setup code from Your Clients.</p>
      </button>
      <button className="choice" type="button" onClick={onHaveCode}>
        <h3>I have a Plyntr code</h3>
        <p>Paste the code you were given.</p>
      </button>
      <button className="choice" type="button" onClick={onProject}>
        <h3>Project-only code</h3>
        <p>Paste the project code if you were set up for one project.</p>
      </button>
      <button className="choice" type="button" onClick={onEmailCode}>
        <h3>Email me a code</h3>
        <p>This works after Plyntr, your owner, or a scout has already added your email.</p>
      </button>
    </>
  )
}

export function PlyntrProjectScreen({
  onJoin
}: {
  onJoin: (res: { email: string; name: string; brainPath: string; teamName: string; roots?: string[] }) => Promise<void>
}) {
  const [mode, setMode] = useState<'code' | 'email' | 'sent'>('code')
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [sentRole, setSentRole] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p className="kicker">Project only</p>
      <h1>{mode === 'code' ? 'Paste the project code.' : 'Email me the code.'}</h1>
      {mode === 'code' ? (
        <p>Paste the project code if an owner or a scout already set you up for one project.</p>
      ) : mode === 'sent' ? (
        <p>
          Check {email}.
          {sentRole && sentRole !== 'project'
            ? ' That email is for the whole brain. Paste the code under I have a Plyntr code.'
            : ' Paste the code from that email here.'}
        </p>
      ) : (
        <p>
          Type the email you were added with. A code is sent only after an owner or a scout has already set up your
          project. If that has not happened, nothing is emailed.
        </p>
      )}
      {mode === 'code' || mode === 'sent' ? (
        <label className="field">
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XX" />
        </label>
      ) : (
        <label className="field">
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
      )}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
        {mode === 'email' ? (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!email.includes('@')) {
                setErr('Type the email you were added with.')
                return
              }
              setBusy(true)
              setErr('')
              try {
                const sent = await window.brain.plyntr.emailCode(email)
                setSentRole(sent.role || '')
                setMode('sent')
                if (!sent.emailed) setErr('You are on file. Email did not send. Ask for the code directly.')
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Email me a code
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setErr('')
              try {
                const row = await window.brain.plyntr.joinProject(code)
                await onJoin(row)
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Continue
          </button>
        )}
        <button className="linkish" type="button" onClick={() => setMode(mode === 'code' ? 'email' : 'code')}>
          {mode === 'code' ? "I don't have a code" : 'I have a code'}
        </button>
      </div>
    </>
  )
}

export function PlyntrCodeScreen({
  onJoin,
  startInEmail
}: {
  onJoin: (row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) => Promise<void>
  startInEmail?: boolean
}) {
  const [mode, setMode] = useState<'code' | 'email' | 'sent'>(startInEmail ? 'email' : 'code')
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [sentRole, setSentRole] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p className="kicker">Plyntr</p>
      <h1>{mode === 'code' ? 'Paste the Plyntr code.' : 'Email me the code.'}</h1>
      {mode === 'code' ? (
        <p>Paste the code you were given after you were added.</p>
      ) : mode === 'sent' ? (
        <p>
          Check {email}. Paste that code here.
          {sentRole === 'project' ? ' This email is a project login. Paste the code on Project-only code instead.' : ''}
        </p>
      ) : (
        <p>
          Type the email you were added with. A code is sent only after Plyntr, your owner, or a scout has already set
          you up. If that has not happened, nothing is emailed.
        </p>
      )}
      {mode === 'code' || mode === 'sent' ? (
        <label className="field">
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="184392" inputMode="numeric" />
        </label>
      ) : (
        <label className="field">
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
      )}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
        {mode === 'email' ? (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!email.includes('@')) {
                setErr('Type the email you were added with.')
                return
              }
              setBusy(true)
              setErr('')
              try {
                const sent = await window.brain.plyntr.emailCode(email)
                setSentRole(sent.role || '')
                setMode('sent')
                if (!sent.emailed) setErr('You are on file. Email did not send. Ask for the code directly.')
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Email me a code
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setErr('')
              try {
                const row = await window.brain.plyntr.resolve(code)
                await onJoin(row)
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Continue
          </button>
        )}
        <button className="linkish" type="button" onClick={() => setMode(mode === 'code' ? 'email' : 'code')}>
          {mode === 'code' ? "I don't have a code" : 'I have a code'}
        </button>
      </div>
    </>
  )
}

export function PlyntrCompanyScreen({
  onSetupHere,
  onResume,
  embedded
}: {
  onSetupHere: (row: { brainId: string; slug: string; label: string; ownerEmail: string; code: string }) => void
  onResume?: () => void
  embedded?: boolean
}) {
  const [phase, setPhase] = useState<'check' | 'login' | 'form' | 'code'>('check')
  const [email, setEmail] = useState('joe@plyntr.com')
  const [otp, setOtp] = useState('')
  const [label, setLabel] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [code, setCode] = useState('')
  const [emailed, setEmailed] = useState(false)
  const [brainId, setBrainId] = useState('')
  const [slug, setSlug] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    void window.brain.plyntr.pending().then((pend) => {
      setPhase(pend.platform ? 'form' : 'login')
    })
  }, [])

  return (
    <>
      {embedded ? null : <p className="kicker">New company</p>}
      {embedded ? (
        <h3 className="set-h">
          {phase === 'login' || phase === 'check'
            ? 'Sign in as Plyntr first'
            : phase === 'form'
              ? 'Add the company'
              : 'Share this code'}
        </h3>
      ) : (
        <h1>
          {phase === 'login' || phase === 'check'
            ? 'Sign in as Plyntr first'
            : phase === 'form'
              ? 'Add the company'
              : 'Share this code'}
        </h1>
      )}
      {phase === 'login' ? (
        <>
          <p>This Mac needs the platform login before it can add a company. We email a code to you, you paste it here, and setup continues on the next screen.</p>
          <label className="field">
            Your email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Code from that email
            <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="184 392" />
          </label>
        </>
      ) : null}
      {phase === 'form' ? (
        <>
          <p>Their name and email are who the setup code belongs to. You will see the code, and we email it to them.</p>
          <label className="field">
            Company
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field">
            Their name
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className="field">
            Their email
            <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="ada@company.com" />
          </label>
        </>
      ) : null}
      {phase === 'code' ? (
        <>
          <p>
            Give {ownerName || 'them'} this code, or they can choose “I don’t have a code” and use {ownerEmail}.
            {emailed ? ' We also emailed it.' : ' Email did not send. Hand them this code.'}
          </p>
          <p className="phone-pin">{code}</p>
        </>
      ) : null}
      {hint ? <p className="tiny">{hint}</p> : null}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
        {phase === 'login' ? (
          <>
            <button
              className="ghost"
              type="button"
              disabled={busy || !email.includes('@')}
              onClick={async () => {
                setBusy(true)
                setErr('')
                try {
                  await window.brain.hqSync.ownerRequestCode(email)
                  setHint('Check that inbox. Paste the code here, then Sign in.')
                } catch (e) {
                  setErr(String((e as Error).message || e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Email me a code
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy || otp.replace(/\s/g, '').length < 4}
              onClick={async () => {
                setBusy(true)
                setErr('')
                try {
                  const st = await window.brain.hqSync.ownerLogin({ email, code: otp })
                  if (st.kind !== 'platform') {
                    setErr('That sign-in is not the platform login. Use the Plyntr platform email.')
                    return
                  }
                  const pend = await window.brain.plyntr.pending()
                  if (pend.create && pend.create.wizardStep > 1 && onResume) {
                    onResume()
                    return
                  }
                  setPhase('form')
                  setHint('')
                } catch (e) {
                  setErr(String((e as Error).message || e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Sign in
            </button>
          </>
        ) : null}
        {phase === 'form' ? (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (label.trim().length < 2 || ownerName.trim().length < 2 || !ownerEmail.includes('@')) {
                setErr('Add the company, their name, and their email.')
                return
              }
              setBusy(true)
              setErr('')
              try {
                const created = await window.brain.plyntr.openCompany({
                  label: label.trim(),
                  ownerName: ownerName.trim(),
                  ownerEmail: ownerEmail.trim()
                })
                setCode(created.code)
                setEmailed(created.emailed)
                setBrainId(created.brainId)
                setSlug(created.slug)
                setPhase('code')
              } catch (e) {
                setErr(String((e as Error).message || e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Create the company
          </button>
        ) : null}
        {phase === 'code' ? (
          <button
            className="primary"
            type="button"
            onClick={() => onSetupHere({ brainId, slug, label, ownerEmail, code })}
          >
            Set this brain up on this Mac
          </button>
        ) : null}
      </div>
    </>
  )
}

export function PlyntrCreateScreen({
  initial,
  gateFirst,
  onCloned
}: {
  initial: CreatePending | null
  gateFirst: boolean
  onCloned: (brainPath: string) => void
}) {
  const savedStep = initial?.wizardStep ?? 0
  const [step, setStep] = useState(gateFirst ? 0 : savedStep)
  const [label, setLabel] = useState(initial?.label || '')
  const [org, setOrg] = useState(initial?.org || '')
  const [slug, setSlug] = useState(initial?.slug || '')
  const [email, setEmail] = useState(initial?.scoutEmail || '')
  const [brainId, setBrainId] = useState(initial?.brainId || '')
  const [hasSeat, setHasSeat] = useState(false)
  const [seatKnown, setSeatKnown] = useState(!initial?.brainId)
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
  useEffect(() => {
    if (!brainId) {
      setHasSeat(false)
      setSeatKnown(true)
      return
    }
    let live = true
    void window.brain.plyntr.hasSeat(brainId).then((ok) => {
      if (!live) return
      setHasSeat(ok)
      setSeatKnown(true)
    })
    return () => {
      live = false
    }
  }, [brainId])

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
        <>
          <p>Type the GitHub organization for this company. Next checks that name, then opens GitHub so you can create the empty repo.</p>
          <label className="field">
            GitHub organization
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
          </label>
        </>
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
                  setBrainId(res.brainId)
                  setRepo(res.repo)
                  setHasSeat(false)
                  await save(3, { brainId: res.brainId, scoutEmail: email })
                  setErr('The scout token did not come back. Try Recover again.')
                  return
                }
                setBrainId(res.brainId)
                setRepo(res.repo)
                setHasSeat(true)
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
                await window.brain.plyntr.resumeAccount('create')
                if (gateFirst && savedStep > 0) {
                  setStep(savedStep)
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
                if (brainId) {
                  const placed = await window.brain.plyntr.place({ brainId, org: login })
                  setRepo(placed.repo)
                  await save(4, { org: login, slug: placed.slug || slug })
                  return
                }
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
                if (!seatKnown) return
                if (hasSeat && brainId) {
                  await save(4, { scoutEmail, brainId })
                  return
                }
                const res = await window.brain.plyntr.createBrain({ label, org, slug, scoutEmail })
                if (!res.hasToken) {
                  setBrainId(res.brainId)
                  setRepo(res.repo)
                  setHasSeat(false)
                  await save(3, { scoutEmail, brainId: res.brainId })
                  setErr('The scout token did not come back. Use Recover scout token.')
                  return
                }
                setBrainId(res.brainId)
                setRepo(res.repo)
                setHasSeat(true)
                await save(4, { scoutEmail, brainId: res.brainId })
                return
              }
              if (step === 4) {
                if (!made) {
                  await window.brain.setup.openPlyntrRepo(org, slug)
                  await window.brain.setup.bringFront()
                  setErr(`GitHub is open. Create ${org}/${slug}-brain with README unchecked, then come back and check the box.`)
                  return
                }
                await save(5)
                return
              }
              if (step === 5) {
                await window.brain.setup.openPlyntrInstall(brainId, org)
                await window.brain.setup.bringFront()
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
