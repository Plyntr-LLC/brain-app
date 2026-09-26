import { useEffect, useRef, useState } from 'react'
import { startSettingsLoad } from './settings-load'
import { packLine, starterBlocksAdd } from '@shared/client-pack'
import { PackSelect } from './PlyntrPath'
import { asSeat, canTurnOnGithubSync, isTeamSeat, seatLabel, type SeatRole } from '@shared/contracts'
import { displayPlyntrCode } from '@shared/plyntr-invite'
import { canOfferPlyntrTransfer } from '@shared/plyntr-transfer'
import { allowedFolders, isJoeSuperAdmin, showBrainSwitch } from '@shared/shell-switch'
import { LocalSyncPanel } from './LocalSyncPanel'
import { PlyntrCompanyScreen } from './PlyntrPath'

type Person = {
  name: string
  email: string
  role: SeatRole
  brain: string
  client?: string
  brains?: string[]
}

type HqStatus = {
  signedIn: boolean
  email: string
  kind: string
  hq_repo: string
  brain_label: string
  projects: { slug: string; path: string }[]
  seats: { seat_id: string; email: string; name: string; status: string; roots: string[]; kind: string }[]
  businesses: { id: string; name: string; hq_repo: string; owners: { email: string; name: string; role: string }[] }[]
}

function macSyncHint(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'This Mac has not synced this brain yet.'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return 'Last sync on this Mac is saved.'
  const when = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `Last sync on this Mac: ${when}.`
}

function untilHint(raw: string): string {
  const d = new Date(String(raw || ''))
  if (Number.isNaN(d.getTime())) return ''
  return ` · until ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function prettyName(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

function channelLine(row: { syncMode?: string; watching?: boolean }): string {
  if (row.syncMode === 'local') return 'On this computer only'
  if (row.syncMode === 'plyntr') return 'Plyntr sync'
  if (row.syncMode === 'agency-brain' || row.watching) return 'Agency Brain sync'
  return 'On this computer'
}

function businessTitle(row: { name: string; path: string; slug: string }, companyLabel = ''): string {
  const label = prettyName(companyLabel)
  if (label) return label
  if (row.slug === 'plyntr') return 'Plyntr'
  return prettyName(row.name || '') || placeName(row.path, '')
}

function placeName(path: string, fallback = ''): string {
  const seg = String(path || '').split(/[/\\]/).filter(Boolean).pop() || ''
  return seg || fallback
}

function nowIn(row: {
  path?: string
  name: string
  agency?: { ok: boolean; detail: string }
  hq?: { ok: boolean; detail: string }
}): string {
  const name = placeName(row.path || '', prettyName(row.name)) || 'this brain'
  if (row.agency?.ok) return `Now in ${name}. Sync follows this brain.`
  if (row.agency?.detail) return `Now in ${name}. ${row.agency.detail}`
  return `Now in ${name}.`
}

function FoldHead({
  kicker,
  title,
  open,
  onToggle
}: {
  kicker: string
  title: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" className="set-fold" onClick={onToggle} aria-expanded={open}>
      <p className="kicker">{kicker}</p>
      <h3 className="set-h">{title}</h3>
    </button>
  )
}

export function SettingsPanel({
  role,
  onClose,
  onLogout,
  onSwitchBrain,
  onBeginCompanySetup
}: {
  role?: string
  onClose: () => void
  onLogout?: () => void
  onSwitchBrain?: (row: { path: string; name: string }) => void
  onBeginCompanySetup?: (row: {
    brainId: string
    slug: string
    label: string
    ownerEmail: string
    code: string
    repo: string
  }) => void
}) {
  const [superAdmin, setSuper] = useState(false)
  const [email, setEmail] = useState('')
  const [helloName, setHelloName] = useState('')
  const [brainName, setBrainName] = useState('')
  const [brainPath, setBrainPath] = useState('')
  const [seat, setSeat] = useState('')
  const [people, setPeople] = useState<Person[]>([])
  const [draft, setDraft] = useState<Person>({ name: '', email: '', role: 'team', brain: '', brains: [] })
  const [liveProjects, setLiveProjects] = useState<{ id: string; name: string }[]>([])
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [appVer, setAppVer] = useState('')
  const [upd, setUpd] = useState('')
  const [skinCap, setSkinCap] = useState(false)
  const [skinJev, setSkinJev] = useState(false)
  const [jevReady, setJevReady] = useState(false)
  const [jevBusy, setJevBusy] = useState('')
  const [learned, setLearned] = useState<{ cli: string; eventKind: string; component: string; confidence: number }[]>(
    []
  )
  const [hq, setHq] = useState<HqStatus | null>(null)
  const [hqCode, setHqCode] = useState('')
  const [hqRepo, setHqRepo] = useState('')
  const [folderRepo, setFolderRepo] = useState('')
  const [hqBusy, setHqBusy] = useState(false)
  const [brains, setBrains] = useState<
    {
      path: string
      name: string
      slug: string
      role?: string
      watching?: boolean
      current?: boolean
      syncMode?: 'plyntr' | 'agency-brain' | 'local'
      brainId?: string
    }[]
  >([])
  const [rosters, setRosters] = useState<Record<string, Person[]>>({})
  const [companyLabels, setCompanyLabels] = useState<Record<string, string>>({})
  const [companyPacks, setCompanyPacks] = useState<Record<string, string>>({})
  const [brainPack, setBrainPack] = useState('')
  const [folderSync, setFolderSync] = useState('')
  const [openAdd, setOpenAdd] = useState(false)
  const [openCatalog, setOpenCatalog] = useState(false)
  const [adsCode, setAdsCode] = useState('')
  const [pending, setPending] = useState<{ slug: string; name: string } | null>(null)
  const [org, setOrg] = useState('')
  const [bizBusy, setBizBusy] = useState(false)
  const [captures, setCaptures] = useState<
    {
      fingerprint: string
      at: string
      cli: string
      eventKind: string
      catalogId: string | null
      matched: boolean
      label: string | null
      learned?: boolean
      jevProposal?: {
        component: string | null
        confidence: number
        paint: boolean
        detail: string
      } | null
    }[]
  >([])
  const [phone, setPhone] = useState<{
    on: boolean
    url: string
    origin: string
    detail: string
    platform: string
    watching: boolean
    pairPin: string
    pairQr: string
    pairUntil: number
    devices: { id: string; label: string; lastSeen: number }[]
  }>({
    on: false,
    url: '',
    origin: '',
    detail: '',
    platform: '',
    watching: false,
    pairPin: '',
    pairQr: '',
    pairUntil: 0,
    devices: []
  })
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneNote, setPhoneNote] = useState('')
  const joe = email === 'joe@plyntr.com'
  const [shell, setShell] = useState({ email: '', flag: false, signedIn: [] as string[], keyless: [] as string[] })
  useEffect(() => {
    void window.brain.shellView?.().then((row) => {
      setShell({ email: row.email || email, flag: row.flag, signedIn: row.signedIn || [], keyless: row.keyless || [] })
    }).catch(() => {})
  }, [email, brains, superAdmin])
  const canAddUsers = joe || !isTeamSeat(seat || role)
  const [plyntrMode, setPlyntrMode] = useState(false)
  const [plyntrBrainId, setPlyntrBrainId] = useState('')
  const [plyntrRole, setPlyntrRole] = useState('')
  const [plyntrAccountRole, setPlyntrAccountRole] = useState('')
  const [plyntrSeatEmail, setPlyntrSeatEmail] = useState('')
  const [plyntrSeat, setPlyntrSeat] = useState(true)
  const [plyntrOrg, setPlyntrOrg] = useState('')
  const [plyntrSlug, setPlyntrSlug] = useState('')
  const [plyntrLabel, setPlyntrLabel] = useState('')
  const [plyntrRows, setPlyntrRows] = useState<{
    seats: {
      id: string
      email: string
      name: string
      role: string
      status: string
      bootstrap?: boolean
      plyntrScout?: boolean
      roots?: string[]
    }[]
    invites: { inviteId: string; email: string; name: string; role: string; status: string; expiresAt: string; roots?: string[] }[]
  }>({ seats: [], invites: [] })
  const [shownCode, setShownCode] = useState('')
  const [mintRole, setMintRole] = useState<SeatRole>('team')
  const [canMove, setCanMove] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)
  const [syncHint, setSyncHint] = useState('')

  const settingsAlive = useRef(true)

  async function takePlyntrActive(
    active: {
      canMove?: boolean
      syncMode?: string
      brainId?: string
      hasSeat?: boolean
      org?: string
      slug?: string
      label?: string
      role?: string
      accountRole?: string
      seatEmail?: string
    } | null,
    opts?: { clearHint?: boolean }
  ) {
    setCanMove(Boolean(active?.canMove))
    setFolderSync(String(active?.syncMode || ''))
    setPlyntrRole(String(active?.role || ''))
    setPlyntrAccountRole(String(active?.accountRole || ''))
    setPlyntrSeatEmail(String(active?.seatEmail || ''))
    if ((active?.syncMode === 'plyntr' || active?.syncMode === 'local') && active.brainId) {
      setPlyntrMode(true)
      setPlyntrBrainId(active.brainId)
      setPlyntrSeat(Boolean(active.hasSeat))
      setPlyntrOrg(active.org || '')
      setPlyntrSlug(active.slug || '')
      setPlyntrLabel(active.label || '')
      if (active.syncMode === 'local') {
        setSyncHint('On this computer only. No GitHub sync yet.')
      } else {
      const health = await window.brain.hqSync.health().catch(() => null)
      if (!settingsAlive.current) return
      setSyncHint(health?.lastSync || '')
      }
      if (active.hasSeat) {
        const seatRows = await window.brain.plyntr.seats(active.brainId).catch(() => ({ seats: [], invites: [], pack: '' }))
        if (!settingsAlive.current) return
        setPlyntrRows(seatRows)
        if (seatRows.pack) setBrainPack(seatRows.pack)
        const again = await window.brain.plyntr.active().catch(() => null)
        if (!settingsAlive.current) return
        if (again) {
          setPlyntrRole(String(again.role || ''))
          setPlyntrAccountRole(String(again.accountRole || ''))
          setPlyntrSeatEmail(String(again.seatEmail || ''))
        }
      }
      return
    }
    setPlyntrMode(false)
    if (opts?.clearHint) setSyncHint('')
  }

  useEffect(() => {
    let dead = false
    settingsAlive.current = true
    setLoaded(false)
    let shownBrains: typeof brains = []
    let shownSettings: Awaited<ReturnType<typeof window.brain.settings.get>> | null = null
    const load = startSettingsLoad(
      {
        get: () => window.brain.settings.get(),
        list: () => window.brain.brains.list().catch(() => []),
        slow: async (signal) => {
          const list = shownBrains
          const s = shownSettings
          const aborted = () => signal.aborted
          const rosterRows = await Promise.all(
            list.map((b) => window.brain.settings.rosterAt(b.path).catch(() => [] as Person[]))
          )
          if (aborted()) return null
          const folderRoster = await window.brain.settings.roster().catch(() => [] as Person[])
          if (aborted()) return null
          const people = folderRoster.length ? folderRoster : await window.brain.settings.team().catch(() => [] as Person[])
          if (aborted()) return null
          const nextRosters: Record<string, Person[]> = {}
          list.forEach((b, i) => {
            nextRosters[b.path] = rosterRows[i] || []
          })
          setRosters(nextRosters)
          setPeople(people)
          setLoaded(true)
          if (aborted()) return null
          const companiesP =
            s?.superAdmin && s.email === 'joe@plyntr.com'
              ? window.brain.plyntr.companies().catch(() => [])
              : Promise.resolve([])
          const activeP = window.brain.plyntr.active().catch(() => null)
          const seatsP = activeP.then((active) => {
            if (signal.aborted) return { seats: [], invites: [], pack: '' }
            if ((active?.syncMode === 'plyntr' || active?.syncMode === 'local') && active.brainId && active.hasSeat) {
              return window.brain.plyntr.seats(active.brainId).catch(() => ({ seats: [], invites: [], pack: '' }))
            }
            return { seats: [], invites: [], pack: '' }
          })
          const healthP = window.brain.hqSync.health().catch(() => null)
          const skinP = window.brain.skin.get().catch(() => ({
            capture: false,
            jev: false,
            jevReady: false,
            joe: false,
            components: [] as string[],
            learned: [] as { cli: string; eventKind: string; component: string; confidence: number }[]
          }))
          const phoneP = window.brain.phone.status().catch(() => ({
            on: false,
            url: '',
            origin: '',
            detail: '',
            platform: '',
            watching: false,
            pairPin: '',
            pairQr: '',
            pairUntil: 0,
            devices: [] as { id: string; label: string; lastSeen: number }[]
          }))
          const [companies, seats, health, skin, phoneNow, active, projects, bridge, ver] = await Promise.all([
            companiesP,
            seatsP,
            healthP,
            skinP,
            phoneP,
            activeP,
            window.brain.settings.projects().catch(() => []),
            window.brain.hqSync.ownerStatus().catch(() => null),
            window.brain.version().catch(() => '')
          ])
          if (aborted()) return null
          const captures = skin.joe ? await window.brain.skin.list().catch(() => []) : []
          if (aborted()) return null
          return { companies, seats, health, skin, phoneNow, active, projects, bridge, ver, captures }
        }
      },
      (view) => {
        if (dead) return
        shownBrains = view.businesses
        shownSettings = view.settings
        const s = view.settings
        setSuper(s.superAdmin)
        setEmail(s.email)
        setHelloName(String(s.name || '').trim())
        setBrainPath(String(s.brainPath || ''))
        setBrainName(placeName(String(s.brainPath || ''), prettyName(String(s.brainName || ''))))
        setSeat(String(s.role || ''))
        setBrains(view.businesses)
      },
      (rest) => {
        if (dead || !rest || !settingsAlive.current) return
        if (shownSettings?.superAdmin && shownSettings.email === 'joe@plyntr.com') {
          const labels: Record<string, string> = {}
          const packs: Record<string, string> = {}
          for (const company of rest.companies) {
            if (!company.brainId) continue
            if (company.label) labels[company.brainId] = company.label
            packs[company.brainId] = company.pack || ''
          }
          setCompanyLabels(labels)
          setCompanyPacks(packs)
        }
        const active = rest.active
        if (active && (active.syncMode === 'plyntr' || active.syncMode === 'local') && active.brainId) {
          setCanMove(Boolean(active.canMove))
          setFolderSync(String(active.syncMode || ''))
          setPlyntrRole(String(active.role || ''))
          setPlyntrAccountRole(String(active.accountRole || ''))
          setPlyntrSeatEmail(String(active.seatEmail || ''))
          setPlyntrMode(true)
          setPlyntrBrainId(active.brainId)
          setPlyntrSeat(Boolean(active.hasSeat))
          setPlyntrOrg(active.org || '')
          setPlyntrSlug(active.slug || '')
          setPlyntrLabel(active.label || '')
          setSyncHint(active.syncMode === 'local' ? 'On this computer only. No GitHub sync yet.' : rest.health?.lastSync || '')
          setPlyntrRows(rest.seats)
          if (rest.seats.pack) setBrainPack(rest.seats.pack)
        } else {
          setPlyntrMode(false)
        }
        setLiveProjects(rest.projects)
        if (rest.bridge) {
          setHq(rest.bridge)
          void window.brain.hqSync.watchedRepo().catch(() => '').then((watched) => {
            if (dead || !settingsAlive.current) return
            setFolderRepo(watched)
            setHqRepo(watched || rest.bridge?.hq_repo || '')
          })
          if (rest.bridge.projects.length) {
            setLiveProjects(rest.bridge.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
          }
        }
        setAppVer(rest.ver)
        setPhone(rest.phoneNow)
        if (rest.skin.joe) {
          setSkinCap(Boolean(rest.skin.capture))
          setSkinJev(Boolean(rest.skin.jev))
          setJevReady(Boolean(rest.skin.jevReady))
          setLearned(rest.skin.learned || [])
          setCaptures(rest.captures)
        }
      }
    )
    const offUpdate = window.brain.onUpdate((ev) => {
      if (ev.status === 'checking') setUpd('Checking for an update…')
      else if (ev.status === 'available') setUpd(`Update ${ev.detail} is downloading.`)
      else if (ev.status === 'none') setUpd('You already have the latest Brain.')
      else if (ev.status === 'downloaded') setUpd(`Update ${ev.detail} is ready. Restart to install. Your chats stay.`)
      else if (ev.status === 'error') setUpd(ev.detail || 'Could not check for an update.')
    })
    const offHeal = window.brain.skin.onHealed(() => {
      void window.brain.skin.get().then((s) => setLearned(s.learned || []))
      void window.brain.skin.list().then(setCaptures)
    })
    const offBack = window.brain.setup.onBack((ev) => {
      const login = String(ev.org || '').trim()
      if (login) setOrg((cur) => (cur.trim() ? cur : login))
    })
    const offPhone = window.brain.phone.onStatus(setPhone)
    return () => {
      dead = true
      settingsAlive.current = false
      load.cancel()
      offUpdate()
      offHeal()
      offBack()
      offPhone()
    }
  }, [role])

  useEffect(() => {
    if (!phone.on) return
    const t = window.setInterval(() => {
      void window.brain.phone.status().then(setPhone)
    }, 2000)
    return () => window.clearInterval(t)
  }, [phone.on])

  async function refreshOpenBrain(row: { path: string; name: string }) {
    const list = await window.brain.brains.list()
    setBrains(list)
    setBrainPath(row.path)
    setBrainName(placeName(row.path, prettyName(row.name)))
    const roster = (await window.brain.settings.roster().catch(() => [])) as Person[]
    setPeople(roster)
    setRosters((prev) => ({ ...prev, [row.path]: roster }))
    const mode = await window.brain.setup.syncMode(row.path).catch(() => '')
    await takePlyntrActive(await window.brain.plyntr.active().catch(() => null), { clearHint: true })
    setFolderSync(mode)
    onSwitchBrain?.({ path: row.path, name: placeName(row.path, row.name) })
    setNote(nowIn(row))
  }

  function localSyncOffer() {
    if (folderSync !== 'local' || !plyntrBrainId || !canTurnOnGithubSync(plyntrRole || seat || role, joe)) return null
    return (
      <LocalSyncPanel
        brainId={plyntrBrainId}
        slug={plyntrSlug}
        repo={plyntrOrg && plyntrSlug ? `${plyntrOrg}/${plyntrSlug}-brain` : ''}
        folder={brainPath}
        onDone={(detail) => {
          void (async () => {
            setNote(detail)
            setFolderSync('plyntr')
            await takePlyntrActive(await window.brain.plyntr.active().catch(() => null))
            setBrains(await window.brain.brains.list())
            const roster = (await window.brain.settings.roster().catch(() => [])) as Person[]
            setPeople(roster)
          })()
        }}
      />
    )
  }

  const currentIndex = brains.findIndex((b) => b.current)
  const brainsBefore = currentIndex < 0 ? [] : brains.slice(0, currentIndex)
  const brainsAfter = currentIndex < 0 ? brains : brains.slice(currentIndex + 1)
  function renderOtherBrain(b: (typeof brains)[number]) {
    const users = rosters[b.path] || []
    return (
      <section className="biz" key={b.path}>
        <h3>{businessTitle(b, b.brainId ? companyLabels[b.brainId] : '')}</h3>
        <p className="biz-brain">Brain · {placeName(b.path, prettyName(b.name || b.slug))}</p>
        <p className="tiny">{channelLine(b)}</p>
        {joe && superAdmin && b.brainId ? (
          <PackSelect
            value={companyPacks[b.brainId] || ''}
            onChange={(next) => {
              void window.brain.plyntr
                .setPack(b.brainId || '', next)
                .then((saved) => {
                  setCompanyPacks((prev) => ({ ...prev, [saved.brainId]: saved.pack }))
                  if (saved.brainId === plyntrBrainId) setBrainPack(saved.pack)
                  setNote(packLine(saved.pack))
                })
                .catch((err) => setNote(String((err as Error).message || err)))
            }}
          />
        ) : null}
        {users.length ? (
          users.map((p) => (
            <div className="set-row" key={p.email}>
              <span>
                {p.name || p.email} · {p.email}
                <span className="tiny"> · {seatLabel(p.role)}</span>
              </span>
            </div>
          ))
        ) : (
          <p className="tiny">No people listed in this folder yet.</p>
        )}
        {showBrainSwitch(shell) ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void (async () => {
                try {
                  const row = await window.brain.brains.switch(b.path)
                  await refreshOpenBrain(row)
                } catch (err) {
                  setNote(String((err as Error).message || err))
                }
              })()
            }}
          >
            Open this brain
          </button>
        ) : null}
      </section>
    )
  }

  if (!loaded) {
    return (
      <div className="settings">
        <div className="invitehead">
          <strong>Settings</strong>
          <button type="button" className="tabx" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="tiny">Loading…</p>
      </div>
    )
  }

  const who = helloName || (email ? email.split('@')[0] : 'there')
  const here = placeName(brainPath, brainName) || 'this brain'

  return (
    <div className="settings">
      <div className="invitehead">
        <strong>Settings</strong>
        <button type="button" className="tabx" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="set-now">
        <p className="set-now-k">Welcome, {who}</p>
        <p>You are inside {here}.</p>
        {superAdmin ? <p className="tiny">This Mac stays {email}. Switching brains does not change that.</p> : null}
        {plyntrMode && plyntrSeatEmail ? (
          <p>This brain is signed in as {plyntrSeatEmail} · {seatLabel(plyntrRole || 'owner')}.</p>
        ) : null}
        <p className="tiny">
          <button type="button" className="linkish" onClick={() => {
            const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
            document.documentElement.dataset.theme = next
            localStorage.setItem('brain-theme', next)
          }}>
            Light or dark
          </button>
        </p>
        {showBrainSwitch(shell) ? (
          <label className="field" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
            Switch brain
            <select
              value={brains.find((b) => b.current)?.path || ''}
              onChange={async (e) => {
                const path = e.target.value
                if (!path) return
                try {
                  const row = await window.brain.brains.switch(path)
                  await refreshOpenBrain(row)
                  const bridge = await window.brain.hqSync.ownerStatus().catch(() => null)
                  setHq(bridge)
                  setFolderRepo(await window.brain.hqSync.watchedRepo().catch(() => ''))
                } catch (err) {
                  setNote(String((err as Error).message || err))
                }
              }}
            >
              {allowedFolders(shell).map((id) => {
                const b = brains.find((row) => row.path === id || row.brainId === id)
                const path = b?.path || id
                const name = b ? placeName(b.path, prettyName(b.name || b.slug || '')) : id
                return (
                  <option key={id} value={path}>
                    {name}
                    {b?.watching ? ' · Agency Brain watching' : ''}
                  </option>
                )
              })}
            </select>
          </label>
        ) : null}
      </div>

      <div className="biz-wrap">
        <h2 className="biz-kicker">Businesses</h2>
        {joe && superAdmin ? (
          <PlyntrCompanyScreen
            embedded
            hideBrainIds={brains.map((b) => b.brainId || '').filter(Boolean)}
            onSetupHere={(row) => onBeginCompanySetup?.(row)}
          />
        ) : null}
        {brainsBefore.map((b) => renderOtherBrain(b))}
      {canAddUsers ? (
        <section className="biz current">
          <h3>{businessTitle({ name: brainName, path: brainPath, slug: brains.find((b) => b.current)?.slug || '' }, companyLabels[brains.find((b) => b.current)?.brainId || ''] || '')}</h3>
          <p className="biz-brain">Brain · {here}</p>
          <p className="tiny">{channelLine({ syncMode: folderSync, watching: brains.find((b) => b.current)?.watching })}</p>
          {joe && superAdmin && (brains.find((b) => b.current)?.brainId || plyntrBrainId) ? (
            <PackSelect
              value={companyPacks[brains.find((b) => b.current)?.brainId || plyntrBrainId] || brainPack}
              onChange={(next) => {
                const id = brains.find((b) => b.current)?.brainId || plyntrBrainId
                void window.brain.plyntr
                  .setPack(id, next)
                  .then((saved) => {
                    setCompanyPacks((prev) => ({ ...prev, [saved.brainId]: saved.pack }))
                    setBrainPack(saved.pack)
                    setNote(packLine(saved.pack))
                  })
                  .catch((err) => setNote(String((err as Error).message || err)))
              }}
            />
          ) : null}
          {localSyncOffer()}
          <p>
            Team is on this whole brain. Project only never clones HQ. This app copies only the folders you tick,
            keeps them in sync in the background, and deletes those folders if you remove access.
          </p>
          <div className="set-block" style={{ padding: 0 }}>
            <p className="tiny">
              {hq?.signedIn
                ? [
                    `Project sync signed in as ${hq.email}`,
                    hq.hq_repo ? hq.hq_repo : '',
                    folderRepo && hq.hq_repo && folderRepo !== hq.hq_repo ? `This folder is ${folderRepo}` : ''
                  ]
                    .filter(Boolean)
                    .join('. ') + '.'
                : 'To add Project only people, sign in for project sync with a code to your owner email.'}
            </p>
            {!hq?.signedIn ? (
              <>
                <label className="field">
                  Project-sync code
                  <input value={hqCode} onChange={(e) => setHqCode(e.target.value)} placeholder="184 392" />
                </label>
                <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                  <button
                    className="ghost"
                    type="button"
                    disabled={!email.includes('@')}
                    onClick={async () => {
                      try {
                        await window.brain.hqSync.ownerRequestCode(email)
                        setNote('Check that inbox for a six-digit code. It lasts ten minutes.')
                      } catch (e) {
                        setNote(String((e as Error).message || e))
                      }
                    }}
                  >
                    Email me a project-sync code
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={hqCode.replace(/\s/g, '').length < 4}
                    onClick={async () => {
                      try {
                        await window.brain.hqSync.ownerLogin({ email, code: hqCode })
                        const st = await window.brain.hqSync.ownerStatus()
                        setHq(st)
                        const watched = await window.brain.hqSync.watchedRepo().catch(() => '')
                        setFolderRepo(watched)
                        setHqRepo(watched || st.hq_repo || '')
                        if (st.projects.length) {
                          setLiveProjects(st.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
                        }
                        setNote('Project sync is on. Add Project only people below.')
                      } catch (e) {
                        setNote(String((e as Error).message || e))
                      }
                    }}
                  >
                    Sign in
                  </button>
                </div>
              </>
            ) : hq.kind === 'platform' ? (
              <p className="tiny">
                This is the platform login. Company owners connect GitHub after they get the login email.
              </p>
            ) : (
              <>
                <label className="field">
                  HQ GitHub repo
                  <input
                    value={hqRepo}
                    onChange={(e) => setHqRepo(e.target.value)}
                    placeholder="acme-org/acme-hq-brain"
                  />
                </label>
                <button
                  className="ghost"
                  type="button"
                  disabled={!hqRepo.includes('/') || hqBusy}
                  onClick={async () => {
                    try {
                      setHqBusy(true)
                      setNote('Waiting for GitHub. Authorize Brain Bridge on that one repo if your browser opens.')
                      const res = await window.brain.hqSync.bind(hqRepo)
                      setNote(res.detail)
                      const st = await window.brain.hqSync.ownerStatus()
                      setHq(st)
                      if (st.hq_repo) setHqRepo(st.hq_repo)
                      if (st.projects.length) {
                        setLiveProjects(st.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
                      }
                    } catch (e) {
                      setNote(String((e as Error).message || e))
                    } finally {
                      setHqBusy(false)
                    }
                  }}
                >
                  {hqBusy ? 'Waiting for GitHub…' : 'Connect this HQ'}
                </button>
                {(hq.seats || [])
                  .filter((p) => p.kind !== 'owner')
                  .map((p) => (
                    <div className="set-row" key={p.seat_id}>
                      <span>
                        {p.name} · {p.email}
                        <span className="tiny">
                          {' '}
                          · Project only
                          {p.roots?.length ? ` · ${p.roots.map((r) => prettyName(r.replace(/^projects\/|\/$/g, ''))).join(', ')}` : ''}
                          {p.status !== 'active' ? ` · ${p.status}` : ''}
                        </span>
                      </span>
                      {p.status === 'active' ? (
                        <button
                          type="button"
                          className="linkish"
                          onClick={async () => {
                            try {
                              const res = await window.brain.hqSync.revoke(p.seat_id)
                              setNote(res.detail)
                              setHq(await window.brain.hqSync.ownerStatus())
                            } catch (e) {
                              setNote(String((e as Error).message || e))
                            }
                          }}
                        >
                          Remove access
                        </button>
                      ) : null}
                    </div>
                  ))}
              </>
            )}
          </div>
          {plyntrMode ? (
            <div className="person-add">
              {!plyntrSeat ? (
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await window.brain.plyntr.createBrain({
                        label: plyntrLabel || plyntrSlug,
                        org: plyntrOrg,
                        slug: plyntrSlug,
                        scoutEmail: email,
                        rotate: true
                      })
                      if (!res.hasToken) {
                        setNote('The scout token did not come back. Try Recover again.')
                        return
                      }
                      setPlyntrBrainId(res.brainId)
                      setPlyntrSeat(true)
                      setPlyntrRows(await window.brain.plyntr.seats(res.brainId))
                      setNote('Scout token recovered.')
                    } catch (e) {
                      setNote(String((e as Error).message || e))
                    }
                  }}
                >
                  Sign in to this brain
                </button>
              ) : null}
              <p className="tiny">{packLine(companyPacks[plyntrBrainId] || brainPack)}</p>
              <p className="tiny">Create a code. It is shown once. If email is set up, they also get it in their inbox.</p>
              {canOfferPlyntrTransfer({
                accountRole: plyntrAccountRole,
                seatRole: plyntrRole,
                sessionEmail: plyntrSeatEmail || email,
                seats: plyntrRows.seats
              }) ? (
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await window.brain.plyntr.transfer(plyntrBrainId)
                      setPlyntrRows(await window.brain.plyntr.seats(plyntrBrainId))
                      const again = await window.brain.plyntr.active().catch(() => null)
                      if (again) {
                        setPlyntrRole(String(again.role || ''))
                        setPlyntrAccountRole(String(again.accountRole || ''))
                        setPlyntrSeatEmail(String(again.seatEmail || ''))
                      }
                      setNote(
                        res.email
                          ? `${res.email} is off this brain. They lose sync.`
                          : 'The Plyntr scout is off this brain.'
                      )
                    } catch (e) {
                      setNote(String((e as Error).message || e))
                    }
                  }}
                >
                  Remove Plyntr scout
                </button>
              ) : null}
              {shownCode ? <p className="note">Code: {displayPlyntrCode(shownCode)}</p> : null}
              <label className="field">
                Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field">
                Email
                <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </label>
              <label className="field">
                Seat
                <select value={mintRole} onChange={(e) => setMintRole(e.target.value as SeatRole)}>
                  {((() => {
                    const actor = asSeat(plyntrRole || seat)
                    const mine = (plyntrSeatEmail || email).trim().toLowerCase()
                    const builder =
                      actor === 'owner' ||
                      plyntrRows.seats.some(
                        (s) => s.role === 'scout' && s.bootstrap && s.email.trim().toLowerCase() === mine
                      )
                    return (builder ? ['owner', 'scout', 'team', 'project'] : ['team', 'project']) as SeatRole[]
                  })()).map((r) => (
                    <option key={r} value={r}>
                      {seatLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
              {mintRole === 'project' ? (
                liveProjects.length ? (
                  <div className="field">
                    Projects they can use
                    {liveProjects.map((p) => {
                      const on = (draft.brains || []).includes(p.id)
                      return (
                        <label className="need-row" key={p.id}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = new Set(draft.brains || [])
                              if (on) cur.delete(p.id)
                              else cur.add(p.id)
                              setDraft({ ...draft, brains: [...cur], brain: [...cur][0] || '' })
                            }}
                          />
                          <span>{prettyName(p.name)}</span>
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <p className="tiny">No project folders in this brain yet. Add folders under projects/ before a Project only seat.</p>
                )
              ) : null}
              <button
                className="primary"
                type="button"
                disabled={
                  !draft.name.trim() ||
                  !draft.email.includes('@') ||
                  (mintRole === 'project' && (!(draft.brains || []).length || hqBusy))
                }
                onClick={async () => {
                  try {
                    const roots =
                      mintRole === 'project'
                        ? (draft.brains || []).map((id) => (id.startsWith('projects/') || id.startsWith('clients/') ? id : `projects/${id}/`))
                        : undefined
                    let connected = false
                    if (mintRole === 'project') {
                      const repo = plyntrOrg && plyntrSlug ? `${plyntrOrg}/${plyntrSlug}-brain` : hqRepo
                      const inst = await window.brain.plyntr.installed(plyntrBrainId, repo).catch(() => null)
                      if (!inst || !inst.projectSeatCount) {
                        if (!repo.includes('/')) {
                          setNote('Connect project sync on this brain before the first project person.')
                          return
                        }
                        setHqBusy(true)
                        setNote('Connecting project sync. Authorize Brain Bridge on that one repo if your browser opens.')
                        const bound = await window.brain.plyntr.bind(plyntrBrainId)
                        if (!bound.ok) {
                          setNote(bound.detail || 'Connect project sync before the first project person.')
                          return
                        }
                        connected = true
                        setNote(bound.detail)
                        const st = await window.brain.hqSync.ownerStatus().catch(() => null)
                        if (st) {
                          setHq(st)
                          if (st.hq_repo) setHqRepo(st.hq_repo)
                          if (st.projects.length) {
                            setLiveProjects(st.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
                          }
                        }
                      }
                    }
                    const knownPack = companyPacks[plyntrBrainId] || brainPack
                    const blocked = starterBlocksAdd(
                      knownPack,
                      [
                        ...plyntrRows.seats,
                        ...plyntrRows.invites.map((invite) => ({ role: invite.role, status: invite.status }))
                      ],
                      mintRole
                    )
                    if (blocked) {
                      setNote(blocked)
                      return
                    }
                    const res = await window.brain.plyntr.invite(plyntrBrainId, {
                      name: draft.name.trim(),
                      email: draft.email.trim().toLowerCase(),
                      role: mintRole,
                      roots
                    })
                    let bindNote = ''
                    if (res.needsBridge && !connected) {
                      const repo = plyntrOrg && plyntrSlug ? `${plyntrOrg}/${plyntrSlug}-brain` : hqRepo
                      if (repo.includes('/')) {
                        setNote('Connecting project sync. Authorize Brain Bridge on that one repo if your browser opens.')
                        const bound = await window.brain.plyntr.bind(plyntrBrainId)
                        if (!bound.ok) bindNote = bound.detail || 'Connect project sync before the first project person.'
                      }
                    }
                    setShownCode(res.code)
                    setNote(
                      bindNote ||
                        (res.emailed
                          ? 'The code is in their email and on this screen once.'
                          : 'The code is on this screen once. Email did not send.')
                    )
                    setPlyntrRows(await window.brain.plyntr.seats(plyntrBrainId))
                    setDraft({ name: '', email: '', role: 'team', brain: '', brains: [] })
                    setMintRole('team')
                  } catch (e) {
                    setNote(String((e as Error).message || e))
                  } finally {
                    setHqBusy(false)
                  }
                }}
              >
                Create a code
              </button>
              <p className="tiny">{macSyncHint(syncHint)}</p>
              {plyntrRows.invites
                .filter((i) => i.status === 'pending')
                .map((i) => (
                  <div className="set-row" key={i.inviteId}>
                    <span>
                      {i.name} · {i.email}
                      <span className="tiny">
                        {' '}
                        · {seatLabel(i.role)} · waiting{untilHint(i.expiresAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="linkish"
                      onClick={async () => {
                        const who = i.name || i.email
                        if (!window.confirm(`Revoke the code for ${who}? They will not be able to use it. You can invite them again.`)) return
                        await window.brain.plyntr.revokeInvite(plyntrBrainId, i.inviteId)
                        setPlyntrRows(await window.brain.plyntr.seats(plyntrBrainId))
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              {plyntrRows.seats
                .filter((s) => s.status === 'active')
                .map((s) => (
                  <div className="set-row" key={s.id}>
                    <span>
                      {s.name || s.email} · {s.email}
                      <span className="tiny">
                        {' '}
                        · {seatLabel(s.role)}
                        {s.roots?.length ? ` · ${s.roots.join(', ')}` : ''}
                      </span>
                    </span>
                    {s.plyntrScout ? null : (
                      <button
                        type="button"
                        className="linkish"
                        onClick={async () => {
                          const who = s.name || s.email
                          if (!window.confirm(`Revoke ${who}'s access to this brain? They lose it until you invite them again.`)) return
                          try {
                            await window.brain.plyntr.revokeSeat(plyntrBrainId, s.id)
                            setPlyntrRows(await window.brain.plyntr.seats(plyntrBrainId))
                          } catch (e) {
                            setNote(String((e as Error).message || e))
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
            </div>
          ) : null}
          {!plyntrMode && people.map((p) => {
            const ids = p.brains?.length ? p.brains : p.brain && p.brain !== 'hq' ? [p.brain] : []
            const names = ids.map((id) => liveProjects.find((x) => x.id === id)?.name || prettyName(id)).join(', ')
            const seatLine =
              p.role === 'project' ? `Project only${names ? ` · ${names}` : ''}` : seatLabel(p.role)
            return (
              <div className="set-row" key={p.email}>
                <span>
                  {p.name} · {p.email}
                  <span className="tiny"> · {seatLine}</span>
                </span>
                <button
                  type="button"
                  className="linkish"
                  onClick={async () => {
                    const next = people.filter((x) => x.email !== p.email)
                    setPeople((await window.brain.settings.saveTeam(next)) as Person[])
                    setNote(`Removed ${p.email} from this Mac list.`)
                  }}
                >
                  Remove
                </button>
              </div>
            )
          })}
          {!plyntrMode ? <div className="person-add">
            <label className="field">
              Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Maya" />
            </label>
            <label className="field">
              Email
              <input
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="maya@acme.org"
              />
            </label>
            <label className="field">
              Seat
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Person['role'] })}>
                <option value="team">Team</option>
                <option value="project">Project only</option>
                <option value="scout">Scout</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            {draft.role === 'team' ? (
              <p className="tiny">They use this whole brain ({here}), same folder as owners, without skill-edit rights.</p>
            ) : null}
            {draft.role === 'project' ? (
              liveProjects.length ? (
                <div className="field">
                  Projects they can use
                  {liveProjects.map((p) => {
                    const on = (draft.brains || []).includes(p.id)
                    return (
                      <label className="need-row" key={p.id}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const cur = new Set(draft.brains || [])
                            if (on) cur.delete(p.id)
                            else cur.add(p.id)
                            setDraft({ ...draft, brains: [...cur], brain: [...cur][0] || '' })
                          }}
                        />
                        <span>{prettyName(p.name)}</span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <p className="tiny">No project folders in this brain yet. Add folders under projects/ before a Project only seat.</p>
              )
            ) : draft.role === 'owner' || draft.role === 'scout' ? (
              <p className="tiny">They use all of {here}.</p>
            ) : null}
            <button
              className="primary"
              type="button"
              disabled={
                !draft.name.trim() ||
                !draft.email.includes('@') ||
                (draft.role === 'project' && (!(draft.brains || []).length || !hq?.signedIn))
              }
              onClick={async () => {
                const brains = draft.role === 'project' ? draft.brains || [] : []
                const res = await window.brain.settings.addTeammate({
                  name: draft.name.trim(),
                  email: draft.email.trim().toLowerCase(),
                  role: draft.role,
                  brain: brains[0] || 'hq',
                  brains
                })
                const roster = await window.brain.settings.roster().catch(() => [])
                setPeople(roster.length ? roster : (res.people as Person[]))
                setNote(res.roster.ok ? res.roster.detail || `${draft.name} can sign in with that email.` : res.roster.detail)
                if (draft.role === 'project') {
                  const st = await window.brain.hqSync.ownerStatus().catch(() => null)
                  if (st) setHq(st)
                }
                setDraft({ name: '', email: '', role: 'team', brain: '', brains: [] })
              }}
            >
              Add this person
            </button>
          </div> : null}
        </section>
      ) : (
        <section className="biz current">
          <h3>{businessTitle({ name: brainName, path: brainPath, slug: brains.find((b) => b.current)?.slug || '' }, companyLabels[brains.find((b) => b.current)?.brainId || ''] || '')}</h3>
          <p className="biz-brain">Brain · {here}</p>
          <p className="tiny">{channelLine({ syncMode: folderSync, watching: brains.find((b) => b.current)?.watching })}</p>
          {joe && superAdmin && (brains.find((b) => b.current)?.brainId || plyntrBrainId) ? (
            <PackSelect
              value={companyPacks[brains.find((b) => b.current)?.brainId || plyntrBrainId] || brainPack}
              onChange={(next) => {
                const id = brains.find((b) => b.current)?.brainId || plyntrBrainId
                void window.brain.plyntr
                  .setPack(id, next)
                  .then((saved) => {
                    setCompanyPacks((prev) => ({ ...prev, [saved.brainId]: saved.pack }))
                    setBrainPack(saved.pack)
                    setNote(packLine(saved.pack))
                  })
                  .catch((err) => setNote(String((err as Error).message || err)))
              }}
            />
          ) : null}
          {localSyncOffer()}
          <p>You are {seatLabel(seat || role)} in {here}. The owner adds people.</p>
          {(rosters[brainPath] || []).map((p) => (
            <div className="set-row" key={p.email}>
              <span>
                {p.name || p.email} · {p.email}
                <span className="tiny"> · {seatLabel(p.role)}</span>
              </span>
            </div>
          ))}
        </section>
      )}
        {brainsAfter.map((b) => renderOtherBrain(b))}
      </div>


      {email && brainPath ? (
      <section className="set-block" style={{ borderTop: 0, paddingTop: 0 }}>
        <p className="kicker">Phone</p>
        <h3 className="set-h">Use Brain from your phone</h3>
        <p>
          Works on cellular or any wifi. This Mac has to stay on, with Brain.app open, and plugged in. Closing the lid
          on battery will sleep. Scan the QR with the phone camera, like linking a WhatsApp device. Only a phone that
          scanned that QR can read chats on this Mac and send into Grok, Claude, Cursor, or ChatGPT as you. Remove a
          phone here to kick it off. Turning Phone on does not unlink phones you already linked.
        </p>
        <label className="set-row">
          <span>Phone</span>
          <button
            type="button"
            className={phone.on ? 'primary' : 'ghost'}
            disabled={phoneBusy}
            onClick={() => {
              setPhoneBusy(true)
              const run = phone.on ? window.brain.phone.stop() : window.brain.phone.start()
              void run
                .then(setPhone)
                .finally(() => setPhoneBusy(false))
            }}
          >
            {phoneBusy ? 'Working…' : phone.on ? 'On' : 'Off'}
          </button>
        </label>
        {phone.detail ? <p className="tiny">{phone.detail}</p> : null}
        {phoneNote ? <p className="tiny">{phoneNote}</p> : null}
        {phone.on ? (
          <>
            <p className="tiny">
              {phone.watching
                ? 'A linked phone is using this Mac.'
                : 'Waiting for a phone. Scan the QR, or type the code on the phone.'}
            </p>
            {phone.origin ? <p className="tiny">{phone.origin.replace(/^https:\/\//, '')}</p> : null}
            {phone.pairQr ? (
              <div className="phone-qr" dangerouslySetInnerHTML={{ __html: phone.pairQr }} />
            ) : (
              <p className="tiny">QR is ready after the tunnel comes up.</p>
            )}
            {phone.pairPin ? <p className="phone-pin">{phone.pairPin}</p> : null}
            <p className="tiny">The QR and code last two minutes, then this screen makes a new one. Each scan links one phone.</p>
            <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void window.brain.phone
                    .link()
                    .then(setPhone)
                    .catch((err) => setPhoneNote(String((err as Error).message || err)))
                }}
              >
                New QR
              </button>
            </div>
            {phone.devices.length ? (
              <div style={{ marginTop: '0.6rem' }}>
                <p className="tiny">Linked phones</p>
                {phone.devices.map((d) => (
                  <div key={d.id} className="phone-dev">
                    <span>{d.label}</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        void window.brain.phone
                          .unlink(d.id)
                          .then(setPhone)
                          .catch((err) => setPhoneNote(String((err as Error).message || err)))
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      ) : null}

      <section className="set-block">
        <p className="tiny">Brain {appVer || ''}</p>
        <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
          <button
            className="ghost"
            type="button"
            onClick={async () => {
              setUpd('Checking for an update…')
              const r = await window.brain.checkUpdate()
              if (!r.ok && r.detail) setUpd(r.detail)
            }}
          >
            Check for update
          </button>
          {upd.includes('ready') ? (
            <button className="primary" type="button" onClick={() => void window.brain.installUpdate()}>
              Restart to install
            </button>
          ) : null}
        </div>
        {upd ? <p className="tiny">{upd}</p> : null}
      </section>

      {onLogout && email ? (
        <p>
          <button type="button" className="ghost" onClick={onLogout}>
            Log out
          </button>
          <span className="tiny"> Chats and this brain folder stay on this computer.</span>
        </p>
      ) : null}

      {isJoeSuperAdmin(shell) ? (
        <section className="set-block">
          <FoldHead
            kicker="Ads2AI"
            title="Add a new company brain"
            open={openAdd}
            onToggle={() => {
              setOpenAdd((v) => !v)
              if (openAdd) {
                setPending(null)
              }
            }}
          />
          {openAdd ? (
            <>
              <p>
                Create the company in Ads2AI first. Paste the code it gives you. If GitHub is not done, we walk you
                through that here. If it is, we copy the folder onto this computer. Switching above also switches Agency
                Brain so it watches this brain. Chats stay with each brain.
              </p>
              {pending ? (
                <>
                  <p>
                    The app is not installed on GitHub for this company yet. Open GitHub, create the short name if you
                    do not have one, then install. Click Install, then Only select repositories.
                  </p>
                  <label className="field">
                    GitHub short name
                    <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="harolds-books" />
                  </label>
                  <p className="tiny">The short GitHub name, not the business name. Copy it from the GitHub page.</p>
                  <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                    <button
                      className="ghost"
                      type="button"
                      onClick={async () => {
                        const r = await window.brain.setup.openCreateOrg().catch(() => null)
                        const login = String(r?.org || '').trim()
                        if (login) setOrg(login)
                      }}
                    >
                      Open GitHub
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={bizBusy || org.trim().length < 2}
                      onClick={async () => {
                        if (org.trim().length < 2) {
                          setNote('Create the short name on GitHub, then paste it here.')
                          return
                        }
                        try {
                          setBizBusy(true)
                          setNote('')
                          const look = await window.brain.setup.lookupOrg(org.trim())
                          if (look && look.ok === false) {
                            setNote(look.detail || look.reason || 'GitHub did not accept that name')
                            return
                          }
                          const login = String(look?.login || org.trim())
                          if (look?.login) setOrg(look.login)
                          await window.brain.setup.openAppInstall(pending.slug, login)
                          setNote('In the browser: click Install, then Only select repositories. We wait here.')
                          const waited = await window.brain.setup.waitInstall(pending.slug)
                          if (!waited.ok) {
                            setNote(waited.detail || 'GitHub is not finished. Click Install, then try again.')
                            return
                          }
                          const applied = await window.brain.setup.putFolder({ teamSlug: pending.slug, org: login })
                          const path = String(applied?.brainPath || '')
                          if (!path) {
                            setNote(applied?.detail || 'Could not copy the shared folder.')
                            return
                          }
                          const bridge = await window.brain.setup.bridgeStatus(path)
                          if (!bridge.installed) {
                            setNote('Install Brain Bridge on this repo. Choose Only select repositories, then pick this repo.')
                            await window.brain.setup.openBridge(path)
                            const waited = await window.brain.setup.waitBridge(path)
                            if (!waited.ok) {
                              setNote(waited.detail || 'Brain Bridge is not installed on this repo yet.')
                              return
                            }
                          }
                          await window.brain.brains.remember({
                            path,
                            name: pending.name,
                            slug: pending.slug
                          })
                          const row = await window.brain.brains.switch(path)
                          setBrains(await window.brain.brains.list())
                          setBrainPath(row.path)
                          setBrainName(placeName(row.path, prettyName(row.name)))
                          onSwitchBrain?.({ path: row.path, name: placeName(row.path, row.name) })
                          setPending(null)
                          setOpenAdd(false)
                          setAdsCode('')
                          setOrg('')
                          setNote(nowIn(row))
                        } catch (e) {
                          setNote(String((e as Error).message || e))
                        } finally {
                          setBizBusy(false)
                        }
                      }}
                    >
                      {bizBusy ? 'Installing…' : 'Install on GitHub'}
                    </button>
                  </div>
                </>
              ) : null}
              {!pending ? (
                <>
                  <label className="field">
                    Ads2AI code
                    <input
                      value={adsCode}
                      onChange={(e) => setAdsCode(e.target.value)}
                      placeholder="184392"
                      autoComplete="one-time-code"
                    />
                  </label>
                  <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                    <button
                      className="primary"
                      type="button"
                      disabled={bizBusy || adsCode.replace(/[^A-Za-z0-9]/g, '').length < 4}
                      onClick={async () => {
                        const code = adsCode.replace(/[^A-Za-z0-9]/g, '')
                        if (code.length < 4) {
                          setNote('Paste the code Ads2AI showed after you created the company.')
                          return
                        }
                        try {
                          setBizBusy(true)
                          const res = await window.brain.brains.add({ code })
                          if (res.setup) {
                            setPending({ slug: String(res.slug || ''), name: String(res.name || 'this company') })
                            setNote('The app is not installed on GitHub yet. Open GitHub, create the short name if you need one, then click Install on GitHub.')
                            return
                          }
                          if (res.brainPath) {
                            setBrains(await window.brain.brains.list())
                            setBrainPath(res.brainPath)
                            setBrainName(placeName(res.brainPath, prettyName(String(res.name || ''))))
                            onSwitchBrain?.({ path: res.brainPath, name: placeName(res.brainPath, String(res.name || '')) })
                            setOpenAdd(false)
                            setAdsCode('')
                            setNote(nowIn({ path: res.brainPath, name: String(res.name || ''), agency: res.agency }))
                            return
                          }
                          setNote(res.detail || 'That code did not finish.')
                        } catch (e) {
                          setNote(String((e as Error).message || e))
                        } finally {
                          setBizBusy(false)
                        }
                      }}
                    >
                      {bizBusy ? 'Adding…' : 'Add this brain'}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {canMove ? (
        <section className="set-block">
          <p className="kicker">Plyntr sync</p>
          <h3 className="set-h">Move this brain to Plyntr sync</h3>
          <p>
            Install Plyntr sync on this same GitHub organization, not Plyntr LLC. Keep Only select repositories. Do not
            choose All repositories. If the page says Plyntr LLC, do not click Install. Close that page and try again. If
            it still says Plyntr LLC, stop and tell Plyntr. This Mac then syncs with Plyntr and stops using the Agency
            Brain git token. If Agency Brain is already syncing this folder, stop that first.
          </p>
          <button
            className="primary"
            type="button"
            disabled={moveBusy}
            onClick={async () => {
              try {
                setMoveBusy(true)
                setNote('Installing Plyntr sync on this repo, then switching this folder.')
                const res = await window.brain.plyntr.move()
                setNote(res.detail)
                if (!res.ok) return
                await takePlyntrActive(await window.brain.plyntr.active().catch(() => null))
              } catch (e) {
                setNote(String((e as Error).message || e))
              } finally {
                setMoveBusy(false)
              }
            }}
          >
            {moveBusy ? 'Moving…' : 'Move this brain to Plyntr sync'}
          </button>
        </section>
      ) : null}


      {joe ? (
        <section className="set-block">
          <FoldHead
            kicker="Skin captures"
            title="Catalog school"
            open={openCatalog}
            onToggle={() => setOpenCatalog((v) => !v)}
          />
          {openCatalog ? (
            <>
          <p>
            Only you see this. Capture logs unmatched CLI screens on this Mac. When Jev is on, high-confidence unmatched
            screens join this Mac’s catalog on their own. Permission screens stay proposed. Jev does not Allow a write.
          </p>
          <label className="set-row">
            <span>Capture screens</span>
            <button
              type="button"
              className={skinCap ? 'primary' : 'ghost'}
              onClick={() => {
                void window.brain.skin.toggle(!skinCap).then((r) => setSkinCap(Boolean(r.capture)))
              }}
            >
              {skinCap ? 'On' : 'Off'}
            </button>
          </label>
          <label className="set-row">
            <span>Jev</span>
            <button
              type="button"
              className={skinJev ? 'primary' : 'ghost'}
              onClick={() => {
                void window.brain.skin.toggleJev(!skinJev).then((r) => {
                  setSkinJev(Boolean(r.jev))
                  setJevReady(Boolean(r.jevReady))
                  if (r.jev) {
                    void window.brain.skin.get().then((s) => setLearned(s.learned || []))
                    void window.brain.skin.list().then(setCaptures)
                  }
                })
              }}
            >
              {skinJev ? 'On' : 'Off'}
            </button>
          </label>
          {skinJev && !jevReady ? (
            <p className="tiny">Jev needs Doppler TypeSafe on this Mac. New unmatched screens wait until the key is ready.</p>
          ) : null}
          {skinJev && jevReady ? (
            <p className="tiny">Jev is working unmatched captures into this Mac’s catalog in the background.</p>
          ) : null}
          {learned.length ? (
            <ul className="looking">
              {learned.slice(0, 12).map((row) => (
                <li key={row.cli + row.eventKind}>
                  <span>
                    {row.cli} · {row.eventKind} · {row.component} · {row.confidence.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {captures.length === 0 ? (
            <p className="tiny">No captures yet.</p>
          ) : (
            <ul className="looking">
              {captures.slice(0, 24).map((c) => (
                <li key={c.fingerprint + c.at}>
                  <span>
                    {c.cli} · {c.eventKind} · {c.matched ? c.catalogId : 'unmatched'}
                    {c.learned ? ' · catalog' : ''}
                    {c.label ? ` · ${c.label}` : ''}
                    {c.jevProposal
                      ? ` · Jev ${c.jevProposal.component || 'unknown'} ${c.jevProposal.confidence.toFixed(2)}${c.jevProposal.paint ? ' paint' : ''}`
                      : ''}
                  </span>
                  {skinJev && !c.matched ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={jevBusy === c.fingerprint}
                      onClick={() => {
                        setJevBusy(c.fingerprint)
                        void window.brain.skin
                          .propose(c.fingerprint)
                          .then((r) => {
                            if (!r.ok) setNote(r.detail || 'Jev could not propose.')
                            return window.brain.skin.list()
                          })
                          .then(setCaptures)
                          .finally(() => setJevBusy(''))
                      }}
                    >
                      {jevBusy === c.fingerprint ? 'Jev…' : 'Propose'}
                    </button>
                  ) : null}
                  <select
                    value={c.label || ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (!v) return
                      void window.brain.skin.label(c.fingerprint, v).then(() => {
                        void window.brain.skin.list().then(setCaptures)
                      })
                    }}
                  >
                    <option value="">Label</option>
                    <option value="raw">raw</option>
                    <option value="ignore">ignore</option>
                    {(
                      [
                        'UserMessage',
                        'AgentMessage',
                        'Thought',
                        'ToolCard',
                        'WorkPulse',
                        'PermissionAsk',
                        'Picker',
                        'SlashMenu',
                        'Plan',
                        'ContextMeter',
                        'CompactNotice',
                        'ErrorNotice',
                        'LoginNeed',
                        'Queue',
                        'RawFallback'
                      ] as const
                    ).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
            </>
          ) : null}
        </section>
      ) : null}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
