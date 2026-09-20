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

export function SettingsPanel({
  role,
  onClose,
  onLogout
}: {
  role?: string
  onClose: () => void
  onLogout?: () => void
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
  const [hq, setHq] = useState<HqStatus | null>(null)
  const [hqCode, setHqCode] = useState('')
  const [hqRepo, setHqRepo] = useState('')
  const [folderRepo, setFolderRepo] = useState('')
  const [hqBusy, setHqBusy] = useState(false)
  const [bizName, setBizName] = useState('')
  const [bizEmail, setBizEmail] = useState('')
  const [bizOwnerName, setBizOwnerName] = useState('')
  const [bizRole, setBizRole] = useState<'owner' | 'scout'>('owner')
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
      jevProposal?: {
        component: string | null
        confidence: number
        paint: boolean
        detail: string
      } | null
    }[]
  >([])
  const joe = email === 'joe@plyntr.com'
  const canAddUsers = joe || !isTeamSeat(seat || role)

  useEffect(() => {
    void (async () => {
      const s = await window.brain.settings.get()
      setSuper(s.superAdmin)
      setEmail(s.email)
      setHelloName(String(s.name || '').trim())
      setBrainName(prettyName(String(s.brainName || '')))
      setSeat(String(s.role || ''))
      const roster = await window.brain.settings.roster().catch(() => [])
      const local = roster.length ? roster : await window.brain.settings.team()
      setPeople(local)
      setLiveProjects(await window.brain.settings.projects().catch(() => []))
      const bridge = await window.brain.hqSync.ownerStatus().catch(() => null)
      if (bridge) {
        setHq(bridge)
        const watched = await window.brain.hqSync.watchedRepo().catch(() => '')
        setFolderRepo(watched)
        setHqRepo(watched || bridge.hq_repo || '')
        if (bridge.projects.length) {
          setLiveProjects(bridge.projects.map((p) => ({ id: p.slug, name: prettyName(p.slug) })))
        }
      }
      setAppVer(await window.brain.version().catch(() => ''))
      const skin = await window.brain.skin
        .get()
        .catch(() => ({ capture: false, jev: false, jevReady: false, joe: false, components: [] }))
      if (skin.joe) {
        setSkinCap(Boolean(skin.capture))
        setSkinJev(Boolean(skin.jev))
        setJevReady(Boolean(skin.jevReady))
        setCaptures(await window.brain.skin.list().catch(() => []))
      }
      setLoaded(true)
    })()
    return window.brain.onUpdate((ev) => {
      if (ev.status === 'checking') setUpd('Checking for an update…')
      else if (ev.status === 'available') setUpd(`Update ${ev.detail} is downloading.`)
      else if (ev.status === 'none') setUpd('You already have the latest Brain.')
      else if (ev.status === 'downloaded') setUpd(`Update ${ev.detail} is ready. Restart to install. Your chats stay.`)
      else if (ev.status === 'error') setUpd(ev.detail || 'Could not check for an update.')
    })
  }, [])

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
      </div>

      <section className="set-block" style={{ borderTop: 0, paddingTop: 0 }}>
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
          <p className="kicker">Superadmin</p>
          <h3 className="set-h">Add a company</h3>
          <p>
            Only you see this. This starts a new company. They get a login email and connect GitHub themselves. It is not
            added to {here}.
          </p>
          {folderRepo && hq?.hq_repo && folderRepo !== hq.hq_repo ? (
            <p className="tiny">
              This window is {here} ({folderRepo}). Project sync is still on {hq.hq_repo}.
            </p>
          ) : null}
          {!hq?.signedIn ? (
            <>
              <p className="tiny">A six-digit code to joe@plyntr.com unlocks send. It lasts ten minutes.</p>
              <label className="field">
                Login code
                <input value={hqCode} onChange={(e) => setHqCode(e.target.value)} placeholder="184 392" />
              </label>
              <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    try {
                      await window.brain.hqSync.ownerRequestCode('joe@plyntr.com')
                      setNote('Check joe@plyntr.com for a six-digit code. It lasts ten minutes.')
                    } catch (e) {
                      setNote(String((e as Error).message || e))
                    }
                  }}
                >
                  Email me a login code
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={hqCode.replace(/\s/g, '').length < 4}
                  onClick={async () => {
                    try {
                      await window.brain.hqSync.ownerLogin({ email: 'joe@plyntr.com', code: hqCode })
                      setHq(await window.brain.hqSync.ownerStatus())
                      setNote('Signed in. Add a company below.')
                    } catch (e) {
                      setNote(String((e as Error).message || e))
                    }
                  }}
                >
                  Sign in
                </button>
              </div>
            </>
          ) : (
            <p className="tiny">Signed in as {hq.email}.</p>
          )}
          {(hq?.businesses || []).map((b) => (
            <p className="tiny" key={b.id}>
              {b.name}
              {b.owners?.[0]?.email ? ` · ${b.owners[0].email}` : ''}
              {b.hq_repo ? ` · ${b.hq_repo}` : ''}
            </p>
          ))}
          <label className="field">
            Company name
            <input value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="Acme" />
          </label>
          <label className="field">
            First owner name
            <input value={bizOwnerName} onChange={(e) => setBizOwnerName(e.target.value)} placeholder="Pat" />
          </label>
          <label className="field">
            First owner email
            <input value={bizEmail} onChange={(e) => setBizEmail(e.target.value)} placeholder="pat@acme.org" />
          </label>
          <label className="field">
            Role
            <select value={bizRole} onChange={(e) => setBizRole(e.target.value === 'scout' ? 'scout' : 'owner')}>
              <option value="owner">owner</option>
              <option value="scout">scout</option>
            </select>
          </label>
          <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
            <button
              className="primary"
              type="button"
              disabled={bizBusy || !bizName.trim() || !bizEmail.includes('@') || !hq?.signedIn}
              onClick={async () => {
                try {
                  setBizBusy(true)
                  const res = await window.brain.hqSync.addCompany({
                    name: bizName,
                    email: bizEmail,
                    owner_name: bizOwnerName,
                    role: bizRole
                  })
                  setNote(res.detail)
                  setBizName('')
                  setBizEmail('')
                  setBizOwnerName('')
                  setBizRole('owner')
                  setHq(await window.brain.hqSync.ownerStatus())
                } catch (e) {
                  setNote(String((e as Error).message || e))
                } finally {
                  setBizBusy(false)
                }
              }}
            >
              {bizBusy ? 'Sending login…' : 'Add company and send login'}
            </button>
          </div>
        </section>
      ) : null}

      {canAddUsers ? (
        <section className="set-block">
          <p className="kicker">People in {here}</p>
          <h3 className="set-h">Add users</h3>
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
        </section>
      ) : (
        <p>
          You are {seatLabel(seat || role)} in {here}. The owner adds people.
        </p>
      )}

      {joe ? (
        <section className="set-block">
          <p className="kicker">Skin captures</p>
          <h3 className="set-h">Catalog school</h3>
          <p>Only you see this. Capture logs unmatched CLI screens on this Mac. Jev can propose a catalog card for those screens. It does not Allow a write.</p>
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
                })
              }}
            >
              {skinJev ? 'On' : 'Off'}
            </button>
          </label>
          {skinJev && !jevReady ? (
            <p className="tiny">Jev needs Doppler TypeSafe on this Mac. New unmatched screens wait until the key is ready.</p>
          ) : null}
          {captures.length === 0 ? (
            <p className="tiny">No captures yet.</p>
          ) : (
            <ul className="looking">
              {captures.slice(0, 24).map((c) => (
                <li key={c.fingerprint + c.at}>
                  <span>
                    {c.cli} · {c.eventKind} · {c.matched ? c.catalogId : 'unmatched'}
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
        </section>
      ) : null}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
