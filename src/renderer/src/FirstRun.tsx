import { useEffect, useRef, useState } from 'react'
import { STEPS, type AiKind, type PathKind, type Session } from '@shared/contracts'
import { prettyEffort } from '@shared/effort'
import { ipcErrorText } from '@shared/plyntr-org-copy'
import { agencyVerifyButtons, plyntrJoinButtons } from '@shared/setup-guide'
import { openBrainAccountLabel } from '@shared/shell-switch'
import { blankSession, stepState } from './flow'
import { TerminalWorkspace } from './TerminalWorkspace'
import { SettingsPanel } from './SettingsPanel'
import { SetupNeeds } from './SetupNeeds'
import { ForkScreen, PlyntrCodeScreen, PlyntrCreateScreen, PlyntrProjectScreen } from './PlyntrPath'
import { WorkPulse } from './WorkPulse'

function TwoApps({ channel }: { channel?: string }) {
  return (
    <p className="two-apps">
      {channel === 'local'
        ? 'One app. This brain stays on this computer until you add GitHub sync.'
        : 'One app. You talk to your brain here.'}
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
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('brain-theme') === 'dark' ? 'dark' : 'light'))
  const [activeSeat, setActiveSeat] = useState<{ email?: string; label?: string; token?: string }>({ email: '', label: '', token: '' })
  const [superAdmin, setSuperAdmin] = useState(false)
  const [waitSec, setWaitSec] = useState(0)
  const [updatedLine, setUpdatedLine] = useState('')
  const [projectSeat, setProjectSeat] = useState<{ folder: string; label: string } | null>(null)
  const [loginVia, setLoginVia] = useState<'ads2ai' | 'hq-sync' | ''>('')
  const [plyntrCreate, setPlyntrCreate] = useState<{
    createId: string
    wizardStep: number
    label: string
    org: string
    slug: string
    scoutEmail: string
    brainId?: string
  } | null>(null)
  const [plyntrJoin, setPlyntrJoin] = useState(false)
  const [codeStartsInEmail, setCodeStartsInEmail] = useState(false)
  const [createGate, setCreateGate] = useState(false)
  const [sync, setSync] = useState<{ ok: boolean; line: string } | null>(null)
  const [watching, setWatching] = useState(false)
  const [away, setAway] = useState<'github-org' | 'github-install' | 'ai-login' | null>(null)
  const bridgeOnce = useRef('')
  const folderPutKey = useRef('')
  const navStack = useRef<string[]>([])
  const channelRef = useRef<string | undefined>(s.channel)
  const localJoin = useRef<{ brainId: string; repo: string; slug: string; role: string; email: string; name: string } | null>(null)
  const waitJoin = useRef<{ brainId: string; repo: string; slug: string; role: string; pending: boolean } | null>(null)
  const skipAgencyDraft = useRef(false)
  const driveApi = useRef<{
    setChannel: (channel: string) => void
    join: (row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) => Promise<void>
    pick: (kind: AiKind) => void
    read: () => { screen: string; buttons: string[]; strip: string; model: string; effort: string }
  } | null>(null)
  channelRef.current = s.channel
  const [folderCopyBusy, setFolderCopyBusy] = useState(false)

  function defaultBackScreen(current: string, session: Session): string | null {
    switch (current) {
      case 'otp':
        return 'email'
      case 'email':
      case 'plyntr-code':
      case 'plyntr-create':
      case 'plyntr-company':
      case 'plyntr-project':
        return 'fork'
      case 'welcome':
        return 'fork'
      case 'choice':
        return session.email ? 'otp' : 'welcome'
      case 'name':
        return 'choice'
      case 'github':
        return session.business.trim().length >= 2 ? 'name' : 'welcome'
      case 'abapply':
        return 'github'
      case 'bridge':
        return session.brainPath ? 'abapply' : 'github'
      case 'needs':
        if (session.channel === 'local') return 'plyntr-code'
        return session.brainPath ? 'abapply' : 'github'
      case 'aipick':
        return 'needs'
      case 'aiwork':
        return 'aipick'
      case 'hello':
        return 'welcome'
      case 'abget':
        return 'welcome'
      default:
        return null
    }
  }

  const plyntrWizardBack = useRef<(() => boolean) | null>(null)

  function goBack() {
    if (s.screen === 'plyntr-create' && plyntrWizardBack.current?.()) return
    const from = s.screen
    if (from === 'chat' || from === 'fork') return
    const prev = navStack.current.pop() ?? defaultBackScreen(from, s)
    if (!prev || prev === from) return
    setErr('')
    setAway(null)
    setFolderCopyBusy(false)
    if (from === 'abapply') folderPutKey.current = ''
    if (from === 'bridge') bridgeOnce.current = ''
    setS((p) => ({ ...p, screen: prev }))
  }

  useEffect(() => {
    void (async () => {
      const e = await window.brain.env()
      const st = await window.brain.setup.status()
      const acct = await window.brain.auth.session()
      const existing = e.existingBrain
      const d = await window.brain.ai.detect()
      setDetected(d)
      const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
      const email = acct.signedIn ? acct.email : ''
      const folder = existing?.brainPath || acct.folder || ''
      const pend = await window.brain.plyntr.pending().catch(() => null)
      setPlyntrCreate(pend?.create || null)
      setPlyntrJoin(Boolean(pend?.join))
      setProjectSeat(e.projectSeat ? { folder: e.projectSeat.folder, label: e.projectSeat.label } : null)
      setWatching(Boolean(existing?.watching || st.watching))
      const signed = pick ? Boolean((await window.brain.ai.signedIn(pick)).signedIn) : false
      const mode = folder ? await window.brain.setup.syncMode(folder).catch(() => '') : ''
      const pathB = mode === 'plyntr' || mode === 'local'
      let screen = 'fork'
      const abMissing = !pathB && st.items.some((i) => i.id === 'ab' && !i.present)
      const project = acct.role === 'project' || e.projectSeat
      if (!acct.signedIn) screen = 'fork'
      else if (project && (loginVia === 'hq-sync' || acct.role === 'project')) {
        screen = folder && signed ? 'chat' : 'aipick'
      } else if (pathB && folder && st.ready && signed) screen = 'chat'
      else if (pathB && folder && !st.ready) screen = 'needs'
      else if (pathB && folder) screen = 'aipick'
      else if (pend?.create || pend?.join) screen = 'fork'
      else if (acct.signedIn && st.ready && signed && folder && !abMissing) {
        const br = await window.brain.setup.bridgeStatus(folder).catch(() => null)
        screen = br?.installed || br?.skipped ? 'chat' : 'bridge'
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
        channel: mode === 'local' ? 'local' : mode === 'plyntr' ? 'plyntr' : prev.channel,
        screen,
        ai: prev.ai || pick
      }))
    })()
      .catch(() => {})
      .finally(() => {
        ;(window as unknown as { __brainBoot?: boolean }).__brainBoot = true
      })
  }, [])

  useEffect(() => {
    void window.brain.hqSync.health().then(setSync).catch(() => {})
    return window.brain.onSyncHealth(setSync)
  }, [])

  useEffect(() => {
    if (s.screen !== 'chat') return
    void window.brain.plyntr.clearCreate()
    void window.brain.plyntr.clearJoin()
  }, [s.screen])

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
    setS((prev) => {
      if (prev.screen !== screen) navStack.current.push(prev.screen)
      return { ...prev, screen, ...patch }
    })
  }

  async function openChatOrSignIn(
    pick: AiKind,
    path: string,
    patch: Partial<Session>
  ): Promise<'chat' | 'sign-in' | 'blocked'> {
    const gate = await window.brain.setup.tryOpen(pick, path)
    if (gate.opened) return 'chat'
    if (!gate.signedIn && gate.git) {
      go('aiwork', { ...patch, brainPath: path, ai: pick })
      return 'sign-in'
    }
    setErr(gate.detail || 'Chat stays closed until Git, Cloudflare Tunnel, and that AI are ready.')
    return 'blocked'
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
        setErr(ipcErrorText(e))
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
        if (!stop) setErr(ipcErrorText(e))
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
      setErr(ipcErrorText(e))
      folderPutKey.current = ''
    } finally {
      setFolderCopyBusy(false)
    }
  }

  async function afterMembership(patch?: Partial<Session>) {
    const slug = patch?.team?.slug || s.team?.slug
    const orgLogin = patch?.orgLogin || s.orgLogin || org
    let fail = ''
    const existingPath =
      patch && Object.prototype.hasOwnProperty.call(patch, 'brainPath')
        ? String(patch.brainPath || '').trim()
        : String(s.brainPath || '').trim()
    const role = patch?.role || s.role
    if (!skipAgencyDraft.current && !existingPath && (patch?.channel || s.channel) === 'agency' && role === 'owner') {
      const draft = await window.brain.setup.ensureDraft(`agency-${slug || 'owner'}`)
      const d0 = await window.brain.ai.detect()
      const who: AiKind | undefined = patch?.ai || (d0.grok ? 'grok' : d0.claude ? 'claude' : d0.cursor ? 'cursor' : d0.gpt ? 'gpt' : undefined)
      const team = { slug: slug || 'agency-trace', name: 'Agency', role: 'owner' as const }
      if (!who) {
        go('aipick', { brainPath: draft.path, channel: 'agency', role: 'owner', team })
        return
      }
      const routed = await openChatOrSignIn(who, draft.path, {
        brainPath: draft.path,
        ai: who,
        channel: 'agency',
        role: 'owner',
        team
      })
      if (routed === 'sign-in') return
      if (routed === 'blocked') {
        go('needs', { brainPath: draft.path, ai: who, channel: 'agency', role: 'owner', team })
        return
      }
      go('chat', {
        brainPath: draft.path,
        ai: who,
        channel: 'agency',
        role: 'owner',
        team
      })
      return
    }
    skipAgencyDraft.current = false
    const applied = existingPath
      ? { ok: true as const, brainPath: existingPath }
      : slug
        ? await (async () => {
            setFolderCopyBusy(true)
            try {
              const result = await window.brain.setup.putFolder({ teamSlug: slug, org: orgLogin })
              if (result && result.ok === false) {
                fail = result.detail || 'The app is not installed on GitHub yet.'
                setErr(fail)
                return null
              }
              return result
            } catch (e) {
              fail = ipcErrorText(e)
              setErr(fail)
              folderPutKey.current = ''
              return null
            } finally {
              setFolderCopyBusy(false)
            }
          })()
        : await window.brain.setup.applyFolder().catch((e) => {
            fail = ipcErrorText(e)
            setErr(fail)
            return null
          })
    const st = await window.brain.setup.status()
    const d = await window.brain.ai.detect()
    setDetected(d)
    const pick: AiKind | undefined = d.grok ? 'grok' : d.claude ? 'claude' : d.cursor ? 'cursor' : d.gpt ? 'gpt' : undefined
    const brainPath = fail ? undefined : applied?.brainPath || s.brainPath || patch?.brainPath || st.brainPath || undefined
    const next = { ...patch, ai: patch?.ai || pick, brainPath }
    if (!brainPath) {
      if (/not installed on GitHub/i.test(fail)) {
        go('github-verify', { ...next, path: 'create' })
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
    go('needs', { ...next, ai: pick, abWatching: st.watching })
  }

  async function continueFromDraft() {
    const role = s.role || 'owner'
    const slug = s.team?.slug || 'agency-trace'
    const app = (await window.brain.setup.pollInstall(slug).catch(() => null)) as { installed?: boolean; repo?: string } | null
    const repo = String(app?.repo || 'agency/example-brain')
    const bridge = await window.brain.setup.bridgeOnRepo(repo).catch(() => null)
    if (!app?.installed) {
      go('github-verify', { channel: 'agency', role, team: s.team })
      return
    }
    if (!bridge?.installed) {
      go('bridge', { channel: 'agency', role, team: s.team })
      return
    }
    if (role === 'owner') skipAgencyDraft.current = true
    await afterMembership({
      team: s.team || { slug, name: 'Agency', role },
      role,
      brainPath: '',
      channel: 'agency'
    })
  }

  async function holdForBridge(patch?: Partial<Session>): Promise<boolean> {
    const role = patch?.role || s.role
    const kind = patch?.brainKind || s.brainKind
    const channel = patch?.channel || s.channel
    if (role === 'project' || kind === 'project' || channel === 'local' || patch?.bridgeOk || s.bridgeOk) return false
    const path = patch?.brainPath || s.brainPath || ''
    if (!path) return false
    const mode = await window.brain.setup.syncMode(path).catch(() => '')
    if (mode === 'local' || mode === 'plyntr') return false
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
      else if (pick) go('aiwork', next)
      else go('aipick', next)
    } catch (e) {
      setAway(null)
      bridgeOnce.current = ''
      setErr(ipcErrorText(e))
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
      setErr(ipcErrorText(e))
    }
  }

  async function finishPlyntrJoin(row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) {
    const channel = channelRef.current
    if (channel === 'local') {
      localJoin.current = row
      go('aipick', {
        channel: 'local',
        role: row.role,
        email: row.email,
        business: row.name || row.slug,
        brainPath: ''
      })
      return
    }
    const repo = String(row.repo || '')
    const pendingRepo = !repo || repo.startsWith('pending/')
    const st = pendingRepo ? null : await window.brain.plyntr.installed(row.brainId, repo).catch(() => null)
    if (!pendingRepo && st?.ready) {
      const applied = await window.brain.setup.putFolderPlyntr({
        brainId: row.brainId,
        slug: row.slug,
        repo,
        org: repo.split('/')[0]
      })
      go('aipick', {
        brainPath: applied.brainPath,
        role: row.role,
        email: row.email,
        business: row.name || row.slug,
        channel: 'plyntr'
      })
      return
    }
    waitJoin.current = { brainId: row.brainId, repo, slug: row.slug, role: row.role, pending: pendingRepo }
    go('plyntr-wait', {
      role: row.role,
      email: row.email,
      business: row.name || row.slug,
      brainPath: '',
      channel: 'plyntr',
      orgLogin: pendingRepo ? '' : repo.split('/')[0],
      team: { slug: row.slug, name: row.name || row.slug, role: row.role }
    })
    setPlyntrCreate(null)
  }

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('setupDrive')) return
    const api = {
      setChannel(channel: string) {
        channelRef.current = channel
        setS((prev) => ({ ...prev, channel: channel as Session['channel'] }))
      },
      async join(row: { brainId: string; repo: string; slug: string; role: string; email: string; name: string }) {
        await finishPlyntrJoin(row)
      },
      pick(kind: AiKind) {
        setS((prev) => ({ ...prev, ai: kind, screen: 'needs' }))
      },
      role(role: string) {
        setS((prev) => ({ ...prev, role }))
      },
      go(screen: string) {
        go(screen)
      },
      bareNeeds() {
        setS((prev) => ({ ...prev, screen: 'needs', ai: undefined, channel: 'local' }))
      },
      async continueAgency() {
        skipAgencyDraft.current = true
        await afterMembership({
          team: { slug: 'agency-trace', name: 'Agency', role: 'owner' },
          role: 'owner',
          brainPath: '',
          channel: 'agency'
        })
      },
      async agency(role: string) {
        setS((prev) => ({
          ...prev,
          role,
          channel: 'agency',
          brainPath: '',
          team: { slug: 'agency-trace', name: 'Agency', role }
        }))
        await new Promise((r) => setTimeout(r, 30))
        await afterMembership({ team: { slug: 'agency-trace', name: 'Agency', role }, role, brainPath: '', channel: 'agency' })
      },
      create(row: {
        createId: string
        wizardStep: number
        label: string
        org: string
        slug: string
        scoutEmail: string
        brainId?: string
      }) {
        setCreateGate(false)
        setPlyntrCreate(row)
        go('plyntr-create', { channel: 'plyntr', role: 'owner', ai: 'grok' })
      },
      async click(label: string) {
        const btn = [...document.querySelectorAll('[data-setup-button]')].find(
          (node) => (node.textContent || '').trim() === label
        ) as HTMLButtonElement | undefined
        btn?.click()
      },
      read() {
        const el = document.querySelector('[data-setup-screen]')
        const keys = [...document.querySelectorAll('.runmeta-k')].map((node) => (node.textContent || '').trim())
        const vals = [...document.querySelectorAll('.runmeta-v')].map((node) => (node.textContent || '').trim())
        const at = (name: string) => {
          const i = keys.indexOf(name)
          return i >= 0 ? vals[i] || '' : ''
        }
        const primary = document.querySelector('[data-setup-screen="needs"] .primary') as HTMLButtonElement | null
        const app = document.querySelector('.app')
        return {
          screen: el?.getAttribute('data-setup-screen') || '',
          buttons: [...document.querySelectorAll('[data-setup-button]')].map((node) => (node.textContent || '').trim()),
          strip: (document.querySelector('[data-setup-strip]')?.textContent || '').trim(),
          model: at('Model'),
          effort: at('Effort'),
          h1: (el?.querySelector('h1')?.textContent || '').trim(),
          primary: (primary?.textContent || '').trim(),
          primaryDisabled: Boolean(primary?.disabled),
          role: app?.getAttribute('data-setup-role') || '',
          path: app?.getAttribute('data-setup-path') || '',
          radios: document.querySelectorAll('[data-setup-screen="needs"] input[name="setup-cli"]').length
        }
      }
    }
    ;(window as unknown as { __brainDrive?: typeof api }).__brainDrive = api
  })

  async function continuePlyntrJoin() {
    setErr('')
    try {
      await window.brain.plyntr.resumeAccount('join')
      const session = await window.brain.auth.session()
      if (session.signedIn) setS((p) => ({ ...p, email: session.email, role: session.role || p.role }))
      const pend = await window.brain.plyntr.pending()
      if (!pend.join) {
        go('plyntr-code')
        return
      }
      await finishPlyntrJoin(pend.join)
    } catch (e) {
      setErr(ipcErrorText(e))
    }
  }

  async function openPlyntrCreate() {
    setErr('')
    try {
      const pend = await window.brain.plyntr.pending()
      const session = await window.brain.auth.session()
      let create = pend.create
      if (create && create.wizardStep === 4 && create.brainId) {
        create = { ...create, wizardStep: 2 }
        await window.brain.plyntr.saveCreate(create)
      }
      if (create) setPlyntrCreate(create)
      const step = create?.wizardStep ?? 0
      if (!create || step < 2) return
      const gate = !session.signedIn || (step > 0 && !pend.platform)
      setCreateGate(gate)
      if (!gate && step > 0) {
        await window.brain.plyntr.resumeAccount('create')
        const again = await window.brain.auth.session()
        if (again.signedIn) setS((p) => ({ ...p, email: again.email, role: again.role || p.role }))
      }
      go('plyntr-create')
    } catch (e) {
      setErr(ipcErrorText(e))
    }
  }

  async function logOut() {
    await window.brain.auth.logout()
    navStack.current = []
    setShowInvite(false)
    setLoginVia('')
    setS((prev) => ({ ...blankSession(prev.path, prev.dryRun), screen: 'fork' }))
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('brain-theme', theme)
  }, [theme])

  useEffect(() => {
    void window.brain.settings.get().then((row) => setSuperAdmin(Boolean(row.superAdmin))).catch(() => {})
  }, [s.email])

  useEffect(() => {
    if (!s.brainPath) {
      setActiveSeat({ email: '', label: '', token: '' })
      return
    }
    let live = true
    void window.brain.shellView().then((view) => {
      if (!live) return
      const seat = view.seat || {}
      setActiveSeat({ email: seat.email || '', label: seat.label || '', token: seat.token ? 'seat' : '' })
    }).catch(() => {
      if (live) setActiveSeat({ email: '', label: '', token: '' })
    })
    return () => {
      live = false
    }
  }, [s.brainPath])

  return (
    <div className={`app ${s.screen === 'chat' ? 'chat-on' : ''} ${!railOpen && s.screen !== 'chat' ? 'rail-off' : ''} ${updatedLine ? 'has-update' : ''}`} data-setup-role={s.role || ''} data-setup-path={s.brainPath || ''}>
      <div className="titlebar">
        <span>{title}</span>
        {s.role && !openBrainAccountLabel(activeSeat) ? (
          <span className="role-lock">
            {s.role === 'project' ? 'Project only' : s.role === 'team' || s.role === 'member' ? 'Team' : s.role === 'scout' ? 'Scout' : 'Owner'}
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
        {openBrainAccountLabel(activeSeat) ? <span className="seat-pill">{openBrainAccountLabel(activeSeat)}</span> : null}
        <button type="button" className="ghost title-set" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
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
            onBeginCompanySetup={(row) => {
              void (async () => {
                setShowInvite(false)
                await finishPlyntrJoin({
                  brainId: row.brainId,
                  repo: row.repo,
                  slug: row.slug,
                  role: 'owner',
                  email: row.ownerEmail,
                  name: row.label
                })
              })()
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
          {s.screen !== 'chat' ? (
          <div className="runmeta" data-setup-meta="1">
            <div className="runmeta-k">Model</div>
            <button type="button" className="runmeta-v">
              {s.ai === 'claude' ? 'Claude' : s.ai === 'cursor' ? 'Cursor' : s.ai === 'gpt' ? 'ChatGPT' : s.ai === 'grok' ? 'Grok' : 'Choose one'}
            </button>
            <div className="runmeta-k">Effort</div>
            <button type="button" className="runmeta-v">{prettyEffort(undefined, s.ai || 'grok')}</button>
          </div>
          ) : null}
          {s.screen !== 'chat' && s.screen !== 'fork' ? (
            <div className="setup-back-row">
              <button type="button" className="ghost setup-back" onClick={() => goBack()}>
                Back
              </button>
            </div>
          ) : null}
          {s.screen !== 'chat' ? <TwoApps channel={s.channel} /> : null}
          {s.screen !== 'chat' && s.dryRun ? (
            <div className="demo">
              <span>Dev dry-run. New GitHub short names and clones stay off until you pack the app.</span>
            </div>
          ) : null}
          {s.screen === 'fork' && (
            <ForkScreen
              pendingCreate={Boolean(plyntrCreate)}
              pendingJoin={plyntrJoin}
              err={err}
              onPlyntr={() => {
                setLoginVia('')
                setCodeStartsInEmail(false)
                go('plyntr-code', { channel: 'plyntr' })
              }}
              onAgency={() => {
                setLoginVia('ads2ai')
                go('welcome', { channel: 'agency' })
              }}
              onLocal={() => {
                setLoginVia('')
                setCodeStartsInEmail(false)
                go('plyntr-code', { channel: 'local' })
              }}
              onContinueCreate={() => void openPlyntrCreate()}
              onContinueJoin={() => void continuePlyntrJoin()}
            />
          )}
          {s.screen === 'plyntr-code' && (
            <PlyntrCodeScreen
              local={s.channel === 'local'}
              startInEmail={codeStartsInEmail}
              onJoin={finishPlyntrJoin}
              onProject={async (row) => {
                await afterProject(row)
              }}
            />
          )}
          {s.screen === 'plyntr-project' && (
            <PlyntrProjectScreen
              onJoin={async (row) => {
                await afterProject(row)
              }}
            />
          )}
          {s.screen === 'plyntr-create' && (
            <div data-setup-screen="plyntr-create">
            <PlyntrCreateScreen
              initial={plyntrCreate}
              gateFirst={createGate}
              picked={s.ai || 'grok'}
              onBindBack={(fn) => {
                plyntrWizardBack.current = fn
              }}
              onDraft={(path) => setS((prev) => ({ ...prev, brainPath: path }))}
              onCloned={(brainPath) => {
                go('aipick', { brainPath, role: 'owner', path: 'create', channel: 'plyntr' })
              }}
            />
            </div>
          )}
          {s.screen === 'plyntr-wait' && (
            <div data-setup-screen="plyntr-wait">
              <p className="kicker">GitHub</p>
              <h1>This brain is not ready to copy yet.</h1>
              <p>
                {waitJoin.current?.role === 'team' || waitJoin.current?.role === 'project' || waitJoin.current?.pending
                  ? 'Your owner has not finished connecting this brain to GitHub. Ask them to finish, then click Check again.'
                  : `Click Open GitHub. Click Install, choose Only select repositories, and pick ${waitJoin.current?.repo || 'this brain'}. Then click Check GitHub.`}
              </p>
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                {plyntrJoinButtons({
                  role: waitJoin.current?.role || s.role || '',
                  pending: Boolean(waitJoin.current?.pending)
                }).map((label) => (
                  <button
                    key={label}
                    className={label === 'Check again' ? 'primary' : 'ghost'}
                    type="button"
                    data-setup-button={label}
                    onClick={() => {
                      const row = waitJoin.current
                      if (!row) return
                      if (label === 'Open GitHub') {
                        void window.brain.setup.openPlyntrInstall(row.brainId, s.orgLogin, row.repo)
                        return
                      }
                      void window.brain.plyntr.installed(row.brainId, row.repo).then((st) => {
                        if (st?.ready) {
                          void finishPlyntrJoin({
                            brainId: row.brainId,
                            repo: row.repo,
                            slug: row.slug,
                            role: row.role,
                            email: s.email,
                            name: s.business
                          })
                        } else setErr('Not ready yet. Try again in a minute.')
                      })
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.screen === 'github-verify' && (
            <div data-setup-screen="github-verify">
              <p className="kicker">GitHub</p>
              <h1>The GitHub app is not installed yet.</h1>
              <p>
                {s.role === 'team' || s.role === 'project'
                  ? 'Ask your owner to install the GitHub app, then click Check again.'
                  : 'Click Open GitHub, click Install, choose Only select repositories.'}
              </p>
              {err ? <p className="note">{err}</p> : null}
              <div className="actions">
                {agencyVerifyButtons(s.role || '').map((label) => (
                  <button
                    key={label}
                    className="primary"
                    type="button"
                    data-setup-button={label}
                    onClick={() => {
                      void (async () => {
                        if (label === 'Open GitHub') await window.brain.setup.openAppInstall(s.team?.slug || 'agency-trace', s.orgLogin)
                        await continueFromDraft()
                      })()
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.screen === 'needs' && (
            <>
            {err ? <p className="note">{err}</p> : null}
            <SetupNeeds
              picked={s.ai}
              onPick={(ai) => setS((prev) => ({ ...prev, ai }))}
              hideAgency={s.channel === 'local' || s.channel === 'plyntr'}
              folderMissing={s.channel === 'local' ? 'code' : 'github'}
              onNeedSignIn={(ai) => go('aiwork', { ai, brainPath: s.brainPath })}
              onReady={async ({ watching, ai, brainPath }) => {
                const pick = ai || s.ai
                const drafted = String(s.brainPath || '')
                let path = drafted.includes('setup-drafts') ? drafted : String(brainPath || '') || drafted
                if (s.channel === 'local' && localJoin.current) {
                  const applied = await window.brain.setup.putFolderLocal({
                    brainId: localJoin.current.brainId,
                    slug: localJoin.current.slug,
                    repo: localJoin.current.repo,
                    org: String(localJoin.current.repo || '').split('/')[0] || '',
                    email: localJoin.current.email,
                    name: localJoin.current.name
                  })
                  path = applied.brainPath || path
                  localJoin.current = null
                  setS((prev) => ({ ...prev, brainPath: path }))
                }
                if (!String(path || '').trim() || !pick) return false
                const patch = { abWatching: watching || Boolean(path), brainPath: path, ai: pick }
                const routed = await openChatOrSignIn(pick, path, patch)
                if (routed === 'blocked') return false
                if (routed === 'sign-in') return true
                if (String(path).includes('setup-drafts')) {
                  go('chat', patch)
                  return true
                }
                if (await holdForBridge(patch)) return true
                go('chat', patch)
                return true
              }}
              onNeedFolder={() => (s.channel === 'local' ? go('plyntr-code') : go('github'))}
            />
            </>
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
              <p className="tiny">Six letters and numbers, from your invite email.</p>
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
                          setErr(ipcErrorText(e))
                          return
                        }
                        go('abapply', { ...patch, path: 'second' })
                        return
                      }
                      go('github', { ...patch, path: 'create' })
                    } catch (e) {
                      const msg = ipcErrorText(e)
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
              <p>Type the email you were invited with. We email you a sign-in code.</p>
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
                      const sent = await window.brain.auth.requestCode(
                        s.email,
                        loginVia === 'hq-sync' || loginVia === 'ads2ai' ? loginVia : undefined
                      )
                      setLoginVia(sent.via)
                      go('otp')
                    } catch (e) {
                      setErr(ipcErrorText(e))
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
                        setErr(ipcErrorText(e))
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
                      if (res.via === 'plyntr' && res.brainId && res.repo && res.slug) {
                        await finishPlyntrJoin({
                          brainId: res.brainId,
                          repo: res.repo,
                          slug: res.slug,
                          role: res.role || res.member.role || 'team',
                          email: res.member.email,
                          name: res.member.name || res.member.email
                        })
                        return
                      }
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
                      setErr(ipcErrorText(e))
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
                      const sent = await window.brain.auth.requestCode(
                        s.email,
                        loginVia === 'hq-sync' || loginVia === 'ads2ai' ? loginVia : undefined
                      )
                      setLoginVia(sent.via)
                      setErr('Check that inbox for a six-digit code. It lasts ten minutes.')
                    } catch (e) {
                      setErr(ipcErrorText(e))
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
                <p>First time. We put this brain on GitHub, copy it to this Mac, then open Chat.</p>
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
              <p className="tiny">A name people will recognize. Next we put a private copy on GitHub, then on this computer.</p>
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
                You need a free GitHub account. If GitHub asks, sign up. After that, GitHub opens an Install page. Choose{' '}
                <strong>Only select repositories</strong>, never All repositories.
              </p>
              <AwayBanner kind={away} />
              {!away ? (
                <div className="warn-box">
                  <h3>On GitHub</h3>
                  <ol>
                    <li>Paste or create the short name below (or open GitHub to create it).</li>
                    <li>Click Install on GitHub, then Only select repositories. We wait here until GitHub is done.</li>
                    <li>After the folder is copied, install Brain Bridge on that same repository.</li>
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
                      setErr(ipcErrorText(e))
                      return null
                    })
                    setAway(null)
                    const login = String(r?.org || '').trim()
                    if (login) {
                      setOrg(login)
                      if (!githubOnlySelected) {
                        setErr('Check the box below first.')
                        return
                      }
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
            <div data-setup-screen="bridge">
              <p className="kicker">GitHub</p>
              <h1>Install Brain Bridge on this repo.</h1>
              <p>
                Brain Bridge is our second GitHub app. It lets this Mac save changes back to the shared copy. The browser
                opens the install page. Click Install. Choose Only select repositories. Pick this repo. We stay here
                until GitHub says it is installed.
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
            </div>
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
                    : 'We copy it into the Projects folder in your home folder. Next: Git, Homebrew, Cloudflare Tunnel, and your AI.'}
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
            <div data-setup-screen="cli">
              <p className="kicker">Your AI</p>
              <h1>Which AI should this use?</h1>
              <p>Pick who you start with. You can open the others later from + in the tab bar.</p>
              <div className="warn-box">
                <h3>Next: install, then sign in</h3>
                <p>
                  Next we install it. Then you sign in with your own paid account (for example Claude Pro). A browser
                  opens for that.
                </p>
              </div>
              <div className="ai-grid">
                {([['claude', 'Claude'], ['grok', 'Grok'], ['cursor', 'Cursor'], ['gpt', 'ChatGPT']] as const).map(([id, n]) => (
                  <button type="button" key={id} className={`ai ${s.ai === id ? 'on' : ''}`} data-setup-button={n} onClick={() => setS({ ...s, ai: id })}>
                    <strong>{n}</strong>
                    {detected[id] === false || detected[id] ? ' ' : null}
                    <span>{detected[id] === false ? 'not installed yet' : detected[id] ? 'installed' : ''}</span>
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
                    go('needs')
                  }}
                >
                  Continue with {s.ai === 'gpt' ? 'ChatGPT' : s.ai ? s.ai[0].toUpperCase() + s.ai.slice(1) : '…'}
                </button>
              </div>
            </div>
          )}
          {s.screen === 'aiwork' && (
            <div data-setup-screen="aiwork">
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
                        setErr(ipcErrorText(e))
                      })
                  }}
                >
                  Open sign-in again
                </button>
              </div>
            </div>
          )}
          {s.screen === 'chat' && (
            <div data-setup-screen="chat">
              {s.channel === 'agency' && String(s.brainPath || '').includes('setup-drafts') ? (
                <div className="actions">
                  <button className="primary" type="button" data-setup-button="Continue" onClick={() => void continueFromDraft()}>
                    Continue
                  </button>
                </div>
              ) : null}
              <TerminalWorkspace session={s} showInvite={showInvite} setShowInvite={setShowInvite} railOpen={railOpen} setRailOpen={setRailOpen} />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
