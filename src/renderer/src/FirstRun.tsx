import { useEffect, useRef, useState } from 'react'
import { STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { blankSession, stepState } from './flow'
import { TerminalWorkspace } from './TerminalWorkspace'
import { SettingsPanel } from './SettingsPanel'
import { SetupNeeds } from './SetupNeeds'
import { WorkPulse } from './WorkPulse'

function TwoApps() {
  return (
    <p className="two-apps">
      One app. It copies the shared brain onto this computer and keeps it in sync. You talk here.
    </p>
  )
}

function AwayBanner({
  kind
}: {
  kind: 'github-org' | 'github-install' | 'installer' | 'ai-login' | null
}) {
  if (!kind) return null
  const copy =
    kind === 'github-org'
      ? {
          title: 'A browser is open',
          body: 'Copy the GitHub short name (one word, like harolds-books, not your business name). We bring you back here when you copy it.'
        }
      : kind === 'github-install'
        ? {
            title: 'A browser is open',
            body: 'Click Install. Choose Only select repositories. We wait here and bring you back when GitHub is done.'
          }
        : kind === 'ai-login'
          ? {
              title: 'Sign-in is open',
              body: 'Finish in the browser or Terminal with your own account. We bring you back when you are signed in.'
            }
          : {
              title: 'An installer is open',
              body: 'Finish that window. We bring you back when it is done.'
            }
  return (
    <div className="warn-box">
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
    </div>
  )
}

export function FirstRun() {
  const [s, setS] = useState<Session>(() => blankSession('create', true))
  const [setupCode, setSetupCode] = useState('')
  const [otp, setOtp] = useState('')
  const [choice, setChoice] = useState<'new' | 'existing' | ''>('')
  const [org, setOrg] = useState('')
  const [githubOnlySelected, setGithubOnlySelected] = useState(false)
  const [bridgeOnlySelected, setBridgeOnlySelected] = useState(false)

  const [err, setErr] = useState('')
  const [detected, setDetected] = useState<Partial<Record<AiKind, boolean>>>({})
  const [showInvite, setShowInvite] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [waitSec, setWaitSec] = useState(0)
  const [updatedLine, setUpdatedLine] = useState('')
  const [projectSeat, setProjectSeat] = useState<{ folder: string; label: string } | null>(null)
  const [loginVia, setLoginVia] = useState<'ads2ai' | 'hq-sync' | ''>('')
  const [sync, setSync] = useState<{ ok: boolean; line: string } | null>(null)
  const [watching, setWatching] = useState(false)
  const [away, setAway] = useState<'github-org' | 'github-install' | 'ai-login' | null>(null)
  const bridgeOnce = useRef('')
  const folderPutKey = useRef('')
  const [folderCopyBusy, setFolderCopyBusy] = useState(false)

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
      const folder = existing?.brainPath || acct.folder || ''
      setProjectSeat(e.projectSeat ? { folder: e.projectSeat.folder, label: e.projectSeat.label } : null)
      setWatching(Boolean(existing?.watching || st.watching))
      const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
      let screen = 'email'
      const abMissing = st.items.some((i) => i.id === 'ab' && !i.present)
      if (acct.signedIn && st.ready && signed && folder && !abMissing) {
        const role = acct.role || ''
        if (role === 'project') screen = 'chat'
        else {
          const br = await window.brain.setup.bridgeStatus(folder).catch(() => null)
          screen = br?.installed || br?.skipped ? 'chat' : 'bridge'
        }
      } else if (acct.signedIn && folder && (abMissing || !st.ready)) screen = 'needs'
      else if (acct.signedIn && (st.watching || folder)) screen = 'aipick'
      else if (acct.signedIn) screen = 'needs'
      if (e.justUpdated) {
        setUpdatedLine(`Updated to ${e.justUpdated.to}. Your chats are where you left them.`)
      }
      setS((prev) => ({
        ...prev,
        dryRun: e.dryRun,
        brainPath: folder || st.brainPath || prev.brainPath,
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

  useEffect(() => {
    return window.brain.setup.onBack((ev) => {
      setAway(null)
      const login = String(ev.org || '').trim()
      if (login) setOrg((cur) => (cur.trim() ? cur : login))
    })
  }, [])

  async function useFolderOnThisComputer() {
    const w = await window.brain.ab.watching()
    if (!w.brainPath) {
      setErr('The shared folder is not on this computer yet. Finish GitHub so we can copy it here.')
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
    if (s.screen !== 'abget') return
    if (s.path === 'second') void afterMembership()
    else go('github')
  }, [s.screen, s.path])

  useEffect(() => {
    if (s.screen !== 'aiwork' || !s.ai) return
    setAway('ai-login')
    void window.brain.ai
      .loginWait(s.ai as AiKind)
      .then((r) => {
        setAway(null)
        if (r.signedIn) startChat()
        else if (r.detail) setErr(r.detail)
      })
      .catch((e) => {
        setAway(null)
        setErr(String((e as Error).message || e))
      })
  }, [s.screen, s.ai])

  useEffect(() => {
    if (s.screen === 'abapply' && !s.brainPath) setFolderCopyBusy(true)
  }, [s.screen, s.brainPath])

  useEffect(() => {
    if (s.screen !== 'abapply' || s.brainPath) return
    let stop = false
    void (async () => {
      const slug = s.team?.slug
      if (!slug) {
        if (!stop) setErr('GitHub is not finished. Go back and Continue with GitHub.')
        return
      }
      const key = `${slug}:${s.orgLogin || org}`
      if (folderPutKey.current === key) return
      folderPutKey.current = key
      setFolderCopyBusy(true)
      const applied = await window.brain.setup.putFolder({ teamSlug: slug, org: s.orgLogin || org }).catch((e) => {
        folderPutKey.current = ''
        setFolderCopyBusy(false)
        if (!stop) setErr(String((e as Error).message || e))
        return null
      })
      setFolderCopyBusy(false)
      if (stop || !applied?.brainPath) return
      setS((p) => ({ ...p, brainPath: applied.brainPath || p.brainPath, abWatching: true }))
    })()
    return () => {
      stop = true
    }
  }, [s.screen, s.team?.slug, s.orgLogin, org, s.brainPath])

  useEffect(() => {
    const waiting = s.screen === 'aiwork' || (s.screen === 'abapply' && !s.brainPath)
    if (!waiting) {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [s.screen, s.brainPath])

  async function retryFolderCopy() {
    if (folderCopyBusy) return
    const slug = s.team?.slug
    if (!slug) {
      setErr('GitHub is not finished. Go back to the GitHub step.')
      return
    }
    folderPutKey.current = ''
    setFolderCopyBusy(true)
    setErr('')
    try {
      await window.brain.setup.ensureRepo(slug)
      const applied = await window.brain.setup.putFolder({
        teamSlug: slug,
        org: s.orgLogin || org,
        retry: true
      })
      if (!applied?.brainPath) return
      setS((p) => ({ ...p, brainPath: applied.brainPath || p.brainPath, abWatching: true }))
      await afterMembership({ brainPath: applied.brainPath, team: s.team, orgLogin: s.orgLogin || org })
    } catch (e) {
      setErr(String((e as Error).message || e))
      folderPutKey.current = ''
    } finally {
      setFolderCopyBusy(false)
    }
  }

  async function afterMembership(patch?: Partial<Session>) {
    const slug = patch?.team?.slug || s.team?.slug
    const orgLogin = patch?.orgLogin || s.orgLogin || org
    let fail = ''
    const existingPath = String(patch?.brainPath || s.brainPath || '').trim()
    const applied = existingPath
      ? { ok: true as const, brainPath: existingPath }
      : slug
        ? await (async () => {
            setFolderCopyBusy(true)
            try {
              return await window.brain.setup.putFolder({ teamSlug: slug, org: orgLogin })
            } catch (e) {
              fail = String((e as Error).message || e)
              setErr(fail)
              folderPutKey.current = ''
              return null
            } finally {
              setFolderCopyBusy(false)
            }
          })()
        : await window.brain.setup.applyFolder().catch((e) => {
            fail = String((e as Error).message || e)
            setErr(fail)
            return null
          })
    const st = await window.brain.setup.status()
    const d = await window.brain.ai.detect()
    setDetected(d)
    const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
    const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
    const brainPath = fail ? undefined : applied?.brainPath || s.brainPath || patch?.brainPath || st.brainPath || undefined
    const next = { ...patch, ai: patch?.ai || pick, brainPath }
    if (!brainPath) {
      if (/not installed on GitHub/i.test(fail) && s.screen !== 'github') {
        go('github', { ...next, path: 'create' })
        return
      }
      if (/empty folder|not in the repo/i.test(fail)) {
        setErr(fail)
        return
      }
      if (s.screen === 'github' || s.screen === 'abget') return
      if (s.screen === 'abapply') return
      if (slug) {
        go('abapply', next)
        return
      }
      go('needs', next)
      return
    }
    if (await holdForBridge(next)) return
    const abMissing = st.items.some((i) => i.id === 'ab' && !i.present)
    if (!st.ready || abMissing) {
      go('needs', next)
      return
    }
    if (pick && signed && st.watching) go('chat', { ...next, abWatching: true })
    else go('aipick', { ...next, abWatching: st.watching })
  }

  async function holdForBridge(patch?: Partial<Session>): Promise<boolean> {
    const role = patch?.role || s.role
    const kind = patch?.brainKind || s.brainKind
    if (role === 'project' || kind === 'project' || patch?.bridgeOk || s.bridgeOk) return false
    const path = patch?.brainPath || s.brainPath || ''
    if (!path) return false
    const st = await window.brain.setup.bridgeStatus(path).catch(() => null)
    if (st?.installed) return false
    go('bridge', { ...patch, brainPath: path })
    return true
  }

  async function runBridge() {
    const path = s.brainPath || ''
    if (!path) {
      setErr('The shared folder is not on this computer yet.')
      return
    }
    if (!bridgeOnlySelected) {
      setErr('Check the box confirming you chose Only select repositories and picked this repo on GitHub.')
      return
    }
    if (bridgeOnce.current === path) return
    bridgeOnce.current = path
    setErr('')
    setAway('github-install')
    try {
      await window.brain.setup.openBridge(path)
      const waited = await window.brain.setup.waitBridge(path)
      setAway(null)
      if (!waited.ok) {
        bridgeOnce.current = ''
        setErr(waited.detail || 'Brain Bridge is not installed on this repo yet.')
        return
      }
      const d = await window.brain.ai.detect()
      setDetected(d)
      const pick: AiKind | undefined =
        s.ai || (d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined)
      const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
      const st = await window.brain.setup.status()
      const next = { bridgeOk: true, brainPath: path, ai: pick, abWatching: s.abWatching }
      if (!st?.ready) {
        go('needs', next)
        return
      }
      if (pick && signed) go('chat', next)
      else go('aipick', next)
    } catch (e) {
      setAway(null)
      bridgeOnce.current = ''
      setErr(String((e as Error).message || e))
    }
  }

  const title = (s.brainPath || '').split(/[/\\]/).filter(Boolean).pop() || s.business || 'Brain'

  function startChat() {
    void (async () => {
      const st = await window.brain.setup.status().catch(() => null)
      const path = s.brainPath || st?.brainPath || ''
      if (!path) go('aipick')
      else if (!st?.ready) go('needs')
      else if (await holdForBridge({ brainPath: path, abWatching: Boolean(st?.watching) })) return
      else go('chat', { brainPath: path, abWatching: Boolean(st?.watching) })
    })()
  }

  async function installOnGithub(rawLogin: string) {
    if (!githubOnlySelected) {
      setErr('Check the box confirming you chose Only select repositories on GitHub.')
      return
    }
    if (rawLogin.trim().length < 2) {
      setErr('Create the short name on GitHub, then paste it here.')
      return
    }
    try {
      setErr('')
      const look = await window.brain.setup.lookupOrg(rawLogin.trim())
      if (look && look.ok === false) {
        setErr(look.detail || look.reason || 'GitHub did not accept that name. Check the short name you copied.')
        return
      }
      if (look?.login) setOrg(look.login)
      let slug = String(s.team?.slug || '').trim()
      let teamName = s.team?.name || s.business
      if (!slug) {
        const created = (await window.brain.setup.createTeam(s.business)) as {
          skipped?: boolean
          team?: { slug?: string; name?: string }
        }
        if (created?.skipped) {
          setErr('This is a dry-run window. Use the packed Brain app to finish GitHub.')
          return
        }
        slug = String(created?.team?.slug || '').trim()
        teamName = created?.team?.name || s.business
      }
      if (!slug) {
        setErr('Could not make the team. Check the business name and try again.')
        return
      }
      const login = String(look?.login || rawLogin.trim())
      setAway('github-install')
      await window.brain.setup.openAppInstall(slug, login)
      const waited = await window.brain.setup.waitInstall(slug)
      setAway(null)
      if (!waited.ok) {
        setErr(waited.detail || 'The app is not installed on GitHub yet. Click Install in the browser, then try again.')
        return
      }
      folderPutKey.current = ''
      go('abapply', {
        orgLogin: login,
        team: { slug, name: teamName, role: s.role || 'owner' },
        brainPath: '',
        abWatching: false
      })
    } catch (e) {
      setAway(null)
      setErr(String((e as Error).message || e))
    }
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
    const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
    const path = res.brainPath
    go(pick && signed && path ? 'chat' : 'aipick', {
      email: res.email,
      role: 'project',
      brainKind: 'project',
      brainPath: path,
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
            onSwitchBrain={(row) => {
              setS((p) => ({ ...p, brainPath: row.path, business: row.name }))
              setShowInvite(false)
            }}
          />
        </>
      )}
      <div className="body">
        {s.screen !== 'chat' ? (
        <aside className="rail">
          <h2>Where you are</h2>
          {STEPS.map((st) => {
            const k = stepState(s, st.id)
            const mark = k === 'done' ? '✓' : '○'
            return (
              <div className={`step ${k}`} key={st.id}>
                <span className="mark">{mark}</span>
                <span>{st.label}</span>
              </div>
            )
          })}
        </aside>
        ) : null}
        <section className="main">
          {s.screen !== 'chat' ? <TwoApps /> : null}
          {s.screen !== 'chat' && s.dryRun ? (
            <div className="demo">
              <span>Dev dry-run. New GitHub short names and clones stay off until you pack the app.</span>
            </div>
          ) : null}
          {s.screen === 'needs' && (
            <SetupNeeds
              onReady={({ ready, watching, ai, brainPath }) => {
                const pick = ai || s.ai
                void (async () => {
                  const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
                  const path = brainPath || s.brainPath
                  if (!path) return
                  const patch = { abWatching: watching || Boolean(path), brainPath: path, ai: pick }
                  if (await holdForBridge(patch)) return
                  if (ready && signed) go('chat', patch)
                  else go('aipick', patch)
                })()
              }}
              onNeedFolder={() => go('github')}
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
                  onClick={async () => {
                    if (setupCode.replace(/[^A-Za-z0-9]/g, '').length !== 6) {
                      setErr('Paste the six-character setup code.')
                      return
                    }
                    try {
                      const res = await window.brain.auth.resolveCode(setupCode)
                      const role = String(res.member?.role || 'team').toLowerCase()
                      const kind = (res.kind === 'client' ? 'client' : 'agency') as 'client' | 'agency'
                      const business = res.teamName || res.teamSlug || ''
                      const email = res.member?.email || ''
                      const canBuild =
                        kind === 'client' ? role === 'owner' : role === 'owner' || role === 'scout' || role === 'head_scout'
                      const slug = String(res.teamSlug || '').trim()
                      const patch = {
                        email,
                        business,
                        kind,
                        role,
                        member: res.member,
                        team: { slug, name: business, role, kind, repoUrl: res.repoUrl },
                        path: (!canBuild ? 'join' : 'second') as PathKind
                      }
                      if (!canBuild) {
                        go('hello', { ...patch, path: 'join' })
                        return
                      }
                      const inst = slug
                        ? ((await window.brain.setup.pollInstall(slug).catch(() => null)) as {
                            installed?: boolean
                            repoUrl?: string
                          } | null)
                        : null
                      const repoReady =
                        inst?.installed === true &&
                        Boolean(String(inst?.repoUrl || (inst as { repo?: string })?.repo || '').trim())
                      if (repoReady && slug) {
                        try {
                          await window.brain.setup.ensureRepo(slug)
                        } catch (e) {
                          setErr(String((e as Error).message || e))
                          return
                        }
                        go('abapply', { ...patch, path: 'second' })
                        return
                      }
                      go('github', { ...patch, path: 'create' })
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
                {watching ? (
                  <button className="ghost" type="button" onClick={() => void useFolderOnThisComputer()}>
                    Use the folder already on this computer
                  </button>
                ) : null}
              </div>
            </>
          )}
          {s.screen === 'email' && (
            <>
              <p className="kicker">Sign in</p>
              <h1>Sign in with your email.</h1>
              <p>
                Owners, scouts, and agency team get a setup code. Project only people get a code from this app. You do
                not pick which. Type the email you were invited with.
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
                  onClick={async () => {
                    if (!s.email.includes('@')) {
                      setErr('Type the email you were invited with.')
                      return
                    }
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
                  onClick={() => {
                    if (!s.email.includes('@')) {
                      setErr('Type the email you were invited with.')
                      return
                    }
                    go('otp')
                  }}
                >
                  I already have a code
                </button>
                <button className="linkish" type="button" onClick={() => go('welcome')}>
                  I have a setup code
                </button>
                {watching ? (
                  <button className="ghost" type="button" onClick={() => void useFolderOnThisComputer()}>
                    Use the folder already on this computer
                  </button>
                ) : null}
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
                    if (otp.replace(/\s/g, '').length < 4) {
                      setErr('Type the six-digit code from that email.')
                      return
                    }
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
                      const d = await window.brain.ai.detect()
                      const pick: AiKind | undefined = d.grok
                        ? 'grok'
                        : d.claude
                          ? 'claude'
                          : d.cursor
                            ? 'cursor'
                            : d.gpt
                              ? 'gpt'
                              : undefined
                      const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
                      const path = st.brainPath || s.brainPath || ''
                      if (st.ready && signed && path) {
                        const patch = { email, member: res.member, abWatching: true, ai: pick, brainPath: path }
                        if (await holdForBridge(patch)) return
                        go('chat', patch)
                        return
                      }
                      if (st.watching || path) {
                        const patch = {
                          email,
                          member: res.member,
                          abWatching: Boolean(st.watching),
                          ai: pick,
                          brainPath: path || undefined
                        }
                        if (path && (await holdForBridge(patch))) return
                        go('aipick', patch)
                        return
                      }
                      const teams = res.teams || []
                      const role = String(res.member?.role || '').toLowerCase()
                      const teamLike = role === 'team' || role === 'member'
                      const patch = { email, teams, member: res.member, role: role || 'team' }
                      if (s.path === 'join' || teamLike) {
                        go('hello', patch)
                        return
                      }
                      const slug = String(teams[0]?.slug || '').trim()
                      if (slug) {
                        const inst = (await window.brain.setup.pollInstall(slug).catch(() => null)) as {
                          installed?: boolean
                          repoUrl?: string
                        } | null
                        const team = { slug, name: teams[0]?.name || slug, role: role || 'owner', repoUrl: inst?.repoUrl }
                        if (inst?.installed === true) {
                          go('abapply', { ...patch, path: 'second', team })
                          return
                        }
                        go('github', { ...patch, path: 'create', business: team.name, team })
                        return
                      }
                      go('choice', patch)
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
                <p>First time. We copy this team’s brain onto this computer, then GitHub if needed, then the conversation.</p>
              </button>
              <button type="button" className={`choice ${choice === 'existing' ? 'on' : ''}`} onClick={() => setChoice('existing')}>
                <h3>It's already set up. I need it on this computer.</h3>
                <p>Second laptop, or someone else already created it. We will not make a second brain.</p>
              </button>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="primary" type="button" onClick={() => {
                  if (!choice) {
                    setErr('Pick whether this brain is new or already set up.')
                    return
                  }
                  if (choice === 'existing') void afterMembership({ path: 'second' })
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
              <p className="tiny">A name people will recognise. Next we put a private copy on GitHub, then on this computer.</p>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button className="primary" type="button" onClick={() => {
                  if (s.business.trim().length < 2) {
                    setErr('Type the business name.')
                    return
                  }
                  go('github')
                }}>Continue</button>
              </div>
            </>
          )}
          {s.screen === 'abget' && (
            <>
              <p className="kicker">This computer</p>
              <h1>Getting the shared folder ready.</h1>
              <WorkPulse label="Working" seconds={waitSec} />
            </>
          )}
          {s.screen === 'github' && (
            <>
              <p className="kicker">GitHub · step 1 of 2</p>
              <h1>Company short name, then install our GitHub app.</h1>
              <p className="muted">
                This is not your business name. It is the one-word GitHub handle (like <strong>harolds-books</strong>).
                After that, GitHub opens an Install page. Choose <strong>Only select repositories</strong>, never All
                repositories.
              </p>
              <AwayBanner kind={away} />
              {!away ? (
                <div className="warn-box">
                  <h3>Two steps</h3>
                  <ol>
                    <li>Paste or create the short name below (or open GitHub to create it).</li>
                    <li>Click Install on GitHub, then Only select repositories. We wait here until GitHub is done.</li>
                  </ol>
                </div>
              ) : null}
              <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                <button
                  className="primary"
                  type="button"
                  onClick={async () => {
                    setAway('github-org')
                    setErr('')
                    const r = await window.brain.setup.openCreateOrg().catch((e) => {
                      setErr(String((e as Error).message || e))
                      return null
                    })
                    setAway(null)
                    const login = String(r?.org || '').trim()
                    if (login) {
                      setOrg(login)
                      await installOnGithub(login)
                    }
                  }}
                >
                  Open GitHub
                </button>
              </div>
              <label className="field" style={{ marginTop: '1rem' }}>
                GitHub short name
                <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
              </label>
              <p className="tiny">One word, like harolds-books, not your business name. A github.com address works too.</p>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={githubOnlySelected}
                  onChange={(e) => setGithubOnlySelected(e.target.checked)}
                  style={{ width: 'auto', marginTop: '0.2rem' }}
                />
                <span>I will click Install, then Only select repositories (not All repositories).</span>
              </label>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    const clip = await window.brain.setup.clipOrg()
                    const login = String(clip.org || '').trim()
                    if (!login) {
                      setErr('Create the short name on GitHub, then copy it.')
                      return
                    }
                    setOrg(login)
                    setErr('')
                  }}
                >
                  Paste from clipboard
                </button>
                <button className="primary" type="button" onClick={() => void installOnGithub(org)}>
                  Install on GitHub
                </button>
              </div>
            </>
          )}
          {s.screen === 'bridge' && (
            <>
              <p className="kicker">GitHub</p>
              <h1>Install Brain Bridge on this repo.</h1>
              <p>
                GitHub does not have Brain Bridge on this repository yet. The browser opens the install page. Click
                Install. Choose Only select repositories. Pick this repo. We stay here until GitHub says it is
                installed. Chat stays closed until then.
              </p>
              <AwayBanner kind={away} />
              <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={bridgeOnlySelected}
                  onChange={(e) => setBridgeOnlySelected(e.target.checked)}
                  style={{ width: 'auto', marginTop: '0.2rem' }}
                />
                <span>I will click Install, then Only select repositories, and pick this brain repo (not All repositories).</span>
              </label>
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => void runBridge()}
                >
                  Install Brain Bridge
                </button>
              </div>
            </>
          )}
          {s.screen === 'abapply' && (
            <>
              <p className="kicker">GitHub · step 2 of 2</p>
              <h1>{s.brainPath ? 'The shared folder is on this computer.' : 'Copying the shared folder onto this computer.'}</h1>
              <div className="warn-box">
                <h3>{s.brainPath ? 'This is the brain' : 'Stay here'}</h3>
                <p>
                  {s.brainPath
                    ? s.brainPath
                    : 'We copy from GitHub into ~/Projects. Next you will see One setup: Git, Cloudflare, Agency Brain, and your AI tool.'}
                </p>
              </div>
              <p className="tiny">
                {s.email ? `${s.email} · ` : ''}
                {s.business || 'This brain'}
                {s.orgLogin || org ? ` · ${s.orgLogin || org}` : ''}
              </p>
              {!s.brainPath ? <WorkPulse label="Getting the shared folder" seconds={waitSec} /> : null}
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  disabled={!s.brainPath && folderCopyBusy}
                  onClick={() => {
                    if (s.brainPath) void afterMembership()
                    else void retryFolderCopy()
                  }}
                >
                  {s.brainPath ? 'Continue to setup' : folderCopyBusy ? 'Copying…' : 'Try again'}
                </button>
                {!s.brainPath && err ? (
                  <>
                    <button className="ghost" type="button" onClick={() => go('github')}>
                      Back to GitHub
                    </button>
                    <button className="ghost" type="button" onClick={() => go('needs')}>
                      Set up this Mac
                    </button>
                  </>
                ) : null}
              </div>
            </>
          )}
          {s.screen === 'aipick' && (
            <>
              <p className="kicker">Talking</p>
              <h1>Which AI should this use?</h1>
              <p>Pick who you start with. You can open the others later from + in the tab bar.</p>
              <div className="warn-box">
                <h3>A browser or Terminal may open</h3>
                <p>
                  The first time, that AI asks you to sign in with your own account. Finish that sign-in. We bring you
                  back here.
                </p>
              </div>
              <div className="ai-grid">
                {([['claude', 'Claude'], ['grok', 'Grok'], ['cursor', 'Cursor'], ['gpt', 'ChatGPT']] as const).map(([id, n]) => (
                  <button type="button" key={id} className={`ai ${s.ai === id ? 'on' : ''}`} onClick={() => setS({ ...s, ai: id })} disabled={detected[id] === false}>
                    <strong>{n}</strong><span>{detected[id] === false ? 'not found' : detected[id] ? 'ready' : ''}</span>
                  </button>
                ))}
              </div>
              {err && <p className="note">{err}</p>}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    if (!s.ai) {
                      setErr('Pick Claude, Grok, Cursor, or ChatGPT.')
                      return
                    }
                    if (detected[s.ai] === false) {
                      setErr('Install Grok, Claude, Cursor, or ChatGPT on this computer, then pick it here.')
                      return
                    }
                    go('aiwork')
                  }}
                >
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
              <AwayBanner kind={away === 'ai-login' ? 'ai-login' : null} />
              {!away ? (
                <div className="warn-box">
                  <h3>Sign in with your own account</h3>
                  <p>
                    A browser or Terminal window may open. Finish that sign-in. We bring you back here.
                  </p>
                </div>
              ) : null}
              <WorkPulse
                label={`Starting ${s.ai === 'gpt' ? 'ChatGPT' : s.ai === 'cursor' ? 'Cursor' : s.ai === 'claude' ? 'Claude' : 'Grok'}`}
                seconds={waitSec}
              />
              <p className="tiny">{s.brainPath ? `Folder: ${s.brainPath}` : 'The shared folder must be on this computer first.'}</p>
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    if (away) {
                      setErr('Finish sign-in in the browser or Terminal. We will bring you back.')
                      return
                    }
                    if (!s.brainPath) {
                      setErr('The shared folder is not on this computer yet. Go back and finish GitHub.')
                      return
                    }
                    setAway(null)
                    startChat()
                  }}
                >
                  I signed in. Start
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setAway('ai-login')
                    void window.brain.ai.loginWait(s.ai as AiKind)
                      .then((r) => {
                        setAway(null)
                        if (r.signedIn) startChat()
                        else if (r.detail) setErr(r.detail)
                      })
                      .catch((e) => {
                        setAway(null)
                        setErr(String((e as Error).message || e))
                      })
                  }}
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
