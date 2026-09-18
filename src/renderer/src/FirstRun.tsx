import { useEffect, useState } from 'react'
import { OWNER_NEEDS, STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { blankSession, needsDone, remainingNeeds, stepState } from './flow'
import { TerminalWorkspace } from './TerminalWorkspace'
import { BridgeWizard, type BridgeDraft } from './BridgeWizard'
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

  useEffect(() => {
    void (async () => {
      const e = await window.brain.env()
      const st = await window.brain.setup.status()
      const existing = e.existingBrain
      const d = await window.brain.ai.detect()
      setDetected(d)
      const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
      setS((prev) => ({
        ...prev,
        dryRun: e.dryRun,
        brainPath: existing?.brainPath || prev.brainPath,
        business: existing?.name || prev.business || 'this computer',
        email: existing?.email || prev.email,
        abWatching: st.watching,
        path: st.watching ? 'second' : prev.path,
        screen: st.ready ? 'chat' : 'needs',
        ai: prev.ai || pick
      }))
    })().catch(() => {})
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
    if (s.screen !== 'aiwork' || !s.ai) return
    void window.brain.ai.login(s.ai as AiKind).catch((e) => setErr(String((e as Error).message || e)))
  }, [s.screen, s.ai])

  useEffect(() => {
    if (s.screen !== 'abapply') return
    let stop = false
    void window.brain.setup.install('ab').catch(() => {})
    const loop = async () => {
      while (!stop) {
        const st = await window.brain.setup.status()
        if (st.watching) {
          setS((p) => ({ ...p, abWatching: true }))
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    void loop()
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
    const st = await window.brain.setup.status()
    const d = await window.brain.ai.detect()
    setDetected(d)
    const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
    const next = { ...patch, ai: patch?.ai || pick }
    if (st.ready) go('chat', { ...next, abWatching: true })
    else if (st.watching) go('aipick', { ...next, abWatching: true })
    else go('needs', next)
  }

  const title = s.business || 'Brain'

  function startChat() {
    go('chat')
  }

  return (
    <div className={`app ${s.screen === 'chat' ? 'chat-on' : ''} ${!railOpen && s.screen !== 'chat' ? 'rail-off' : ''}`}>
      <div className="titlebar">
        <span>{title}</span>
        {s.role ? (
          <span className="role-lock">
            {s.role === 'team' || s.role === 'member' ? 'Team' : s.role === 'scout' ? 'Scout' : 'Owner'}
            {s.brainKind === 'project' ? ' · project' : s.brainKind === 'hq' ? ' · HQ' : ''}
          </span>
        ) : null}
        <span className={`sync-pill ${s.abWatching ? 'on' : ''}`}>
          {s.abWatching ? 'Agency Brain · watching this folder' : 'Folder not watching yet'}
        </span>
        <button type="button" className="ghost title-set" onClick={() => setShowInvite(true)}>
          Settings
        </button>
      </div>
      {showInvite && (
        <SettingsPanel
          role={s.role}
          onClose={() => setShowInvite(false)}
        />
      )}
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
          {s.screen === 'bridge' && (
            <BridgeWizard
              watching={s.abWatching}
              onCancel={() => go('welcome')}
              onDone={(draft: BridgeDraft) => {
                const role = draft.role
                const teamLike = role === 'team'
                void window.brain.settings.clients().then((list) => {
                  const row = {
                    company: draft.company,
                    slug: draft.slug,
                    hqName: draft.hqName,
                    hqAddress: draft.hqAddress,
                    projects: draft.projects,
                    setupLink: draft.setupLink
                  }
                  const rest = (list as { slug?: string }[]).filter((c) => c.slug !== draft.slug)
                  return window.brain.settings.saveClients([...rest, row])
                })
                go(teamLike ? 'chat' : s.abWatching ? 'chat' : 'aipick', {
                  role,
                  brainKind: draft.brainKind,
                  business: draft.hqName || draft.company || s.business,
                  path: teamLike ? 'join' : s.abWatching ? 'second' : 'create'
                })
              }}
            />
          )}
          {s.screen === 'needs' && (
            <SetupNeeds
              onReady={({ ready, watching, ai }) => {
                const pick = ai || s.ai
                if (ready) go('chat', { abWatching: true, brainPath: s.brainPath, ai: pick })
                else if (watching) go('aipick', { abWatching: true, ai: pick })
              }}
              onCode={() => go('welcome')}
              onBridge={() => go('bridge')}
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
                <button className="ghost" type="button" onClick={() => go('bridge')}>
                  Set up HQ and project brains
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
              <h1>Get Agency Brain on this computer.</h1>
              <p>{s.business ? `This is ${s.business}` : 'This brain'}{s.email ? `, for ${s.email}` : ''}. Agency Brain keeps the shared folder in sync.</p>
              <div className="warn-box">
                <h3>Before we start: you will need to allow access</h3>
                <p>
                  Your browser will open the Agency Brain download. Put it in Applications (or run the Windows installer),
                  then open it. macOS may say the app is from the internet: click Open. Sign in, then pick the shared folder.
                </p>
              </div>
              <div className="actions">
                <button className="primary" type="button" onClick={async () => {
                  await window.brain.setup.install('ab').catch(() => {})
                  if (s.path === 'second') await afterMembership()
                  else go('github')
                }}>Download Agency Brain</button>
              </div>
            </>
          )}
          {s.screen === 'github' && (
            <>
              <p className="kicker">Private place</p>
              <h1>A GitHub organization, then Continue.</h1>
              <p>GitHub will not let the brain live on a personal account. Make a free organization (or use one you already have), then we'll install the sharing app on it. That GitHub page is the one screen we don't own.</p>
              <div className="warn-box">
                <h3>Before we start: you will need to allow access</h3>
                <p>
                  GitHub may ask you to sign in. When you install the sharing app, choose <strong>Only select repositories</strong>,
                  then this brain. Never All repositories.
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
                    const look = await window.brain.setup.lookupOrg(org.trim())
                    if (look && look.ok === false) { setErr(look.reason || 'GitHub did not accept that name'); return }
                    await window.brain.setup.createTeam(s.business)
                    await window.brain.setup.openAppInstall('new-team', org.trim())
                    await afterMembership({ orgLogin: org.trim() })
                  } catch (e) { setErr(String((e as Error).message || e)) }
                }}>Continue with GitHub</button>
              </div>
            </>
          )}
          {s.screen === 'abapply' && (
            <>
              <p className="kicker">Shared folder</p>
              <h1>Waiting for Agency Brain to watch a folder.</h1>
              <div className="warn-box">
                <h3>Before we start: you will need to allow access</h3>
                <p>
                  We opened Agency Brain. Sign in, pick the shared folder, and click Open if macOS says the app is from
                  the internet. This window continues when that folder is watching. It will not mark watching on its own.
                </p>
              </div>
              <p className="tiny">
                {s.email ? `${s.email} · ` : ''}
                {s.business || 'This brain'}
                {s.orgLogin || org ? ` · ${s.orgLogin || org}` : ''}
              </p>
              {!s.abWatching ? <WorkPulse label="Waiting for Agency Brain to watch a folder" seconds={waitSec} /> : null}
              <div className="actions">
                <button className="primary" type="button" disabled={!s.abWatching} onClick={() => go('aipick', { abWatching: true })}>
                  Continue
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => void afterMembership()}
                >
                  Recheck
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
                  I signed in. Open Chat
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
