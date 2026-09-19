import { useEffect, useState } from 'react'
import { STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { blankSession, stepState } from './flow'
import { TerminalWorkspace } from './TerminalWorkspace'
import { SettingsPanel } from './SettingsPanel'
import { SetupNeeds } from './SetupNeeds'
import { WorkPulse } from './WorkPulse'

export function FirstRun() {
  const [s, setS] = useState<Session>(() => blankSession('create', true))
  const [setupCode, setSetupCode] = useState('')
  const [otp, setOtp] = useState('')
  const [choice, setChoice] = useState<'new' | 'existing' | ''>('')
  const [org, setOrg] = useState('')
  const [showOrg, setShowOrg] = useState(false)

  const [err, setErr] = useState('')
  const [detected, setDetected] = useState<Partial<Record<AiKind, boolean>>>({})
  const [showInvite, setShowInvite] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [waitSec, setWaitSec] = useState(0)
  const [updatedLine, setUpdatedLine] = useState('')
  const [projectSeat, setProjectSeat] = useState<{ folder: string; label: string } | null>(null)
  const [loginVia, setLoginVia] = useState<'ads2ai' | 'hq-sync' | ''>('')
  const [sync, setSync] = useState<{ ok: boolean; line: string } | null>(null)

  useEffect(() => {
    void (async () => {
      const e = await window.brain.env()
      const st = await window.brain.setup.status()
      const acct = await window.brain.auth.session()
      const existing = e.existingBrain
      const d = await window.brain.ai.detect()
      setDetected(d)
      const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
      const email = acct.signedIn ? acct.email : existing?.email || ''
      const hqMini = acct.source === 'hq-sync'
      const folder = hqMini ? acct.folder || e.projectSeat?.folder || '' : existing?.brainPath || acct.folder || ''
      setProjectSeat(e.projectSeat ? { folder: e.projectSeat.folder, label: e.projectSeat.label } : null)
      let screen = 'email'
      if (acct.signedIn && (st.ready || (folder && pick))) screen = 'chat'
      else if (acct.signedIn && (st.watching || folder)) screen = 'aipick'
      else if (acct.signedIn) screen = 'needs'
      if (e.justUpdated) {
        setUpdatedLine(`Updated to ${e.justUpdated.to}. Your chats are where you left them.`)
      }
      setS((prev) => ({
        ...prev,
        dryRun: e.dryRun,
        brainPath: folder || prev.brainPath,
        role: acct.role || prev.role,
        business: existing?.name || prev.business || 'this computer',
        email,
        abWatching: st.watching,
        path: st.watching ? 'second' : prev.path,
        screen,
        ai: prev.ai || pick
      }))
    })().catch(() => {})
  }, [])

  useEffect(() => {
    void window.brain.hqSync.health().then(setSync).catch(() => {})
    return window.brain.onSyncHealth(setSync)
  }, [])

  async function skipToExisting() {
    const w = await window.brain.ab.watching()
    if (!w.brainPath) {
      setErr('Agency Brain is not watching a folder on this computer yet.')
      return
    }
    go('aipick', {
      path: 'second',
      brainPath: w.brainPath,
      business: w.name || 'this computer',
      email: w.email || '',
      abWatching: true
    })
  }

  function go(screen: string, patch?: Partial<Session>) {
    setErr('')
    setS((prev) => ({ ...prev, screen, ...patch }))
  }

  useEffect(() => {
    if (!showInvite) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setShowInvite(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showInvite])

  useEffect(() => {
    if (s.screen !== 'aiwork' || !s.ai) return
    void window.brain.ai.login(s.ai as AiKind).catch((e) => setErr(String((e as Error).message || e)))
  }, [s.screen, s.ai])

  useEffect(() => {
    if (s.screen !== 'abapply') return
    let stop = false
    void (async () => {
      const applied = await window.brain.setup.applyFolder(s.team?.slug ? { teamSlug: s.team.slug } : undefined).catch((e) => {
        if (!stop) setErr(String((e as Error).message || e))
        return null
      })
      if (stop || !applied?.brainPath) return
      setS((p) => ({ ...p, brainPath: applied.brainPath || p.brainPath, abWatching: true }))
    })()
    return () => {
      stop = true
    }
  }, [s.screen])

  useEffect(() => {
    const waiting = s.screen === 'aiwork' || (s.screen === 'abapply' && !s.abWatching)
    if (!waiting) {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [s.screen, s.abWatching])

  async function afterMembership(patch?: Partial<Session>) {
    const slug = patch?.team?.slug || s.team?.slug
    if (slug) await window.brain.setup.ensureRepo(slug).catch(() => {})
    const applied = await window.brain.setup.applyFolder(slug ? { teamSlug: slug } : undefined).catch((e) => {
      setErr(String((e as Error).message || e))
      return null
    })
    const brainPath = applied?.brainPath || s.brainPath || patch?.brainPath
    const st = await window.brain.setup.status()
    const d = await window.brain.ai.detect()
    setDetected(d)
    const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
    const next = { ...patch, ai: patch?.ai || pick, brainPath }
    if (st.ready || (brainPath && pick)) go('chat', { ...next, abWatching: st.watching })
    else if (st.watching || brainPath) go('aipick', { ...next, abWatching: st.watching })
    else go('needs', next)
  }

  const title = s.business || 'Brain'

  function startChat() {
    go('chat')
  }

  async function logOut() {
    await window.brain.auth.logout()
    setShowInvite(false)
    go('email')
  }

  async function afterProject(res: {
    email: string
    name: string
    brainPath: string
    teamName: string
    roots?: string[]
  }) {
    const d = await window.brain.ai.detect()
    setDetected(d)
    const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
    go(pick ? 'chat' : 'aipick', {
      email: res.email,
      role: 'project',
      brainKind: 'project',
      brainPath: res.brainPath,
      business: res.teamName,
      path: 'join',
      member: { email: res.email, name: res.name },
      abWatching: true
    })
  }

  return (
    <div className={`app ${s.screen === 'chat' ? 'chat-on' : ''} ${!railOpen && s.screen !== 'chat' ? 'rail-off' : ''} ${updatedLine ? 'has-update' : ''}`}>
      <div className="titlebar">
        <span>{title}</span>
        {s.role ? (
          <span className="role-lock">
            {s.role === 'project' ? 'Project only' : s.role === 'team' || s.role === 'member' ? 'Agency team' : s.role === 'scout' ? 'Scout' : 'Owner'}
            {s.brainKind === 'project' ? ' · project' : s.brainKind === 'hq' ? ' · HQ' : ''}
          </span>
        ) : null}
        <span className={`sync-pill ${sync?.ok ? 'on' : ''}`} title={sync?.line || ''}>
          {sync?.line ||
            (s.abWatching
              ? s.role === 'project' || s.brainKind === 'project'
                ? 'Project folders syncing'
                : 'Agency Brain · watching this folder'
              : 'Folder not syncing')}
        </span>
        {s.email ? <span className="tiny" style={{ marginLeft: 'auto' }}>{s.email}</span> : null}
        {s.screen === 'chat' || s.email ? (
          <button type="button" className="ghost title-set" onClick={() => void logOut()}>
            Log out
          </button>
        ) : null}
        <button type="button" className="ghost title-set settings-toggle" onClick={() => setShowInvite(!showInvite)}>
          Settings
        </button>
      </div>
      {updatedLine ? (
        <div className="update-note">
          <span>{updatedLine}</span>
          <button type="button" className="linkish" onClick={() => setUpdatedLine('')}>
            Ok
          </button>
        </div>
      ) : null}
      {showInvite && (
        <>
          <div className="settings-scrim" onMouseDown={() => setShowInvite(false)} />
          <SettingsPanel
            role={s.role}
            onClose={() => setShowInvite(false)}
            onLogout={() => void logOut()}
          />
        </>
      )}
      <div className="body">
        {s.screen !== 'chat' ? (
        <aside className="rail">
          <h2>Where you are</h2>
          {STEPS.map((st) => {
            const k = stepState(s, st.id)
            const mark = k === 'done' ? '✓' : k === 'now' ? '·' : k === 'blocked' ? '–' : ''
            return (
              <div className={`step ${k}`} key={st.id}>
                <span className="mark">{mark}</span>
                <span>
                  {st.label}
                  {st.id === 'invite' && s.path === 'join' ? ' (owner does this)' : ''}
                </span>
              </div>
            )
          })}
        </aside>
        ) : null}
        <section className="main">
          {s.screen !== 'chat' && (
            <div className="demo">
              <span>Chat is live against the folder Agency Brain is watching. New GitHub orgs and clones stay off.</span>
            </div>
          )}
          {s.screen === 'needs' && (
            <SetupNeeds
              onReady={({ ready, watching, ai }) => {
                const pick = ai || s.ai
                if (ready) go('chat', { abWatching: true, brainPath: s.brainPath, ai: pick })
                else if (watching) go('aipick', { abWatching: true, ai: pick })
              }}
              onCode={() => go('welcome')}
            />
          )}
          {s.screen === 'welcome' && (
            <>
              <p className="kicker">Welcome</p>
              <h1>Enter your setup code.</h1>
              <p>Whoever added you sent a short code. It's already tied to your email and this brain. Paste it here. You don't need to type your email.</p>
              <label className="field">
                Setup code
                <input
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.toUpperCase())}
                  placeholder="BR4-7XK"
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
              </label>
              <p className="tiny">Six letters and numbers, from the invite or from Your Clients.</p>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  disabled={setupCode.replace(/[^A-Za-z0-9]/g, '').length !== 6}
                  onClick={async () => {
                    try {
                      const res = await window.brain.auth.resolveCode(setupCode)
                      const role = String(res.member?.role || 'team').toLowerCase()
                      const kind = (res.kind === 'client' ? 'client' : 'agency') as 'client' | 'agency'
                      const business = res.teamName || res.teamSlug || ''
                      const email = res.member?.email || ''
                      const canBuild =
                        kind === 'client' ? role === 'owner' : role === 'owner' || role === 'scout' || role === 'head_scout'
                      const needsGithub = canBuild && !res.repoUrl
                      const patch = {
                        email,
                        business,
                        kind,
                        role,
                        member: res.member,
                        team: { slug: res.teamSlug, name: business, role, kind, repoUrl: res.repoUrl },
                        path: (needsGithub ? 'create' : role === 'team' || role === 'member' ? 'join' : 'second') as PathKind
                      }
                      if (needsGithub) go('abget', patch)
                      else if (role === 'team' || role === 'member') go('hello', { ...patch, path: 'join' })
                      else go('abget', { ...patch, path: 'second' })
                    } catch (e) {
                      const msg = String((e as Error).message || e)
                      if (/not found|404/i.test(msg)) setErr("I couldn't find that code. Check the invite and type it exactly.")
                      else if (/expired|410/i.test(msg)) setErr('That code has expired. Ask for a fresh one.')
                      else if (/github app|409/i.test(msg)) setErr("This brain isn't fully set up on GitHub yet. Give it a few minutes, then try again.")
                      else setErr(msg)
                    }
                  }}
                >
                  Continue
                </button>
                <button className="linkish" type="button" onClick={() => go('email')}>
                  I don't have a code
                </button>
                <button className="ghost" type="button" onClick={() => void skipToExisting()}>
                  This computer already has a brain — skip to chat
                </button>
              </div>
            </>
          )}
          {s.screen === 'email' && (
            <>
              <p className="kicker">Sign in</p>
              <h1>Sign in with your email.</h1>
              <p>
                Owners, scouts, and agency team get an Agency Brain code. Project only people get a code from this
                app. You do not pick which. Type the email you were invited with.
              </p>
              <label className="field">
                Your email
                <input value={s.email} onChange={(e) => setS({ ...s, email: e.target.value })} placeholder="you@company.com" />
              </label>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  disabled={!s.email.includes('@')}
                  onClick={async () => {
                    try {
                      const sent = await window.brain.auth.requestCode(s.email)
                      setLoginVia(sent.via)
                      go('otp')
                    } catch (e) {
                      setErr(String((e as Error).message || e))
                    }
                  }}
                >
                  Email me a code
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={!s.email.includes('@')}
                  onClick={() => go('otp')}
                >
                  I already have a code
                </button>
                <button className="linkish" type="button" onClick={() => go('welcome')}>
                  I have a setup code
                </button>
                <button className="ghost" type="button" onClick={() => void skipToExisting()}>
                  This computer already has a brain — skip to chat
                </button>
                {projectSeat ? (
                  <button
                    className="linkish"
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await window.brain.hqSync.openExisting()
                        await afterProject(res)
                      } catch (e) {
                        setErr(String((e as Error).message || e))
                      }
                    }}
                  >
                    Open {projectSeat.label} already on this computer
                  </button>
                ) : null}
              </div>
            </>
          )}
          {s.screen === 'otp' && (
            <>
              <p className="kicker">Check your email</p>
              <h1>Enter the sign-in code we sent.</h1>
              <p className="muted">{s.email}</p>
              <label className="field">
                Code
                <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="184 392" />
              </label>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await window.brain.auth.verify(
                        s.email,
                        otp,
                        loginVia || undefined
                      )
                      if (res.via === 'hq-sync') {
                        await afterProject({
                          email: res.member.email,
                          name: res.member.name || res.member.email,
                          brainPath: res.brainPath || '',
                          teamName: res.teamName || 'Brain'
                        })
                        return
                      }
                      const st = await window.brain.setup.status()
                      const email = String(res.member?.email || s.email).toLowerCase()
                      if (st.ready) {
                        go('chat', { email, member: res.member, abWatching: true })
                        return
                      }
                      if (st.watching) {
                        go('aipick', { email, member: res.member, abWatching: true })
                        return
                      }
                      const teams = res.teams || []
                      const role = String(res.member?.role || '').toLowerCase()
                      const teamLike = role === 'team' || role === 'member'
                      if (s.path === 'join' || teamLike) go('hello', { email, teams, member: res.member, role: role || 'team' })
                      else go('choice', { email, teams, member: res.member })
                    } catch (e) {
                      setErr(String((e as Error).message || e))
                    }
                  }}
                >
                  Continue
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    try {
                      const sent = await window.brain.auth.requestCode(s.email)
                      setLoginVia(sent.via)
                      setErr('Check that inbox for a six-digit code. It lasts ten minutes.')
                    } catch (e) {
                      setErr(String((e as Error).message || e))
                    }
                  }}
                >
                  Email me a new code
                </button>
                <button className="linkish" type="button" onClick={() => go('email')}>
                  Back
                </button>
              </div>
            </>
          )}
          {s.screen === 'choice' && (
            <>
              <p className="kicker">Owner or scout</p>
              <h1>Is this brain already set up?</h1>
              <p>Teammates never see this.</p>
              <button type="button" className={`choice ${choice === 'new' ? 'on' : ''}`} onClick={() => setChoice('new')}>
                <h3>I'm setting this brain up</h3>
                <p>First time. We'll get Agency Brain on this computer, then GitHub, then the conversation.</p>
              </button>
              <button type="button" className={`choice ${choice === 'existing' ? 'on' : ''}`} onClick={() => setChoice('existing')}>
                <h3>It's already set up. I need it on this computer.</h3>
                <p>Second laptop, or someone else already created it. We will not make a second brain.</p>
              </button>
              <div className="actions">
                <button className="primary" type="button" disabled={!choice} onClick={() => {
                  if (choice === 'existing') go('abget', { path: 'second' })
                  else go('name', { path: 'create' })
                }}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'hello' && (
            <>
              <p className="kicker">You're in</p>
              <h1>This is {s.business}'s brain.</h1>
              <p>The setup code already knew you as {s.member?.name || s.email || 'you'}. Shared notes and an AI that already knows the shop. You talk to it here.</p>
              <span className="role-lock">Your role: {s.role || 'teammate'} · set by the owner</span>
              <p className="muted">Next we put the shared folder on this computer and connect your AI. You stay in this window.</p>
              <div className="actions"><button className="primary" type="button" onClick={() => void afterMembership()}>Continue</button></div>
            </>
          )}
          {s.screen === 'name' && (
            <>
              <p className="kicker">The business</p>
              <h1>What's it called?</h1>
              <label className="field">Business name
                <input value={s.business} onChange={(e) => setS({ ...s, business: e.target.value })} placeholder="Harold's Books" />
              </label>
              <p className="tiny">This name is what we send to Agency Brain as the team name. GitHub still needs a real organization (next).</p>
              <div className="actions">
                <button className="primary" type="button" disabled={s.business.trim().length < 2} onClick={() => go('abget')}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'abget' && (
            <>
              <p className="kicker">Owner and scout</p>
              <h1>Next: GitHub, then this folder.</h1>
              <p>{s.business ? `This is ${s.business}` : 'This brain'}{s.email ? `, for ${s.email}` : ''}.</p>
              <div className="warn-box">
                <h3>What happens where</h3>
                <ol>
                  <li>This app: your email, the brain folder, Git, and your AI.</li>
                  <li>GitHub (opens in your browser, so a passkey works): create a free organization if you need one, then install the sharing app. Choose Only select repositories.</li>
                  <li>Skip Agency Brain’s own wizard. Do not enter the code or create the organization there too.</li>
                </ol>
              </div>
              <div className="actions">
                <button className="primary" type="button" onClick={async () => {
                  if (s.path === 'second') await afterMembership()
                  else go('github')
                }}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'github' && (
            <>
              <p className="kicker">Private place</p>
              <h1>A GitHub organization, then Continue.</h1>
              <p>GitHub will open in your browser. Sign in there (a passkey works). Create a free organization if you need one, then we install the sharing app. Come back here when GitHub is done. Do not also do this in Agency Brain.</p>
              <div className="warn-box">
                <h3>In the GitHub page</h3>
                <p>
                  Choose <strong>Only select repositories</strong>, then this brain. Never All repositories.
                </p>
              </div>
              <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                <button className="ghost" type="button" onClick={() => window.brain.setup.openCreateOrg()}>Create a free organization</button>
              </div>
              <label className="field" style={{ marginTop: '1rem' }}>Organization name
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
              </label>
              <p><button className="linkish" type="button" onClick={() => setShowOrg(!showOrg)}>{showOrg ? 'Hide' : 'I already have an organization'}</button></p>
              {showOrg && <p className="tiny">Type it above. We'll check it's an organization, not a person.</p>}
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="ghost" type="button" onClick={() => void skipToExisting()}>
                  Skip GitHub. Use the brain already on this computer
                </button>
                <button className="primary" type="button" disabled={org.trim().length < 2} onClick={async () => {
                  try {
                    setErr('')
                    const look = await window.brain.setup.lookupOrg(org.trim())
                    if (look && look.ok === false) { setErr(look.reason || 'GitHub did not accept that name'); return }
                    const created = (await window.brain.setup.createTeam(s.business)) as {
                      skipped?: boolean
                      team?: { slug?: string }
                    }
                    if (created?.skipped) {
                      await afterMembership({ orgLogin: org.trim() })
                      return
                    }
                    const slug = String(created?.team?.slug || '').trim()
                    if (!slug) {
                      setErr('Could not make the team.')
                      return
                    }
                    await window.brain.setup.openAppInstall(slug, org.trim())
                    setErr('Waiting for GitHub. Finish in your browser, then come back here.')
                    const until = Date.now() + 120000
                    let installed = false
                    while (Date.now() < until) {
                      const st = (await window.brain.setup.pollInstall(slug).catch(() => null)) as {
                        installed?: boolean
                      } | null
                      if (st?.installed) {
                        installed = true
                        break
                      }
                      await new Promise((r) => setTimeout(r, 2000))
                    }
                    if (!installed) {
                      setErr('GitHub is not on that organization yet. Authorize Agency Brain Sync, then Continue with GitHub again.')
                      return
                    }
                    await afterMembership({ orgLogin: org.trim() })
                  } catch (e) { setErr(String((e as Error).message || e)) }
                }}>Continue with GitHub</button>
              </div>
            </>
          )}
          {s.screen === 'abapply' && (
            <>
              <p className="kicker">Shared folder</p>
              <h1>Putting the shared folder on this computer.</h1>
              <div className="warn-box">
                <h3>Before we start: you may need to allow access</h3>
                <p>
                  We clone the team brain with the same GitHub access Agency Brain Sync uses. Git may ask for a
                  password or a browser sign-in. This does not erase other folders.
                </p>
              </div>
              <p className="tiny">
                {s.email ? `${s.email} · ` : ''}
                {s.business || 'This brain'}
                {s.orgLogin || org ? ` · ${s.orgLogin || org}` : ''}
              </p>
              {!s.brainPath ? <WorkPulse label="Getting the shared folder" seconds={waitSec} /> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => void afterMembership()}
                >
                  {s.brainPath ? 'Continue' : 'Get the folder'}
                </button>
              </div>
            </>
          )}
          {s.screen === 'aipick' && (
            <>
              <p className="kicker">Talking</p>
              <h1>Which AI should this use?</h1>
              <p>Pick who you start with. You can open the others later from + in the tab bar.</p>
              <div className="warn-box">
                <h3>Before we start: you will need to allow access</h3>
                <p>
                  The first time, that AI may open a browser so you can sign in with your own account. Accept that sign-in
                  if it appears.
                </p>
              </div>
              <div className="ai-grid">
                {([['claude', 'Claude'], ['grok', 'Grok'], ['cursor', 'Cursor'], ['gpt', 'ChatGPT']] as const).map(([id, n]) => (
                  <button type="button" key={id} className={`ai ${s.ai === id ? 'on' : ''}`} onClick={() => setS({ ...s, ai: id })} disabled={detected[id] === false}>
                    <strong>{n}</strong><span>{detected[id] === false ? 'not found' : detected[id] ? 'ready' : ''}</span>
                  </button>
                ))}
              </div>
              <div className="actions">
                <button className="primary" type="button" disabled={!s.ai} onClick={() => go('aiwork')}>
                  Continue with {s.ai === 'gpt' ? 'ChatGPT' : s.ai ? s.ai[0].toUpperCase() + s.ai.slice(1) : '…'}
                </button>
              </div>
            </>
          )}
          {s.screen === 'aiwork' && (
            <>
              <p className="kicker">Working</p>
              <h1>
                Opening{' '}
                {s.ai === 'gpt' ? 'ChatGPT' : s.ai === 'cursor' ? 'Cursor' : s.ai === 'claude' ? 'Claude' : 'Grok'} in
                this window.
              </h1>
              <div className="warn-box">
                <h3>Before we start: you will need to allow access</h3>
                <p>
                  This AI uses its own sign-in. A browser or Terminal window may open. Sign in with your own account,
                  then come back here.
                </p>
              </div>
              <WorkPulse
                label={`Starting ${s.ai === 'gpt' ? 'ChatGPT' : s.ai === 'cursor' ? 'Cursor' : s.ai === 'claude' ? 'Claude' : 'Grok'}`}
                seconds={waitSec}
              />
              <p className="tiny">{s.brainPath ? `Folder: ${s.brainPath}` : 'Using the folder Agency Brain is watching.'}</p>
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => startChat()}
                >
                  I signed in. Start
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => void window.brain.ai.login(s.ai as AiKind).catch((e) => setErr(String((e as Error).message || e)))}
                >
                  Open sign-in again
                </button>
              </div>
            </>
          )}
          {s.screen === 'chat' && (
            <TerminalWorkspace session={s} showInvite={showInvite} setShowInvite={setShowInvite} railOpen={railOpen} setRailOpen={setRailOpen} />
          )}
        </section>
      </div>
    </div>
  )
}
