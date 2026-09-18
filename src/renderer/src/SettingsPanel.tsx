import { useEffect, useState } from 'react'
import { copierPrompt, type BridgeDraft } from './BridgeWizard'

type Person = { name: string; email: string; role: 'owner' | 'scout' | 'team'; brain: string }
type Client = {
  company: string
  slug: string
  hqName: string
  hqAddress: string
  projects: { id: string; name: string; people: string; address: string }[]
  setupLink: string
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
    projects: projects.length ? projects : [{ id: 'project-1', name: '', people: '', address: '' }],
    setupLink: String(raw.setupLink || '')
  }
}

function draftFrom(c: Client): BridgeDraft {
  return {
    company: c.company,
    slug: c.slug,
    hqName: c.hqName,
    hqAddress: c.hqAddress,
    role: 'owner',
    brainKind: 'hq',
    projects: c.projects.length ? c.projects : [{ id: 'project-1', name: '', people: '', address: '' }],
    setupLink: c.setupLink,
    creating: true
  }
}

export function SettingsPanel({
  role,
  onClose
}: {
  role?: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'team' | 'clients'>('team')
  const [superAdmin, setSuper] = useState(false)
  const [email, setEmail] = useState('')
  const [people, setPeople] = useState<Person[]>([])
  const [draft, setDraft] = useState<Person>({ name: '', email: '', role: 'team', brain: 'hq' })
  const [clients, setClients] = useState<Client[]>([])
  const [cur, setCur] = useState(0)
  const [note, setNote] = useState('')
  const plyntr = superAdmin || email === 'joe@plyntr.com'
  const teamSeat = role === 'team' || role === 'member'
  const ownerish = plyntr || !teamSeat

  useEffect(() => {
    void (async () => {
      const s = await window.brain.settings.get()
      setSuper(s.superAdmin)
      setEmail(s.email)
      setPeople(await window.brain.settings.team())
      const list = (await window.brain.settings.clients()) as Record<string, unknown>[]
      setClients(list.map(asClient))
    })()
  }, [])

  const client = clients[cur]
  const rosterClient = plyntr ? clients[cur] : clients[0]
  const projectOpts = (rosterClient?.projects || []).map((p) => ({ id: p.id, name: p.name || p.id }))

  useEffect(() => {
    const ids = projectOpts.map((p) => p.id)
    const first = ids[0] || 'hq'
    setDraft((d) => ({ ...d, brain: ids.includes(d.brain) ? d.brain : first }))
  }, [cur, rosterClient?.slug])

  async function persistTeam(next: Person[]) {
    const saved = (await window.brain.settings.saveTeam(next)) as Person[]
    setPeople(saved)
    setNote('Team saved on this computer.')
  }

  async function persistClients(next: Client[]) {
    const raw = await window.brain.settings.saveClients(next)
    const saved = Array.isArray(raw) ? raw.map((row) => asClient(row as Record<string, unknown>)) : next
    setClients(saved)
    setNote('Client brains saved on this computer. Railway still needs the copier prompt.')
  }

  return (
    <div className="settings">
      <div className="invitehead">
        <strong>Settings</strong>
        <button type="button" className="tabx" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="tiny">
        {email ? `${email} · ` : ''}
        {plyntr ? 'Plyntr support' : teamSeat ? 'Team' : role === 'scout' ? 'Scout' : 'Owner'}
      </p>
      <div className="set-tabs">
        {ownerish ? (
          <button type="button" className={tab === 'team' ? 'on' : ''} onClick={() => setTab('team')}>
            Team
          </button>
        ) : null}
        {plyntr ? (
          <button type="button" className={tab === 'clients' ? 'on' : ''} onClick={() => setTab('clients')}>
            Client brains
          </button>
        ) : null}
      </div>

      {tab === 'team' && ownerish && (
        <>
          <p>Who is on this brain. Team people get one project. Owners and scouts use HQ.</p>
          {people.length === 0 ? <p className="tiny">No one listed yet.</p> : null}
          {people.map((p) => (
            <div className="set-row" key={p.email}>
              <span>
                {p.name} · {p.email} · {p.role}
                {p.role === 'team' ? ` · ${p.brain}` : ' · HQ'}
              </span>
              <button
                type="button"
                className="linkish"
                onClick={() => void persistTeam(people.filter((x) => x.email !== p.email))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="inviterow">
            <input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input placeholder="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            <select
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value as Person['role'] })}
            >
              <option value="team">Team</option>
              <option value="scout">Scout</option>
              <option value="owner">Owner</option>
            </select>
            {draft.role === 'team' ? (
              <select value={draft.brain} onChange={(e) => setDraft({ ...draft, brain: e.target.value })}>
                {projectOpts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              className="ghost"
              type="button"
              onClick={() => {
                if (!draft.name.trim() || !draft.email.includes('@')) return
                const brain = draft.role === 'team' ? draft.brain || projectOpts[0]?.id || 'hq' : 'hq'
                void persistTeam([...people.filter((p) => p.email !== draft.email.toLowerCase()), { ...draft, email: draft.email.toLowerCase(), brain }])
                setDraft({ name: '', email: '', role: 'team', brain: projectOpts[0]?.id || 'hq' })
              }}
            >
              Add
            </button>
          </div>
          <p className="tiny">
            They download Brain, install Agency Brain, and watch the repo for their seat. Team watches the project brain, not HQ.
          </p>
        </>
      )}

      {tab === 'team' && !ownerish && (
        <>
          <p>You use this brain as team. Owners and scouts change the roster.</p>
          {people.map((p) => (
            <p className="tiny" key={p.email}>
              {p.name} · {p.role}
              {p.role === 'team' ? ` · ${p.brain}` : ''}
            </p>
          ))}
        </>
      )}

      {tab === 'clients' && plyntr && (
        <>
          <p>HQ and project brains for a client. This computer stores the plan. The copier still runs in brain-bridge.</p>
          <div className="set-row">
            <select value={String(cur)} onChange={(e) => setCur(Number(e.target.value))}>
              {clients.map((c, i) => (
                <option key={c.slug || i} value={i}>
                  {c.company || c.slug || `Client ${i + 1}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const next = [
                  ...clients,
                  {
                    company: '',
                    slug: '',
                    hqName: '',
                    hqAddress: '',
                    projects: [{ id: 'project-1', name: '', people: '', address: '' }],
                    setupLink: ''
                  }
                ]
                setClients(next)
                setCur(next.length - 1)
              }}
            >
              New client
            </button>
          </div>
          {client ? (
            <>
              <label className="field">
                Company
                <input
                  value={client.company}
                  onChange={(e) => {
                    const next = clients.slice()
                    next[cur] = { ...client, company: e.target.value }
                    setClients(next)
                  }}
                />
              </label>
              <label className="field">
                Short id
                <input
                  value={client.slug}
                  onChange={(e) => {
                    const next = clients.slice()
                    next[cur] = { ...client, slug: e.target.value }
                    setClients(next)
                  }}
                />
              </label>
              <label className="field">
                HQ name
                <input
                  value={client.hqName}
                  onChange={(e) => {
                    const next = clients.slice()
                    next[cur] = { ...client, hqName: e.target.value }
                    setClients(next)
                  }}
                />
              </label>
              <label className="field">
                HQ GitHub (org/repo)
                <input
                  value={client.hqAddress}
                  onChange={(e) => {
                    const next = clients.slice()
                    next[cur] = { ...client, hqAddress: e.target.value }
                    setClients(next)
                  }}
                />
              </label>
              {client.projects.map((p, i) => (
                <div className="bridge-project" key={p.id + i}>
                  <label className="field">
                    Project name
                    <input
                      value={p.name}
                      onChange={(e) => {
                        const projects = client.projects.slice()
                        projects[i] = { ...p, name: e.target.value }
                        const next = clients.slice()
                        next[cur] = { ...client, projects }
                        setClients(next)
                      }}
                    />
                  </label>
                  <label className="field">
                    GitHub (org/repo)
                    <input
                      value={p.address}
                      onChange={(e) => {
                        const projects = client.projects.slice()
                        projects[i] = { ...p, address: e.target.value }
                        const next = clients.slice()
                        next[cur] = { ...client, projects }
                        setClients(next)
                      }}
                    />
                  </label>
                  {client.projects.length > 1 ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        const next = clients.slice()
                        next[cur] = { ...client, projects: client.projects.filter((_, j) => j !== i) }
                        setClients(next)
                      }}
                    >
                      Remove project
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const used = new Set(client.projects.map((p) => p.id))
                  let n = client.projects.length + 1
                  let id = `project-${n}`
                  while (used.has(id)) {
                    n += 1
                    id = `project-${n}`
                  }
                  const next = clients.slice()
                  next[cur] = {
                    ...client,
                    projects: [...client.projects, { id, name: '', people: '', address: '' }]
                  }
                  setClients(next)
                }}
              >
                Add project brain
              </button>
              <label className="field">
                Setup link
                <input
                  value={client.setupLink}
                  onChange={(e) => {
                    const next = clients.slice()
                    next[cur] = { ...client, setupLink: e.target.value }
                    setClients(next)
                  }}
                />
              </label>
              <div className="actions">
                <button className="ghost" type="button" onClick={() => void persistClients(clients)}>
                  Save
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(copierPrompt(draftFrom(client)))}
                >
                  Copy copier prompt
                </button>
              </div>
            </>
          ) : (
            <p className="tiny">Add a client to store HQ and project brains.</p>
          )}
        </>
      )}

      {plyntr ? (
        <label className="need-row" style={{ marginTop: '1rem' }}>
          <input
            type="checkbox"
            checked={superAdmin}
            onChange={(e) => {
              const on = e.target.checked
              setSuper(on)
              if (!on) setTab('team')
              void window.brain.settings.setSuper(on)
            }}
          />
          <span>Plyntr support (super admin). Client brains tab.</span>
        </label>
      ) : null}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
