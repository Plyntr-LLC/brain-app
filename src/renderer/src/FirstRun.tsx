import { useEffect, useMemo, useState } from 'react'
import { DOWNLOAD_AB, OWNER_NEEDS, STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { blankSession, fillFromText, needsDone, remainingNeeds, stepState } from './flow'

export function FirstRun() {
  const [s, setS] = useState<Session>(() => blankSession('create', true))
  const [setupCode, setSetupCode] = useState('')
  const [otp, setOtp] = useState('')
  const [choice, setChoice] = useState<'new' | 'existing' | ''>('')
  const [org, setOrg] = useState('')
  const [showOrg, setShowOrg] = useState(false)
  const [tick, setTick] = useState(0)
  const [err, setErr] = useState('')
  const [say, setSay] = useState('')
  const [messages, setMessages] = useState<{ who: 'brain' | 'me'; text: string }[]>([])
  const [pause, setPause] = useState<string | null>(null)
  const [people, setPeople] = useState<{ n: string; e: string; r: string }[]>([])
  const [invite, setInvite] = useState({ n: '', e: '', r: 'Teammate' })

  useEffect(() => {
    window.brain?.env().then((e) => setS((prev) => ({ ...prev, dryRun: e.dryRun }))).catch(() => {})
  }, [])

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
    let text = ''
    if (s.path === 'join') text = `This is ${s.business}'s shared brain. Your role is already set. ${remainingNeeds({ ...s, screen: 'chat' })[0]?.ask || ''}`
    else if (s.path === 'second') text = 'Welcome back. This computer is on the brain. Agency Brain is watching the folder. What do you want to do?'
    else text = `The shared folder is ready. I don't have a script. I need enough about the business for this brain to work. ${OWNER_NEEDS[0].ask}`
    setMessages([{ who: 'brain', text }])
    go('chat')
  }

  async function send(text: string, forceWork = false) {
    const t = text.trim()
    if (!t) return
    if (!forceWork && s.path !== 'join' && !needsDone(s) && /draft|invite |write |email|send |task/i.test(t)) {
      setPause(t)
      return
    }
    setSay('')
    const filled = fillFromText(s, t)
    const next = { ...s, filled }
    setS(next)
    const left = remainingNeeds(next)
    let reply: string
    if (s.path === 'join') reply = "I'll keep that in your private notes. What are you trying to get done?"
    else if (s.path === 'second' || needsDone(next)) {
      reply = needsDone(next) && s.path !== 'second'
        ? "That's enough for the brain to function. You can invite people now, or tell me the first real job for this week."
        : 'On it. (CLI, pointed at the folder Agency Brain is watching.)'
    } else {
      const skip = Object.values(filled).filter(Boolean).length > 1 ? 'I already have some of this. ' : ''
      reply = skip + (left[0]?.ask || '')
    }
    try {
      const live = await window.brain.chat.send(t)
      if (live && live.reply && !s.dryRun) reply = live.reply
    } catch { /* keep local */ }
    setMessages((m) => [...m, { who: 'me', text: t }, { who: 'brain', text: reply }])
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
    <div className="app">
      <div className="titlebar">
        <span>{title}</span>
        <span className={`sync-pill ${s.abWatching ? 'on' : ''}`}>
          {s.abWatching ? 'Agency Brain · watching this folder' : 'Folder not watching yet'}
        </span>
      </div>
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
          {s.dryRun && (
            <div className="demo">
              <span>Demo path:</span>
              {(['create', 'join', 'second'] as PathKind[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={s.path === p ? 'on' : ''}
                  onClick={() => {
                    setS(blankSession(p, true))
                    setMessages([])
                    setChoice(p === 'second' ? 'existing' : '')
                    setTick(0)
                  }}
                >
                  {p === 'create' ? 'Owner, first time' : p === 'join' ? 'Teammate' : 'Owner, this computer'}
                </button>
              ))}
              <span>dry-run on — will not touch Agency Brain config</span>
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
              <p className="tiny">Six letters and numbers, from the invite or from Your Clients. Dry-run accepts any six characters.</p>
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
              <p>Claude, Grok, or ChatGPT. The conversation is the same. It will run against the folder Agency Brain is watching.</p>
              <div className="ai-grid">
                {([['claude', 'Claude', 'Claude Code login'], ['grok', 'Grok', 'Grok CLI login'], ['gpt', 'ChatGPT', 'ChatGPT / Codex login']] as const).map(([id, n, sub]) => (
                  <button type="button" key={id} className={`ai ${s.ai === id ? 'on' : ''}`} onClick={() => setS({ ...s, ai: id })}>
                    <strong>{n}</strong><span>{sub}</span>
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
              <h1>Connecting {s.ai === 'gpt' ? 'ChatGPT' : s.ai === 'grok' ? 'Grok' : 'Claude'}.</h1>
              <ul className="work-list">
                {['Opening login', 'Checking the CLI is signed in', 'Pointing it at the Agency Brain folder'].map((t, i) => (
                  <li key={t} className={tick > i + 1 ? 'done' : ''}>{tick > i + 1 ? '✓' : '·'} {t}</li>
                ))}
              </ul>
              <div className="actions">
                <button className="primary" type="button" disabled={tick < 4} onClick={() => { void window.brain.ai.login(s.ai as AiKind); startChat() }}>Start the conversation</button>
              </div>
            </>
          )}
          {s.screen === 'chat' && (
            <div className="chat">
              {s.path === 'join' && <span className="role-lock">Role: Bookkeeper · you cannot change this</span>}
              {s.path !== 'join' && !needsDone(s) && (
                <div className="note">Questions follow what the brain still needs, not a script. A long first answer can skip several. Invites wait until those needs are filled.</div>
              )}
              {s.path !== 'join' && needsDone(s) && (
                <div className="note ok">The brain has what it needs. You can invite people, or just talk.</div>
              )}
              {s.parked.length > 0 && <p className="tiny">Parked until setup is done: {s.parked.join(' · ')}</p>}
              <div className="thread">
                {messages.map((m, i) => (
                  <div className={`bubble ${m.who === 'me' ? 'me' : ''}`} key={i}>{m.text}</div>
                ))}
              </div>
              {s.path !== 'join' && needsDone(s) && (
                <div style={{ border: '1px solid var(--line)', padding: '0.7rem 0.8rem', margin: '0 0 0.7rem', borderRadius: 2 }}>
                  <strong style={{ fontFamily: 'Schibsted Grotesk, sans-serif', fontSize: '0.85rem' }}>Invite someone</strong>
                  {people.map((p) => <p className="tiny" key={p.e}>{p.n} · {p.e} · {p.r}</p>)}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 8rem auto', gap: 6, marginTop: 8 }}>
                    <input placeholder="Name" value={invite.n} onChange={(e) => setInvite({ ...invite, n: e.target.value })} />
                    <input placeholder="Email" value={invite.e} onChange={(e) => setInvite({ ...invite, e: e.target.value })} />
                    <select value={invite.r} onChange={(e) => setInvite({ ...invite, r: e.target.value })}>
                      <option>Teammate</option><option>Scout</option><option>Owner</option>
                    </select>
                    <button className="ghost" type="button" onClick={() => {
                      if (!invite.n || !invite.e) return
                      setPeople([...people, invite])
                      setMessages((m) => [...m, { who: 'brain', text: `Invited ${invite.n} as ${invite.r}. Their role stays ${invite.r} unless you change it.` }])
                      setInvite({ n: '', e: '', r: 'Teammate' })
                    }}>Invite</button>
                  </div>
                </div>
              )}
              <div className="composer">
                <input value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(say) }} placeholder={needsDone(s) ? 'Ask the brain…' : 'Answer however you want…'} />
                <button className="primary" type="button" onClick={() => void send(say)}>Send</button>
              </div>
            </div>
          )}
        </section>
      </div>
      {pause && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(26,22,18,0.35)', display: 'grid', placeItems: 'center' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--ink)', padding: '1.1rem 1.15rem', maxWidth: 420 }}>
            <h2 style={{ margin: '0 0 0.4rem', fontSize: '1.1rem' }}>Pause setup for this?</h2>
            <p>We can do that task. The brain still has gaps, and you cannot invite anyone yet.</p>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="primary" type="button" onClick={() => {
                setS((p) => ({ ...p, parked: [...p.parked, pause] }))
                setPause(null)
                setMessages((m) => [...m, { who: 'brain', text: 'Saved that for after setup. ' + (remainingNeeds(s)[0]?.ask || '') }])
              }}>Save it until setup is done</button>
              <button className="ghost" type="button" onClick={() => { const t = pause; setPause(null); void send(t, true) }}>Pause setup and do it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
