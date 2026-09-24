import { useEffect, useState } from 'react'
import { slugFromBusinessName } from '@shared/plyntr-invite'
import { previousCreateStep } from '@shared/plyntr-wizard'
import { orgStepCopy, orgUseError } from '@shared/plyntr-org-copy'
import { resolvePlyntrRepoName } from '@shared/github-org'

const PLATFORM =
  'Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login.'
const NO_REPO = 'This brain has no GitHub repository name yet.'

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
  pendingCreate,
  pendingJoin,
  err,
  onPlyntr,
  onAgency,
  onLocal,
  onContinueCreate,
  onContinueJoin
}: {
  pendingCreate: boolean
  pendingJoin: boolean
  err: string
  onPlyntr: () => void
  onAgency: () => void
  onLocal: () => void
  onContinueCreate: () => void
  onContinueJoin: () => void
}) {
  return (
    <>
      <p className="kicker">Start</p>
      <h1>How do you want to set this up?</h1>
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
      <button className="choice" type="button" onClick={onPlyntr}>
        <h3>Plyntr Brain setup</h3>
        <p>Plyntr keeps backup copies, and more than one person can use this brain.</p>
      </button>
      <button className="choice" type="button" onClick={onAgency}>
        <h3>Plyntr Brain with Agency Brain sync</h3>
        <p>Use the setup code from Your Clients. Agency Brain keeps the copy in sync.</p>
      </button>
      <button className="choice" type="button" onClick={onLocal}>
        <h3>Plyntr Brain local only setup</h3>
        <p>Copy the client brain onto this computer. No GitHub apps and no sync. An owner or a scout can add GitHub sync later in Settings.</p>
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
  onProject,
  startInEmail,
  local
}: {
  onJoin: (row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) => Promise<void>
  onProject?: (row: { email: string; name: string; brainPath: string; teamName: string; roots?: string[] }) => Promise<void>
  startInEmail?: boolean
  local?: boolean
}) {
  const [mode, setMode] = useState<'code' | 'email' | 'sent'>(startInEmail ? 'email' : 'code')
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [sentRole, setSentRole] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p className="kicker">{local ? 'This computer only' : 'Plyntr'}</p>
      <h1>{mode === 'code' ? 'Paste the code from Plyntr.' : 'Email me the code.'}</h1>
      {mode === 'code' ? (
        <p>
          {local
            ? 'Paste the code you were given. This copies the client brain here and does not set up GitHub.'
            : 'Paste the code you were given after you were added.'}
        </p>
      ) : mode === 'sent' ? (
        <p>Check {email}. Paste that code here.</p>
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
                try {
                  const row = await window.brain.plyntr.resolve(code)
                  await onJoin(row)
                } catch (e) {
                  const msg = String((e as Error).message || e)
                  if (onProject && /one project/i.test(msg)) {
                    const row = await window.brain.plyntr.joinProject(code)
                    await onProject(row)
                    return
                  }
                  throw e
                }
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

const MEMBER_ROLES = [
  ['owner', 'Owner'],
  ['scout', 'Scout'],
  ['team', 'Team'],
  ['project', 'Project only']
] as const

type MemberRole = (typeof MEMBER_ROLES)[number][0]

function roleName(role: string): string {
  return MEMBER_ROLES.find((r) => r[0] === role)?.[1] || role
}

export function PlyntrCompanyScreen({
  onSetupHere,
  onResume,
  embedded,
  hideBrainIds
}: {
  onSetupHere: (row: { brainId: string; slug: string; label: string; ownerEmail: string; code: string; repo: string }) => void
  onResume?: () => void
  embedded?: boolean
  hideBrainIds?: string[]
}) {
  const [phase, setPhase] = useState<'check' | 'login' | 'list' | 'form' | 'detail'>('check')
  const [email, setEmail] = useState('joe@plyntr.com')
  const [otp, setOtp] = useState('')
  const [label, setLabel] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [memberRole, setMemberRole] = useState<MemberRole>('owner')
  const [code, setCode] = useState('')
  const [emailed, setEmailed] = useState(false)
  const [companies, setCompanies] = useState<{ brainId: string; label: string; slug: string; org: string; repo: string }[]>([])
  const [details, setDetails] = useState<
    Record<string, { seats: { id: string; email: string; name: string; role: string; status: string }[]; invites: { inviteId: string; email: string; name: string; role: string; status: string }[] }>
  >({})
  const [people, setPeople] = useState<{
    brainId: string
    label: string
    slug: string
    org: string
    repo: string
    seats: { id: string; email: string; name: string; role: string; status: string }[]
    invites: { inviteId: string; email: string; name: string; role: string; status: string }[]
  } | null>(null)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addRole, setAddRole] = useState<MemberRole>('team')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  async function loadCompanies() {
    const rows = await window.brain.plyntr.companies()
    const hidden = new Set(hideBrainIds || [])
    const visible = rows.filter((row) => !hidden.has(row.brainId))
    setCompanies(visible)
    setPhase('list')
    const next: typeof details = {}
    await Promise.all(
      visible.map(async (row) => {
        try {
          const full = await window.brain.plyntr.company(row.brainId)
          next[row.brainId] = { seats: full.seats, invites: full.invites }
        } catch {
          next[row.brainId] = { seats: [], invites: [] }
        }
      })
    )
    setDetails(next)
  }

  async function openCompanyRow(brainId: string) {
    const row = await window.brain.plyntr.company(brainId)
    setPeople(row)
    setPhase('detail')
  }

  useEffect(() => {
    void window.brain.plyntr.pending().then((pend) => {
      if (!pend.platform) {
        setPhase('login')
        return
      }
      void loadCompanies().catch((e) => {
        setErr(String((e as Error).message || e))
        setPhase('list')
      })
    })
  }, [])

  const title =
    phase === 'login' || phase === 'check'
      ? 'Sign in as Plyntr first'
      : phase === 'form'
        ? 'Add the company'
        : phase === 'detail'
          ? people?.label || 'Company'
          : 'Companies'

  return (
    <>
      {embedded ? null : <p className="kicker">New company</p>}
      {embedded ? <h3 className="set-h">{title}</h3> : <h1>{title}</h1>}
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
      {phase === 'list' ? (
        <>
          <p>Each company is its own brain. People are listed under that company. Add or remove people from the brain you are in.</p>
          {companies.map((c) => {
            const peopleRow = details[c.brainId]
            const brain = c.repo.startsWith('pending/') ? 'GitHub not set up yet' : c.repo
            return (
              <section className="biz" key={c.brainId}>
                <h3>{c.label}</h3>
                <p className="biz-brain">Brain · {brain}</p>
                <p className="tiny">Not on this computer yet</p>
                {(peopleRow?.seats || [])
                  .filter((s) => s.status === 'active')
                  .map((s) => (
                    <div className="set-row" key={s.id}>
                      <span>
                        {s.name || s.email} · {s.email}
                        <span className="tiny"> · {roleName(s.role)}</span>
                      </span>
                    </div>
                  ))}
                {(peopleRow?.invites || [])
                  .filter((i) => i.status === 'pending')
                  .map((i) => (
                    <div className="set-row" key={i.inviteId}>
                      <span>
                        {i.name || i.email} · {i.email}
                        <span className="tiny"> · {roleName(i.role)} · waiting on their code</span>
                      </span>
                    </div>
                  ))}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setBusy(true)
                    setErr('')
                    setCode('')
                    void openCompanyRow(c.brainId)
                      .catch((e) => setErr(String((e as Error).message || e)))
                      .finally(() => setBusy(false))
                  }}
                >
                  Add someone or set this up here
                </button>
              </section>
            )
          })}
          {companies.length === 0 ? <p className="tiny">Every company brain is already on this computer, or there are no companies yet.</p> : null}
        </>
      ) : null}
      {phase === 'form' ? (
        <>
          <p>Their name, email, and seat are who the setup code belongs to. You will see the code, and we email it to them.</p>
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
          <label className="field">
            Seat
            <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as MemberRole)}>
              {MEMBER_ROLES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {memberRole === 'project' ? (
            <p className="tiny">Project only can be chosen now. Their folders are picked after this brain is on GitHub.</p>
          ) : null}
        </>
      ) : null}
      {phase === 'detail' && people ? (
        <>
          <p>
            {people.repo.startsWith('pending/')
              ? 'GitHub is not set up yet. Set this brain up on this Mac to create the repo and install Plyntr sync. That is the same setup an owner walks through.'
              : `GitHub repo ${people.repo}. Set this brain up on this Mac if it is not on this computer yet.`}
          </p>
          {code ? (
            <p>
              Code for {ownerName || addName || 'them'}: <span className="phone-pin">{code}</span>
              {emailed ? ' We also emailed it.' : ' Email did not send. Hand them this code.'}
            </p>
          ) : null}
          {people.seats
            .filter((s) => s.status === 'active')
            .map((s) => (
              <div className="set-row" key={s.id}>
                <span>
                  {s.name || s.email} · {s.email}
                  <span className="tiny"> · {roleName(s.role)}</span>
                </span>
              </div>
            ))}
          {people.invites
            .filter((i) => i.status === 'pending')
            .map((i) => (
              <div className="set-row" key={i.inviteId}>
                <span>
                  {i.name} · {i.email}
                  <span className="tiny"> · {roleName(i.role)} · waiting on their code</span>
                </span>
              </div>
            ))}
          <label className="field">
            Name
            <input value={addName} onChange={(e) => setAddName(e.target.value)} />
          </label>
          <label className="field">
            Email
            <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} />
          </label>
          <label className="field">
            Seat
            <select value={addRole} onChange={(e) => setAddRole(e.target.value as MemberRole)}>
              {MEMBER_ROLES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
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
                  await loadCompanies()
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
        {phase === 'list' ? (
          <button
            className="primary"
            type="button"
            onClick={() => {
              setErr('')
              setLabel('')
              setOwnerName('')
              setOwnerEmail('')
              setMemberRole('owner')
              setPhase('form')
            }}
          >
            Add a company
          </button>
        ) : null}
        {phase === 'form' ? (
          <>
            <button className="ghost" type="button" onClick={() => setPhase('list')}>
              Back
            </button>
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
                    ownerEmail: ownerEmail.trim(),
                    role: memberRole
                  })
                  setCode(created.code)
                  setEmailed(created.emailed)
                  await openCompanyRow(created.brainId)
                } catch (e) {
                  setErr(String((e as Error).message || e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Create the company
            </button>
          </>
        ) : null}
        {phase === 'detail' && people ? (
          <>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setCode('')
                setBusy(true)
                void loadCompanies()
                  .catch((e) => setErr(String((e as Error).message || e)))
                  .finally(() => setBusy(false))
              }}
            >
              All companies
            </button>
            <button
              className="ghost"
              type="button"
              disabled={busy || addName.trim().length < 2 || !addEmail.includes('@')}
              onClick={async () => {
                setBusy(true)
                setErr('')
                try {
                  const res = await window.brain.plyntr.companyInvite(people.brainId, {
                    name: addName.trim(),
                    email: addEmail.trim().toLowerCase(),
                    role: addRole
                  })
                  setCode(res.code)
                  setEmailed(res.emailed)
                  setOwnerName(addName.trim())
                  setAddName('')
                  setAddEmail('')
                  setAddRole('team')
                  await openCompanyRow(people.brainId)
                } catch (e) {
                  setErr(String((e as Error).message || e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Add this person
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setErr('')
                try {
                  const claimed = await window.brain.plyntr.claimCompany(people.brainId)
                  onSetupHere({
                    brainId: claimed.brainId,
                    slug: claimed.slug,
                    label: claimed.label || people.label,
                    ownerEmail: claimed.email,
                    code,
                    repo: claimed.repo || people.repo
                  })
                } catch (e) {
                  setErr(String((e as Error).message || e))
                  setBusy(false)
                }
              }}
            >
              Set this brain up on this Mac
            </button>
          </>
        ) : null}
      </div>
    </>
  )
}

export function PlyntrCreateScreen({
  initial,
  gateFirst,
  onCloned,
  onBindBack
}: {
  initial: CreatePending | null
  gateFirst: boolean
  onCloned: (brainPath: string) => void
  onBindBack?: (fn: (() => boolean) | null) => void
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
  const [repo, setRepo] = useState(resolvePlyntrRepoName(initial?.org || '', initial?.slug || ''))
  const [installOpened, setInstallOpened] = useState(false)
  const [bridgeOpened, setBridgeOpened] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [nameAdvice, setNameAdvice] = useState<{
    preferred: string
    free: boolean
    takenType: string
    suggestion: string
  } | null>(null)
  const createId = initial?.createId || ''
  const wantRepo = resolvePlyntrRepoName(org, slug, repo)
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
  useEffect(() => {
    return window.brain.setup.onBack((ev) => {
      const login = String(ev.org || '').trim()
      if (login) setOrg(login)
    })
  }, [])
  useEffect(() => {
    if (step !== 2 || !slug) {
      setNameAdvice(null)
      return
    }
    let live = true
    void window.brain.setup.adviseOrg(slug).then((row) => {
      if (live) setNameAdvice(row)
    })
    return () => {
      live = false
    }
  }, [step, slug])

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

  useEffect(() => {
    if (!onBindBack) return
    onBindBack(() => {
      const prev = previousCreateStep(step, Boolean(brainId))
      if (prev == null) return false
      if (step === 5) {
        setInstallOpened(false)
        setBridgeOpened(false)
      }
      void save(prev)
      return true
    })
    return () => onBindBack(null)
  }, [step, brainId, label, org, slug, email])

  return (
    <>
      <p className="kicker">New company brain</p>
      <h1>
        {step === 0
          ? 'Platform sign-in'
          : step === 1
            ? 'Business name'
              : step === 2
              ? 'Create a GitHub organization'
              : step === 3
                ? 'Create the brain'
                : step === 4
                  ? 'Create the client brain repository'
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
          <p>{orgStepCopy(label, slug, nameAdvice, org)}</p>
          <label className="field">
            Short name
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Appears after you copy it" />
          </label>
        </>
      ) : null}
      {step === 3 && !brainId ? <p className="tiny">This creates your scout seat. The code for the client comes later in Settings.</p> : null}
      {step === 4 ? (
        <p>
          This Mac creates {wantRepo || `${org}/${slug}-brain`}. You do not make an empty repository. After Plyntr sync is installed
          on {org}, this Mac copies the client brain onto this computer.
        </p>
      ) : null}
      {step === 5 ? (
        <p>
          Install Plyntr sync on {org}, then install Brain Bridge on the same repository. GitHub should show {org} with{' '}
          {wantRepo} already checked. Keep Only select repositories. Do not choose All repositories. If the page says
          Plyntr LLC, do not click Install. Close that page and click Open GitHub again. After both are on {wantRepo},
          this Mac copies the client brain template onto this computer.
        </p>
      ) : null}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
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
        {step === 2 && org.trim() ? (
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
            Open GitHub again
          </button>
        ) : null}
        {step === 5 && installOpened ? (
          <button
            className="ghost"
            type="button"
            onClick={() => {
              void window.brain.setup.openPlyntrInstall(brainId, org, wantRepo).then((opened) => {
                if (!opened.ok) setErr(opened.detail || 'The install page did not open on this organization.')
              })
            }}
          >
            Open GitHub again
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
                const raw = org.trim()
                const pastedRepo = Boolean(slug) && raw.toLowerCase() === `${slug}-brain`.toLowerCase()
                const typed = pastedRepo ? slug : raw
                if (!typed) {
                  void window.brain.setup.openCreateOrg().then((r) => {
                    const login = String(r?.org || '').trim()
                    if (login) setOrg(login)
                  })
                  return
                }
                const look = await window.brain.setup.lookupOrg(typed)
                if (!look.ok || look.type !== 'Organization') {
                  const advice = slug ? await window.brain.setup.adviseOrg(slug).catch(() => nameAdvice) : nameAdvice
                  const freeName = advice?.suggestion || slug
                  if (pastedRepo && advice?.suggestion) setOrg(advice.suggestion)
                  setErr(orgUseError(raw, slug, pastedRepo, look, freeName))
                  return
                }
                const login = look.login || typed
                setOrg(login)
                if (brainId) {
                  const placed = await window.brain.plyntr.place({ brainId, org: login })
                  if (placed.slug) setSlug(placed.slug)
                  const want = placed.repo
                  if (!want) {
                    setErr(NO_REPO)
                    return
                  }
                  const made = await window.brain.setup.createPlyntrRepo(login, placed.slug || slug, want)
                  if (!made.ok) {
                    setErr(made.detail || 'GitHub did not create the repository.')
                    return
                  }
                  setRepo(made.repo || want)
                  await save(5, { org: login, slug: placed.slug || slug })
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
                  if (!repo) {
                    setErr(NO_REPO)
                    return
                  }
                  const made = await window.brain.setup.createPlyntrRepo(org, slug, repo)
                  if (!made.ok) {
                    setErr(made.detail || 'GitHub did not create the repository.')
                    return
                  }
                  setRepo(made.repo || repo)
                  await save(5, { scoutEmail, brainId })
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
                if (!res.repo) {
                  setHasSeat(true)
                  setErr(NO_REPO)
                  await save(4, { scoutEmail, brainId: res.brainId })
                  return
                }
                const made = await window.brain.setup.createPlyntrRepo(org, slug, res.repo)
                if (!made.ok) {
                  setHasSeat(true)
                  setRepo(res.repo)
                  setErr(made.detail || 'GitHub did not create the repository.')
                  await save(4, { scoutEmail, brainId: res.brainId })
                  return
                }
                setRepo(made.repo || res.repo)
                setHasSeat(true)
                await save(5, { scoutEmail, brainId: res.brainId })
                return
              }
              if (step === 4) {
                if (!repo) {
                  setErr(NO_REPO)
                  return
                }
                const made = await window.brain.setup.createPlyntrRepo(org, slug, repo)
                if (!made.ok) {
                  setErr(made.detail || 'GitHub did not create the repository.')
                  return
                }
                setRepo(made.repo)
                await save(5)
                return
              }
              if (step === 5) {
                if (!installOpened) {
                  const opened = await window.brain.setup.openPlyntrInstall(brainId, org, wantRepo)
                  if (!opened.ok) {
                    setErr(opened.detail || 'The install page did not open on this organization.')
                    return
                  }
                  setInstallOpened(true)
                  return
                }
                const want = wantRepo
                const st = await window.brain.plyntr.installed(brainId, want).catch(() => null)
                const sel = String(st?.repositorySelection || '').toLowerCase()
                if (sel === 'all' || sel === 'all_repositories') {
                  setErr(
                    `Plyntr sync is on All repositories for ${org}. Choose Only select repositories, pick ${want}, then click Check GitHub.`
                  )
                  return
                }
                if (!st?.ready) {
                  setErr(
                    `Plyntr sync is not on ${want} yet. On the GitHub page, click Install, keep Only select repositories, pick ${want}, then click Check GitHub.`
                  )
                  return
                }
                const bridge = await window.brain.setup.bridgeOnRepo(want).catch(() => null)
                if (!bridge?.installed) {
                  if (!bridgeOpened) {
                    const opened = await window.brain.setup.openBridgeRepo(want)
                    if (!opened.ok) {
                      setErr(opened.detail || 'The Brain Bridge page did not open on this organization.')
                      return
                    }
                    setBridgeOpened(true)
                    setErr('')
                    return
                  }
                  setErr(
                    `Brain Bridge is not on ${want} yet. On the GitHub page, click Install, keep Only select repositories, pick ${want}, then click Check GitHub.`
                  )
                  return
                }
                await save(6)
                return
              }
              const applied = await window.brain.setup.putFolderPlyntr({
                brainId,
                org,
                slug,
                repo: resolvePlyntrRepoName(org, slug, repo)
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
          {step === 2 && !org.trim()
            ? 'Open GitHub'
            : step === 2
              ? 'Use this organization'
              : step === 4
                ? 'Create the repository'
                  : step === 5 && !installOpened
                    ? 'Open GitHub'
                    : step === 5 && installOpened && !bridgeOpened
                      ? 'Check GitHub'
                    : step === 5
                      ? 'Check GitHub'
                      : step === 6
                        ? 'Copy the folder'
                        : 'Next'}
        </button>
      </div>
    </>
  )
}
