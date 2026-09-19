import { useEffect, useState } from 'react'

type Person = {
  name: string
  email: string
  role: 'owner' | 'scout' | 'team'
  brain: string
  client?: string
  brains?: string[]
}
type Client = {
  company: string
  slug: string
  hqName: string
  hqAddress: string
  projects: { id: string; name: string; people: string; address: string }[]
  setupLink: string
}

function slugify(s: string): string {
  return (
    String(s || '')
      .toLowerCase()
      .trim()
      .replace(/[''`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'client'
  )
}

function blankClient(): Client {
  return {
    company: '',
    slug: '',
    hqName: '',
    hqAddress: '',
    projects: [],
    setupLink: ''
  }
}

function asClient(raw: Record<string, unknown>): Client {
  const rawProjects = Array.isArray(raw.projects) ? raw.projects : []
  const used = new Set<string>()
  const projects = rawProjects
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => {
      const row = p as Record<string, unknown>
      let id = String(row.id || '').trim() || `project-${i + 1}`
      while (used.has(id)) id = `${id}-2`
      used.add(id)
      return {
        id,
        name: String(row.name || ''),
        people: String(row.people || ''),
        address: String(row.address || '')
      }
    })
  return {
    company: String(raw.company || ''),
    slug: String(raw.slug || ''),
    hqName: String(raw.hqName || ''),
    hqAddress: String(raw.hqAddress || ''),
    projects,
    setupLink: String(raw.setupLink || '')
  }
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
  const [clients, setClients] = useState<Client[]>([])
  const [cur, setCur] = useState(0)
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [moreBrains, setMoreBrains] = useState(false)
  const joe = email === 'joe@plyntr.com'
  const teamSeat = (seat || role) === 'team' || (seat || role) === 'member'
  const canAddUsers = joe || !teamSeat

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
      setClients(((await window.brain.settings.clients()) as Record<string, unknown>[]).map(asClient))
      setLiveProjects(await window.brain.settings.projects().catch(() => []))
      setLoaded(true)
    })()
  }, [])

  const client = clients[cur]

  async function persistClients(next: Client[], msg?: string) {
    const keep = next.filter((c) => c.company.trim())
    const raw = await window.brain.settings.saveClients(keep)
    const saved = Array.isArray(raw) ? raw.map((row) => asClient(row as Record<string, unknown>)) : keep
    setClients(saved)
    if (cur >= saved.length) setCur(Math.max(0, saved.length - 1))
    setNote(msg || 'Saved.')
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

      {onLogout && email ? (
        <p>
          <button type="button" className="ghost" onClick={onLogout}>
            Log out
          </button>
          <span className="tiny"> Chats and this brain folder stay on this computer.</span>
        </p>
      ) : null}

      {canAddUsers ? (
        <section className="set-block">
          <p className="kicker">People in {here}</p>
          <h3 className="set-h">Add users</h3>
          <p>They sign in with this email and open this brain. Owners and scouts see HQ. Team gets the projects you tick.</p>
          {people.map((p) => {
            const ids = p.brains?.length ? p.brains : p.brain && p.brain !== 'hq' ? [p.brain] : []
            const names = ids.map((id) => liveProjects.find((x) => x.id === id)?.name || prettyName(id)).join(', ')
            const seatLine = p.role === 'team' ? names || 'team' : p.role
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
                <option value="team">Team</option>
                <option value="scout">Scout</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            {draft.role === 'team' ? (
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
                <p className="tiny">No project folders in this brain yet. They can still sign in to {here}.</p>
              )
            ) : (
              <p className="tiny">They use all of {here}.</p>
            )}
            <button
              className="primary"
              type="button"
              disabled={!draft.name.trim() || !draft.email.includes('@')}
              onClick={async () => {
                const brains = draft.role === 'team' ? draft.brains || [] : []
                const res = await window.brain.settings.addTeammate({
                  name: draft.name.trim(),
                  email: draft.email.trim().toLowerCase(),
                  role: draft.role,
                  brain: brains[0] || 'hq',
                  brains
                })
                const roster = await window.brain.settings.roster().catch(() => [])
                setPeople(roster.length ? roster : (res.people as Person[]))
                setNote(res.roster.ok ? `${draft.name} can sign in with that email.` : res.roster.detail)
                setDraft({ name: '', email: '', role: 'team', brain: '', brains: [] })
              }}
            >
              Add this person
            </button>
          </div>
        </section>
      ) : (
        <p>You are on the team in {here}. The owner adds people.</p>
      )}

      {joe && superAdmin ? (
        <section className="set-block">
          <p className="kicker">Superadmin</p>
          <h3 className="set-h">Other brains</h3>
          <p>Only you see this. Add a company or another brain here. Everyone else only sees the brain they are in.</p>
          {!moreBrains ? (
            <button className="ghost" type="button" onClick={() => setMoreBrains(true)}>
              Add another brain
            </button>
          ) : (
            <>
              {clients.map((c, i) => (
                <p className="tiny" key={c.slug || i}>
                  {c.company || 'Untitled'}
                </p>
              ))}
              <label className="field">
                Company name
                <input
                  value={client?.company || ''}
                  onChange={(e) => {
                    const next = clients.slice()
                    const row = next[cur] || blankClient()
                    next[cur] = { ...row, company: e.target.value }
                    setClients(next)
                  }}
                  placeholder="Acme"
                />
              </label>
              <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    const row = clients[cur] || blankClient()
                    if (!row.company.trim()) {
                      setNote('Type a company name.')
                      return
                    }
                    const next = clients.slice()
                    next[cur] = { ...row, slug: row.slug.trim() || slugify(row.company) }
                    void persistClients(next, `Saved ${row.company}.`)
                  }}
                >
                  Save
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setClients([...clients, blankClient()])
                    setCur(clients.length)
                  }}
                >
                  New company
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
