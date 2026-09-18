import { useEffect, useState } from 'react'
import { copierPrompt, type BridgeDraft } from './BridgeWizard'

type Person = {
  name: string
  email: string
  role: 'owner' | 'scout' | 'team'
  brain: string
  client?: string
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
    projects: [{ id: 'project-1', name: '', people: '', address: '' }],
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

function folderName(path: string | null): string {
  if (!path) return ''
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function roleLine(role: Person['role']): string {
  if (role === 'owner') return 'Owner. Decides seats. Uses the HQ brain.'
  if (role === 'scout') return 'Scout. Builds skills. Uses the HQ brain.'
  return 'Team. Uses one project brain. Cannot change skills or house rules.'
}

export function SettingsPanel({
  role,
  onClose
}: {
  role?: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<'people' | 'brains'>('brains')
  const [superAdmin, setSuper] = useState(false)
  const [email, setEmail] = useState('')
  const [watching, setWatching] = useState(false)
  const [brainPath, setBrainPath] = useState<string | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [draft, setDraft] = useState<Person>({ name: '', email: '', role: 'team', brain: '' })
  const [clients, setClients] = useState<Client[]>([])
  const [cur, setCur] = useState(0)
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const plyntr = superAdmin || email === 'joe@plyntr.com'
  const teamSeat = role === 'team' || role === 'member'
  const ownerish = plyntr || !teamSeat

  useEffect(() => {
    void (async () => {
      const s = await window.brain.settings.get()
      setSuper(s.superAdmin)
      setEmail(s.email)
      setWatching(s.watching)
      setBrainPath(s.brainPath)
      setPeople(await window.brain.settings.team())
      const list = ((await window.brain.settings.clients()) as Record<string, unknown>[]).map(asClient)
      const next = list.length ? list : ownerish ? [blankClient()] : []
      setClients(next)
      setTab(teamSeat ? 'people' : 'brains')
      setLoaded(true)
    })()
  }, [])

  const client = clients[cur]
  const rosterClient = plyntr ? clients[cur] : clients[0]
  const companyKey = (rosterClient?.slug || slugify(rosterClient?.company || '')).trim()
  const projectOpts = (rosterClient?.projects || []).filter((p) => p.name.trim())
  const shownPeople = people.filter((p) => {
    if (!rosterClient) return false
    if (!p.client) return cur === 0
    return p.client === companyKey
  })

  useEffect(() => {
    const first = projectOpts[0]?.id || ''
    setDraft((d) => ({ ...d, brain: projectOpts.some((p) => p.id === d.brain) ? d.brain : first }))
  }, [cur, rosterClient?.slug, rosterClient?.projects.map((p) => p.id).join('|')])

  async function persistTeam(next: Person[]) {
    const saved = (await window.brain.settings.saveTeam(next)) as Person[]
    setPeople(saved)
    setNote('People saved on this computer. This does not email them or open GitHub.')
  }

  async function persistClients(next: Client[]) {
    const raw = await window.brain.settings.saveClients(next)
    const saved = Array.isArray(raw) ? raw.map((row) => asClient(row as Record<string, unknown>)) : next
    setClients(saved.length ? saved : [blankClient()])
    setNote('Brains saved on this computer. Create each repo in Agency Brain, then copy the copier prompt.')
  }

  function patchClient(patch: Partial<Client>) {
    const next = clients.slice()
    const i = plyntr ? cur : 0
    const row = next[i] || blankClient()
    next[i] = { ...row, ...patch }
    setClients(next)
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

  const seatLabel = plyntr ? 'Plyntr support' : teamSeat ? 'Team' : role === 'scout' ? 'Scout' : 'Owner'
  const companyReady = Boolean(rosterClient?.company.trim())
  const canAddTeam = draft.role !== 'team' || projectOpts.length > 0

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
        {seatLabel}
        {watching && brainPath ? ` · watching ${folderName(brainPath)}` : ' · Agency Brain is not watching a folder yet'}
      </p>

      <div className="set-how">
        <p>
          A <strong>brain</strong> is a shared folder. HQ is the one owners and scouts use. A project brain is a
          separate folder for one group, so they do not see HQ or the other groups. A <strong>person</strong> is
          someone you put on one of those folders.
        </p>
        <ol>
          <li>Brains tab: name the company, the HQ brain, then each project brain. Save.</li>
          <li>People tab: add each person. Owners and scouts use HQ. Team uses one project brain.</li>
          <li>Each person downloads Brain, installs Agency Brain, and watches the GitHub repo for their seat.</li>
        </ol>
        <p className="tiny">
          This list lives on this Mac. It does not email anyone, create GitHub, or rewrite Agency Brain config.
        </p>
      </div>

      {ownerish ? (
        <div className="set-tabs">
          <button type="button" className={tab === 'brains' ? 'on' : ''} onClick={() => setTab('brains')}>
            Brains
          </button>
          <button type="button" className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>
            People
          </button>
        </div>
      ) : null}

      {tab === 'brains' && ownerish && (
        <>
          <h3 className="set-h">Brains</h3>
          <p>
            HQ is for owners and scouts. Add a project brain for each group that must not see the other groups’ files.
          </p>
          {plyntr ? (
            <div className="set-row">
              <label className="field" style={{ margin: 0, flex: 1 }}>
                Which company
                <select value={String(cur)} onChange={(e) => setCur(Number(e.target.value))}>
                  {clients.map((c, i) => (
                    <option key={c.slug || i} value={i}>
                      {c.company || c.slug || `Company ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const next = [...clients, blankClient()]
                  setClients(next)
                  setCur(next.length - 1)
                  setNote('New company. Fill HQ and project brains, then Save.')
                }}
              >
                Add another company
              </button>
            </div>
          ) : null}

          {client ? (
            <>
              <label className="field">
                Company
                <input
                  value={client.company}
                  onChange={(e) => patchClient({ company: e.target.value })}
                  placeholder="Acme Ministries"
                />
              </label>
              <label className="field">
                Short id (lowercase). Leave blank to make one from the company name.
                <input
                  value={client.slug}
                  onChange={(e) => patchClient({ slug: e.target.value })}
                  placeholder={slugify(client.company) || 'acme'}
                />
              </label>
              <label className="field">
                HQ brain name
                <input
                  value={client.hqName}
                  onChange={(e) => patchClient({ hqName: e.target.value })}
                  placeholder={`${client.company.trim() || 'Acme'} HQ`}
                />
              </label>
              <label className="field">
                HQ GitHub (org/repo)
                <input
                  value={client.hqAddress}
                  onChange={(e) => patchClient({ hqAddress: e.target.value })}
                  placeholder="acme-hq/acme-hq-brain"
                />
              </label>
              <p className="tiny">
                Create that brain in Agency Brain first, then paste org/repo here.
              </p>
              <h3 className="set-h">Project brains</h3>
              <p className="tiny">
                One per team that must stay isolated. People on a project brain never get HQ. Paste each org/repo after
                you create it in Agency Brain.
              </p>
              {client.projects.map((p, i) => (
                <div className="bridge-project" key={p.id}>
                  <label className="field">
                    Project brain name
                    <input
                      value={p.name}
                      onChange={(e) => {
                        const projects = client.projects.slice()
                        projects[i] = { ...p, name: e.target.value }
                        patchClient({ projects })
                      }}
                      placeholder="Bible translation"
                    />
                  </label>
                  <label className="field">
                    Who is on it (not HQ)
                    <input
                      value={p.people}
                      onChange={(e) => {
                        const projects = client.projects.slice()
                        projects[i] = { ...p, people: e.target.value }
                        patchClient({ projects })
                      }}
                      placeholder="Maya, translation staff"
                    />
                  </label>
                  <label className="field">
                    GitHub (org/repo)
                    <input
                      value={p.address}
                      onChange={(e) => {
                        const projects = client.projects.slice()
                        projects[i] = { ...p, address: e.target.value }
                        patchClient({ projects })
                      }}
                      placeholder="acme-bible/acme-bible-brain"
                    />
                  </label>
                  {client.projects.length > 1 ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => patchClient({ projects: client.projects.filter((_, j) => j !== i) })}
                    >
                      Remove this project brain
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const used = new Set(client.projects.map((x) => x.id))
                  let n = client.projects.length + 1
                  let id = `project-${n}`
                  while (used.has(id)) {
                    n += 1
                    id = `project-${n}`
                  }
                  patchClient({
                    projects: [...client.projects, { id, name: '', people: '', address: '' }]
                  })
                }}
              >
                Add a project brain
              </button>
              <p className="tiny" style={{ marginTop: '0.8rem' }}>
                Sync between HQ and project brains still needs the copier. Copy the prompt, paste it into Grok in the
                brain-bridge folder, then paste the setup link it gives you.
              </p>
              <label className="field">
                Setup link (from the copier)
                <input
                  value={client.setupLink}
                  onChange={(e) => patchClient({ setupLink: e.target.value })}
                  placeholder="https://…/setup?token=…"
                />
              </label>
              <div className="actions" style={{ marginTop: 0, paddingTop: '0.6rem' }}>
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    const i = plyntr ? cur : 0
                    const row = clients[i]
                    if (!row?.company.trim()) {
                      setNote('Put a company name first.')
                      return
                    }
                    const next = clients.slice()
                    next[i] = {
                      ...row,
                      slug: row.slug.trim() || slugify(row.company),
                      hqName: row.hqName.trim() || `${row.company.trim()} HQ`
                    }
                    void persistClients(next)
                  }}
                >
                  Save brains
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={!client.company.trim()}
                  onClick={() => void navigator.clipboard.writeText(copierPrompt(draftFrom(client)))}
                >
                  Copy copier prompt
                </button>
              </div>
            </>
          ) : (
            <p className="tiny">Add a company on this tab before you add people.</p>
          )}

          {plyntr ? (
            <label className="need-row" style={{ marginTop: '1rem' }}>
              <input
                type="checkbox"
                checked={superAdmin}
                onChange={(e) => {
                  const on = e.target.checked
                  setSuper(on)
                  if (!on) setTab('people')
                  void window.brain.settings.setSuper(on)
                }}
              />
              <span>Plyntr support. Lets this Mac keep more than one company’s brains.</span>
            </label>
          ) : null}
        </>
      )}

      {tab === 'people' && ownerish && (
        <>
          <h3 className="set-h">People</h3>
          <p>
            Add someone here so you know who belongs on which brain. Then they install Brain and Agency Brain and watch
            their repo. Adding them here does not send an invite.
          </p>
          {!companyReady ? (
            <p className="note">Save the company on the Brains tab first, then come back to add people.</p>
          ) : (
            <p className="tiny">
              Adding to {rosterClient?.company}
              {plyntr ? '. Switch company on the Brains tab.' : '.'} Owners and scouts use HQ. Team uses one project
              brain.
            </p>
          )}
          {shownPeople.length === 0 && companyReady ? (
            <p className="tiny">No one listed for this company yet.</p>
          ) : null}
          {shownPeople.map((p) => {
            const proj = projectOpts.find((x) => x.id === p.brain)
            const seat = p.role === 'team' ? proj?.name || p.brain : 'HQ'
            return (
              <div className="set-row" key={`${p.client || ''}:${p.email}`}>
                <span>
                  {p.name} · {p.email}
                  <span className="tiny">
                    {' '}
                    · {p.role} · {seat}
                  </span>
                </span>
                <button
                  type="button"
                  className="linkish"
                  onClick={() =>
                    void persistTeam(
                      people.filter((x) => !(x.email === p.email && (x.client || '') === (p.client || '')))
                    )
                  }
                >
                  Remove
                </button>
              </div>
            )
          })}
          <div className="person-add">
            <label className="field">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Maya"
              />
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
              <select
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value as Person['role'] })}
              >
                <option value="team">Team</option>
                <option value="scout">Scout</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <p className="tiny">{roleLine(draft.role)}</p>
            {draft.role === 'team' ? (
              projectOpts.length ? (
                <label className="field">
                  Which project brain
                  <select value={draft.brain} onChange={(e) => setDraft({ ...draft, brain: e.target.value })}>
                    {projectOpts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="note">Add a named project brain on the Brains tab before you add a team person.</p>
              )
            ) : (
              <p className="tiny">They use HQ.</p>
            )}
            <button
              className="primary"
              type="button"
              disabled={!companyReady || !draft.name.trim() || !draft.email.includes('@') || !canAddTeam}
              onClick={() => {
                const clientId = companyKey
                const brain = draft.role === 'team' ? draft.brain || projectOpts[0]?.id || '' : 'hq'
                const row: Person = {
                  ...draft,
                  email: draft.email.trim().toLowerCase(),
                  brain,
                  client: clientId
                }
                const rest = people.filter((p) => !(p.email === row.email && (p.client || '') === clientId))
                void persistTeam([...rest, row])
                setDraft({ name: '', email: '', role: 'team', brain: projectOpts[0]?.id || '' })
              }}
            >
              Add this person
            </button>
          </div>
        </>
      )}

      {tab === 'people' && !ownerish && (
        <>
          <h3 className="set-h">People</h3>
          <p>You use this brain as team. The owner or scout changes who is here.</p>
          {shownPeople.map((p) => (
            <p className="tiny" key={p.email}>
              {p.name} · {p.role}
              {p.role === 'team' ? ` · ${p.brain}` : ' · HQ'}
            </p>
          ))}
        </>
      )}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
