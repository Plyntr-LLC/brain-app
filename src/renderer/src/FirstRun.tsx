import { useEffect, useMemo, useState } from 'react'
import { DOWNLOAD_AB, OWNER_NEEDS, STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { blankSession, needsDone, remainingNeeds, stepState } from './flow'
import { TerminalWorkspace } from './TerminalWorkspace'
import { WorldClocks } from './WorldClocks'

export function FirstRun() {
  const [s, setS] = useState<Session>(() => blankSession('create', true))
  const [setupCode, setSetupCode] = useState('')
  const [otp, setOtp] = useState('')
  const [choice, setChoice] = useState<'new' | 'existing' | ''>('')
  const [org, setOrg] = useState('')
  const [showOrg, setShowOrg] = useState(false)
  const [tick, setTick] = useState(0)
  const [err, setErr] = useState('')
  const [detected, setDetected] = useState<Partial<Record<AiKind, boolean>>>({})
  const [showInvite, setShowInvite] = useState(false)
  const [railOpen, setRailOpen] = useState(true)

  useEffect(() => {
    window.brain?.env().then((e) => {
      const existing = e.existingBrain as { brainPath?: string | null; name?: string | null; email?: string | null; watching?: boolean } | undefined
      const ready = Boolean(existing?.brainPath)
      setS((prev) => ({
        ...prev,
        dryRun: e.dryRun,
        brainPath: existing?.brainPath || prev.brainPath,
        business: existing?.name || prev.business || 'this computer',
        email: existing?.email || prev.email,
        abWatching: ready,
        path: ready ? 'second' : prev.path,
        screen: ready ? 'chat' : prev.screen,
        ai: prev.ai || 'grok'
      }))
    }).catch(() => {})
    window.brain?.ai.detect().then((d) => {
      setDetected(d)
      setS((prev) => {
        if (prev.ai) return prev
        const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.gpt ? 'gpt' : undefined
        return pick ? { ...prev, ai: pick } : prev
      })
    }).catch(() => {})
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
    if (screen === 'abapply' || screen === 'aiwork') setTick(0)
  }

  useEffect(() => {
    if (s.screen !== 'abapply' && s.screen !== 'aiwork') return
    const max = s.screen === 'abapply' ? 6 : 4
    if (tick >= max) {
      if (s.screen === 'abapply') setS((p) => ({ ...p, abWatching: true }))
      return
    }
    const t = setTimeout(() => setTick((n) => n + 1), 450)
    return () => clearTimeout(t)
  }, [s.screen, tick])

  const title = s.business || 'Brain'

  function startChat() {
    go('chat')
  }

  const abItems = useMemo(() => {
    if (s.path !== 'create') {
      return [
        'Signing Agency Brain in with your email',
        'Looking up the existing brain (will not create a new one)',
        'Putting that folder on this computer',
        'Sync is on. This window will not push git.'
      ]
    }
    return [
      'Installing Agency Brain in the background',
      `Signing it in with ${s.email || 'your email'}`,
      'Using the GitHub login you already did',
      org ? `Using ${org}` : `Waiting on a GitHub organisation for ${s.business}`,
      'Copying the Agency Brain template (not an empty folder)',
      'Watching the folder. Skills and .team-config stay with Agency Brain.'
    ]
  }, [s, org])

  return (
    <div className={`app ${s.screen === 'chat' ? 'chat-on' : ''} ${!railOpen && s.screen !== 'chat' ? 'rail-off' : ''}`}>
      <div className="titlebar">
        <span>{title}</span>
        <span className={`sync-pill ${s.abWatching ? 'on' : ''}`}>
          {s.abWatching ? 'Agency Brain · watching this folder' : 'Folder not watching yet'}
        </span>
      </div>
      <WorldClocks />
      <div className="body">
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
          {s.screen === 'chat' && s.path !== 'join' && (
            <button className="primary rail-btn" type="button" onClick={() => setShowInvite(true)}>
              Invite
            </button>
          )}
          {s.screen === 'chat' && s.path !== 'second' && !needsDone(s) && (
            <>
              <h2 style={{ marginTop: '1.1rem' }}>The brain still needs</h2>
              {(s.path === 'join' ? remainingNeeds(s).concat() : OWNER_NEEDS).map((n) => (
                <div className={`need ${s.filled[n.id] ? 'got' : ''}`} key={n.id}>
                  <span>{s.filled[n.id] ? '✓' : '○'}</span>
                  <span>{n.label}</span>
                </div>
              ))}
            </>
          )}
        </aside>
        <section className="main">
          {s.screen !== 'chat' && (
            <div className="demo">
              <span>Chat is live against the folder Agency Brain is watching. New GitHub orgs and clones stay off.</span>
            </div>
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
              <p className="kicker">No code</p>
              <h1>Sign in with your email.</h1>
              <p>Use this if you're creating a brain that doesn't have a setup code yet. Same membership Agency Brain already uses.</p>
              <label className="field">
                Your email
                <input value={s.email} onChange={(e) => setS({ ...s, email: e.target.value })} placeholder="you@company.com" />
              </label>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="primary" type="button" disabled={!s.email.includes('@')} onClick={async () => {
                  try { await window.brain.auth.requestCode(s.email) } catch (e) { setErr(String((e as Error).message || e)); return }
                  go('otp')
                }}>Email me a sign-in code</button>
                <button className="linkish" type="button" onClick={() => go('welcome')}>I have a setup code</button>
              </div>
            </>
          )}
          {s.screen === 'otp' && (
            <>
              <p className="kicker">Check your email</p>
              <h1>Enter the sign-in code we sent.</h1>
              <p className="muted">{s.email}</p>
              <label className="field">Code<input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="184 392" /></label>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="primary" type="button" onClick={async () => {
                  try {
                    const res = await window.brain.auth.verify(s.email, otp)
                    const teams = res.teams || (await window.brain.auth.myTeams()).teams || []
                    if (s.path === 'join') go('hello', { teams, member: res.member })
                    else go('choice', { teams, member: res.member })
                  } catch (e) { setErr(String((e as Error).message || e)) }
                }}>Continue</button>
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
              <p className="muted">Agency Brain will put the folder on this computer in the background. You don't need to download anything extra.</p>
              <div className="actions"><button className="primary" type="button" onClick={() => go('abapply')}>Continue</button></div>
            </>
          )}
          {s.screen === 'name' && (
            <>
              <p className="kicker">The business</p>
              <h1>What's it called?</h1>
              <label className="field">Business name
                <input value={s.business} onChange={(e) => setS({ ...s, business: e.target.value })} placeholder="Harold's Books" />
              </label>
              <p className="tiny">This name is what we send to Agency Brain as the team name. GitHub still needs a real organisation (next).</p>
              <div className="actions">
                <button className="primary" type="button" disabled={s.business.trim().length < 2} onClick={() => go('abget')}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'abget' && (
            <>
              <p className="kicker">Owner and scout</p>
              <h1>Get Agency Brain on this computer.</h1>
              <p>{s.business ? `This is ${s.business}` : 'This brain'}{s.email ? `, for ${s.email}` : ''}. Agency Brain keeps the shared folder in sync. We'll start that in the background so you stay in this window. If the installer needs you, use the download.</p>
              <p className="tiny">We do not open Agency Brain's wizard in here. Your answers in this app are what it uses.</p>
              <div className="actions">
                <button className="primary" type="button" onClick={async () => {
                  await window.brain.ab.install().catch(() => {})
                  if (s.path === 'second') go('abapply')
                  else go('github')
                }}>Install in the background</button>
                <a className="dl" href={DOWNLOAD_AB} target="_blank" rel="noreferrer">Download Agency Brain</a>
              </div>
            </>
          )}
          {s.screen === 'github' && (
            <>
              <p className="kicker">Private place</p>
              <h1>A GitHub organisation, then Continue.</h1>
              <p>GitHub will not let the brain live on a personal account. Make a free organisation (or use one you already have), then we'll install the sharing app on it. That GitHub page is the one screen we don't own.</p>
              <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                <button className="ghost" type="button" onClick={() => window.brain.setup.openCreateOrg()}>Create a free organisation</button>
              </div>
              <label className="field" style={{ marginTop: '1rem' }}>Organisation name
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
              </label>
              <p><button className="linkish" type="button" onClick={() => setShowOrg(!showOrg)}>{showOrg ? 'Hide' : 'I already have an organisation'}</button></p>
              {showOrg && <p className="tiny">Type it above. We'll check it's an organisation, not a person.</p>}
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="ghost" type="button" onClick={() => void skipToExisting()}>
                  Skip GitHub. Use the brain already on this computer
                </button>
                <button className="primary" type="button" disabled={org.trim().length < 2} onClick={async () => {
                  try {
                    const look = await window.brain.setup.lookupOrg(org.trim())
                    if (look && look.ok === false) { setErr(look.reason || 'GitHub did not accept that name'); return }
                    await window.brain.setup.createTeam(s.business)
                    await window.brain.setup.openAppInstall('new-team', org.trim())
                    go('abapply', { orgLogin: org.trim() })
                  } catch (e) { setErr(String((e as Error).message || e)) }
                }}>Continue with GitHub</button>
              </div>
            </>
          )}
          {s.screen === 'abapply' && (
            <>
              <p className="kicker">In the background</p>
              <h1>Getting the shared folder ready.</h1>
              <div className="map">
                <strong style={{ fontFamily: 'Schibsted Grotesk, sans-serif', fontSize: '0.78rem' }}>Mapped into Agency Brain. You do not open that app.</strong>
                <br />Email: {s.email || '—'}
                <br />Business: {s.business || '—'}
                <br />GitHub org: {s.orgLogin || org || '—'}
                <br />Path: {s.path === 'create' ? 'Create from template' : 'Join existing folder'}
                {s.dryRun && <><br />dry-run: no config.json writes, no clone</>}
              </div>
              <ul className="work-list">
                {abItems.map((t, i) => (
                  <li key={t} className={tick > i ? 'done' : ''}>{tick > i ? '✓' : '·'} {t}</li>
                ))}
              </ul>
              <p className="tiny">Ready when Agency Brain is watching. {s.path !== 'join' && <>If install didn't start, <a href={DOWNLOAD_AB} target="_blank" rel="noreferrer">download Agency Brain</a>.</>}</p>
              <div className="actions">
                <button className="primary" type="button" disabled={!s.abWatching && tick < abItems.length} onClick={() => go('aipick', { abWatching: true })}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'aipick' && (
            <>
              <p className="kicker">Talking</p>
              <h1>Which AI should this use?</h1>
              <p>Pick who you start with. You can open the others later from + in the tab bar.</p>
              <div className="ai-grid">
                {([['claude', 'Claude', 'Claude Code'], ['grok', 'Grok', 'Grok CLI'], ['cursor', 'Cursor', 'cursor-agent'], ['gpt', 'ChatGPT', 'Codex CLI']] as const).map(([id, n, sub]) => (
                  <button type="button" key={id} className={`ai ${s.ai === id ? 'on' : ''}`} onClick={() => setS({ ...s, ai: id })} disabled={detected[id] === false}>
                    <strong>{n}</strong><span>{detected[id] === false ? 'not found' : detected[id] ? `ready · ${sub}` : sub}</span>
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
              <h1>Opening {s.ai === 'gpt' ? 'Codex' : s.ai === 'grok' ? 'Grok' : 'Claude'} in this window.</h1>
              <ul className="work-list">
                {['Found the CLI on this computer', "You're already signed in there", 'Pointing it at the Agency Brain folder'].map((t, i) => (
                  <li key={t} className={tick > i + 1 ? 'done' : ''}>{tick > i + 1 ? '✓' : '·'} {t}</li>
                ))}
              </ul>
              <p className="tiny">{s.brainPath ? `Folder: ${s.brainPath}` : 'Using the folder Agency Brain is watching.'}</p>
              <div className="actions">
                <button className="primary" type="button" disabled={tick < 4} onClick={async () => {
                  try {
                    await window.brain.ai.login(s.ai as AiKind)
                    startChat()
                  } catch (e) { setErr(String((e as Error).message || e)) }
                }}>Open it</button>
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
