import { useEffect, useState } from 'react'
import { isTeamSeat, seatLabel, type SeatRole } from '@shared/contracts'

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

function prettyName(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

function nowIn(row: {
  name: string
  agency?: { ok: boolean; detail: string }
  hq?: { ok: boolean; detail: string }
}): string {
  const name = prettyName(row.name) || 'this brain'
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
  onSwitchBrain
}: {
  role?: string
  onClose: () => void
  onLogout?: () => void
  onSwitchBrain?: (row: { path: string; name: string }) => void
}) {
  const [superAdmin, setSuper] = useState(false)
  const [email, setEmail] = useState('')
  const [helloName, setHelloName] = useState('')
  const [brainName, setBrainName] = useState('')
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
    { path: string; name: string; slug: string; watching?: boolean; current?: boolean }[]
  >([])
  const [openAdd, setOpenAdd] = useState(false)
  const [openPeople, setOpenPeople] = useState(false)
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
  }>({ on: false, url: '', origin: '', detail: '', platform: '', watching: false })
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [phoneNote, setPhoneNote] = useState('')
  const joe = email === 'joe@plyntr.com'
  const canAddUsers = joe || !isTeamSeat(seat || role)

  useEffect(() => {
    void (async () => {
      const [s, list] = await Promise.all([
        window.brain.settings.get(),
        window.brain.brains.list().catch(() => [])
      ])
      setSuper(s.superAdmin)
      setEmail(s.email)
      setHelloName(String(s.name || '').trim())
      setBrainName(prettyName(String(s.brainName || '')))
      setSeat(String(s.role || ''))
      setBrains(list)
      setLoaded(true)
      const [roster, projects, bridge, ver, skin, phoneNow] = await Promise.all([
        window.brain.settings.roster().catch(() => []),
        window.brain.settings.projects().catch(() => []),
        window.brain.hqSync.ownerStatus().catch(() => null),
        window.brain.version().catch(() => ''),
        window.brain.skin.get().catch(() => ({
          capture: false,
          jev: false,
          jevReady: false,
          joe: false,
          components: [] as string[],
          learned: [] as { cli: string; eventKind: string; component: string; confidence: number }[]
        })),
        window.brain.phone.status().catch(() => ({
          on: false,
          url: '',
          origin: '',
          detail: '',
          platform: '',
          watching: false
        }))
      ])
      const local = roster.length ? roster : await window.brain.settings.team().catch(() => [])
      setPeople(local)
      setLiveProjects(projects)
      if (bridge) {
        setHq(bridge)
        const watched = await window.brain.hqSync.watchedRepo().catch(() => '')
        setFolderRepo(watched)
        setHqRepo(watched || bridge.hq_repo || '')
        if (bridge.projects.length) {
          setLiveProjects(bridge.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
        }
      }
      setAppVer(ver)
      setPhone(phoneNow)
      if (skin.joe) {
        setSkinCap(Boolean(skin.capture))
        setSkinJev(Boolean(skin.jev))
        setJevReady(Boolean(skin.jevReady))
        setLearned(skin.learned || [])
        setCaptures(await window.brain.skin.list().catch(() => []))
      }
    })()
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
      offUpdate()
      offHeal()
      offBack()
      offPhone()
    }
  }, [])

  useEffect(() => {
    if (!phone.on) return
    const t = window.setInterval(() => {
      void window.brain.phone.status().then(setPhone)
    }, 2000)
    return () => window.clearInterval(t)
  }, [phone.on])

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
  const here = brainName || 'this brain'

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
        {joe && superAdmin && brains.length ? (
          <label className="field" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
            Switch brain
            <select
              value={brains.find((b) => b.current)?.path || ''}
              onChange={async (e) => {
                const path = e.target.value
                if (!path) return
                try {
                  const row = await window.brain.brains.switch(path)
                  setBrains(await window.brain.brains.list())
                  setBrainName(prettyName(row.name))
                  onSwitchBrain?.(row)
                  const bridge = await window.brain.hqSync.ownerStatus().catch(() => null)
                  setHq(bridge)
                  setFolderRepo(await window.brain.hqSync.watchedRepo().catch(() => ''))
                  setNote(nowIn(row))
                } catch (err) {
                  setNote(String((err as Error).message || err))
                }
              }}
            >
              {brains.map((b) => (
                <option key={b.path} value={b.path}>
                  {prettyName(b.name || b.slug || b.path)}
                  {b.watching ? ' · Agency Brain watching' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <section className="set-block" style={{ borderTop: 0, paddingTop: 0 }}>
        <p className="kicker">Phone</p>
        <h3 className="set-h">Use Brain from Safari</h3>
        <p>
          Works on cellular or any wifi. This Mac has to stay on, with Brain.app open, and plugged in. Closing the lid
          on battery will sleep. Safari may ask for a one-time email code (joe@plyntr.com or joewine2@gmail.com). If
          the page is blank after that, copy the secret link again and open it a second time.
        </p>
        <p>
          The copied link is the key. Anyone who has it, while Phone is on, can read every chat on this Mac and send
          into Grok, Claude, Cursor, or ChatGPT as you. Do not screenshot it, paste it into chat, or share this
          Settings screen. Turning Phone on makes a new code. The code dies after 12 hours, or when you turn Phone off
          or tap New code. Chats on the wire are encrypted with a separate key that stays in the hash on your phone
          and is never sent as a header. Cloudflare can still see that Phone is on.
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
              {phone.watching ? 'A phone is using this Mac.' : 'Waiting for the phone. Copy the secret link and open it in Safari.'}
            </p>
            {phone.origin ? <p className="tiny">{phone.origin.replace(/^https:\/\//, '')}</p> : null}
            <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
              <button
                type="button"
                className="ghost"
                disabled={!phone.url}
                onClick={() => {
                  void window.brain.phone
                    .copy()
                    .then((r) => {
                      if (r.ok) {
                        setCopied(true)
                        setPhoneNote('Secret link copied. Open it in Safari on the phone.')
                        window.setTimeout(() => setCopied(false), 1500)
                      } else {
                        setPhoneNote('Could not copy. Wait until Phone is fully on.')
                      }
                    })
                    .catch((err) => setPhoneNote(String((err as Error).message || err)))
                }}
              >
                {copied ? 'Copied' : 'Copy secret link'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void window.brain.phone
                    .rotate()
                    .then((s) => {
                      setPhone(s)
                      return window.brain.phone.copy()
                    })
                    .then((r) => {
                      if (r?.ok) {
                        setCopied(true)
                        setPhoneNote('New link copied. Open it on the phone. The old one is dead.')
                        window.setTimeout(() => setCopied(false), 2000)
                      } else {
                        setPhoneNote('Made a new code. Copy the secret link and open it on the phone.')
                      }
                    })
                    .catch((err) => setPhoneNote(String((err as Error).message || err)))
                }}
              >
                New code
              </button>
            </div>
          </>
        ) : null}
      </section>

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

      {joe && superAdmin ? (
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
                    Finish GitHub so this company has a shared folder. A browser will open. Sign in if GitHub asks. A
                    passkey works there.
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
                      onClick={() => window.brain.setup.openCreateOrg()}
                    >
                      Open GitHub
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={bizBusy || org.trim().length < 2}
                      onClick={async () => {
                        if (org.trim().length < 2) {
                          setNote('Paste the GitHub short name first. Open GitHub if you do not have it yet.')
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
                          await window.brain.brains.remember({
                            path,
                            name: pending.name,
                            slug: pending.slug
                          })
                          const row = await window.brain.brains.switch(path)
                          setBrains(await window.brain.brains.list())
                          setBrainName(prettyName(row.name))
                          onSwitchBrain?.(row)
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
                      {bizBusy ? 'Setting up…' : 'Continue with GitHub'}
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
                            setNote('GitHub is not on this brain yet. Open GitHub, paste the short name, then Continue.')
                            return
                          }
                          if (res.brainPath) {
                            setBrains(await window.brain.brains.list())
                            setBrainName(prettyName(String(res.name || '')))
                            onSwitchBrain?.({ path: res.brainPath, name: String(res.name || '') })
                            setOpenAdd(false)
                            setAdsCode('')
                            setNote(nowIn({ name: String(res.name || ''), agency: res.agency }))
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

      {canAddUsers ? (
        <section className="set-block">
          <FoldHead
            kicker={`People in ${here}`}
            title="Add users"
            open={openPeople}
            onToggle={() => setOpenPeople((v) => !v)}
          />
          {openPeople ? (
            <>
          <p>
            Agency team is on this whole brain. Project only never clones HQ. This app copies only the folders you tick,
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
          {people.map((p) => {
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
          <div className="person-add">
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
                <option value="team">Agency team</option>
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
          </div>
            </>
          ) : null}
        </section>
      ) : (
        <p>
          You are {seatLabel(seat || role)} in {here}. The owner adds people.
        </p>
      )}

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
