import { useEffect, useState } from 'react'
import { slugFromBusinessName } from '@shared/plyntr-invite'

const PLATFORM =
  'Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login.'

type OrgAdvice = {
  preferred: string
  free: boolean
  takenType: string
  suggestion: string
}

function orgStepCopy(label: string, slug: string, advice: OrgAdvice | null): string {
  const company = label || 'This company'
  if (!slug) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, paste the address bar. It looks like github.com/orgs/the-name.`
  }
  if (!advice || advice.preferred !== slug) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, paste the address bar.`
  }
  if (advice.free) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. Set the organization account name to ${slug}. After GitHub creates it, the address bar is github.com/orgs/${slug}. Paste that address.`
  }
  if (advice.takenType === 'User') {
    return `${slug} is already a person's GitHub login, so an organization cannot use that name. Open GitHub and set the organization account name to ${advice.suggestion}. After GitHub creates it, paste the address bar.`
  }
  if (advice.takenType === 'Organization' && advice.suggestion && advice.suggestion !== slug) {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, create ${advice.suggestion} and paste that address bar.`
  }
  if (advice.takenType === 'Organization') {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, pick a different organization name on GitHub and paste the address bar.`
  }
  return `${company} is not on GitHub yet. Open GitHub and create a free organization. After GitHub creates it, paste the address bar.`
}

function orgUseError(
  raw: string,
  slug: string,
  pastedRepo: boolean,
  look: { reason?: string; detail?: string; login?: string },
  freeName: string
): string {
  if (pastedRepo && look.reason === 'personal-account') {
    return `${raw} is not a GitHub organization. ${slug} is already a person's login, so an organization cannot use that name. On GitHub, set the organization account name to ${freeName}. After GitHub creates it, paste the address bar.`
  }
  if (pastedRepo && look.reason === 'not-found') {
    return `${raw} is not a GitHub organization. Create the organization first. A free name is ${freeName}. After GitHub creates it, the address bar is github.com/orgs/${freeName}. Paste that address.`
  }
  if (look.reason === 'not-found') {
    const name = look.login || raw
    return `GitHub has no organization named ${name}. After you create it, the address bar is github.com/orgs/${name}. Paste that address.`
  }
  return look.detail || 'That GitHub name is not an organization yet. Paste the address bar after you create it.'
}

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

const MEMBER_ROLES = [
  ['owner', 'Owner'],
  ['scout', 'Scout'],
  ['team', 'Agency team'],
  ['project', 'Project only']
] as const

type MemberRole = (typeof MEMBER_ROLES)[number][0]

function roleName(role: string): string {
  return MEMBER_ROLES.find((r) => r[0] === role)?.[1] || role
}

export function PlyntrCompanyScreen({
  onSetupHere,
  onResume,
  embedded
}: {
  onSetupHere: (row: { brainId: string; slug: string; label: string; ownerEmail: string; code: string; repo: string }) => void
  onResume?: () => void
  embedded?: boolean
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
    setCompanies(rows)
    setPhase('list')
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
          <p>Open a company to see its people, add someone, or set that brain up on this Mac.</p>
          {companies.map((c) => (
            <div className="set-row" key={c.brainId}>
              <span>
                {c.label}
                <span className="tiny"> · {c.repo.startsWith('pending/') ? 'GitHub not set up yet' : c.repo}</span>
              </span>
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setBusy(true)
                  setErr('')
                  setCode('')
                  void openCompanyRow(c.brainId)
                    .catch((e) => setErr(String((e as Error).message || e)))
                    .finally(() => setBusy(false))
                }}
              >
                Open
              </button>
            </div>
          ))}
          {companies.length === 0 ? <p className="tiny">No companies yet.</p> : null}
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
  const [repoOpened, setRepoOpened] = useState(false)
  const [installOpened, setInstallOpened] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [nameAdvice, setNameAdvice] = useState<{
    preferred: string
    free: boolean
    takenType: string
    suggestion: string
  } | null>(null)
  const createId = initial?.createId || ''
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
                  ? 'Create the empty repository'
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
          <p>{orgStepCopy(label, slug, nameAdvice)}</p>
          <label className="field">
            Short name
            <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Appears after you copy it" />
          </label>
        </>
      ) : null}
      {step === 3 && !brainId ? <p className="tiny">This creates your scout seat. The code for the client comes later in Settings.</p> : null}
      {step === 4 ? (
        <p>
          Open GitHub. The repository name is {slug}-brain, under {org}. Leave Add a README unchecked. Create the
          repository. Come back here and click The repository is created.
        </p>
      ) : null}
      {step === 5 ? (
        <p>
          Open GitHub. Click Install. Choose Only select repositories. Pick {org}/{slug}-brain. Leave All repositories
          alone. Come back here and click Check GitHub.
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
        {step === 4 && repoOpened ? (
          <button className="ghost" type="button" onClick={() => void window.brain.setup.openPlyntrRepo(org, slug)}>
            Open GitHub again
          </button>
        ) : null}
        {step === 5 && installOpened ? (
          <button
            className="ghost"
            type="button"
            onClick={() => void window.brain.setup.openPlyntrInstall(brainId, org)}
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
                if (!repoOpened) {
                  await window.brain.setup.openPlyntrRepo(org, slug)
                  setRepoOpened(true)
                  return
                }
                await save(5)
                return
              }
              if (step === 5) {
                if (!installOpened) {
                  await window.brain.setup.openPlyntrInstall(brainId, org)
                  setInstallOpened(true)
                  return
                }
                const want = repo || `${org}/${slug}-brain`
                const st = await window.brain.plyntr.installed(brainId, want).catch(() => null)
                if (!st?.ready) {
                  setErr('Plyntr sync is not on this repository yet. On the GitHub page, click Install, choose Only select repositories, pick this repo, then click Check GitHub.')
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
          {step === 2 && !org.trim()
            ? 'Open GitHub'
            : step === 2
              ? 'Use this organization'
              : step === 4 && !repoOpened
                ? 'Open GitHub'
                : step === 4
                  ? 'The repository is created'
                  : step === 5 && !installOpened
                    ? 'Open GitHub'
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
