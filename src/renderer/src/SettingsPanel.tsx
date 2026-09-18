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

function roleLine(role: Person['role'], company: string): string {
  const who = company || 'this company'
  if (role === 'owner') return `Owner at ${who}. Decides seats. Uses the HQ brain.`
  if (role === 'scout') return `Scout at ${who}. Builds skills. Uses the HQ brain.`
  return `Team at ${who}. Uses one project brain. Cannot change skills or house rules.`
}

export function SettingsPanel({
  role,
  onClose
}: {
  role?: string
  onClose: () => void
}) {
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
  const [savedKeys, setSavedKeys] = useState<string[]>([])
  const [plyntrBrain, setPlyntrBrain] = useState(false)
  const [brainName, setBrainName] = useState('')
  const joe = email === 'joe@plyntr.com'
  const plyntr = joe && superAdmin
  const teamSeat = role === 'team' || role === 'member'
  const ownerish = joe || !teamSeat

  useEffect(() => {
    void (async () => {
      const s = await window.brain.settings.get()
      setSuper(s.superAdmin)
      setEmail(s.email)
      setWatching(s.watching)
      setBrainPath(s.brainPath)
      setPlyntrBrain(Boolean(s.plyntrBrain))
      setBrainName(String(s.brainName || ''))
      setPeople(await window.brain.settings.team())
      let list = ((await window.brain.settings.clients()) as Record<string, unknown>[]).map(asClient)
      const joeNow = String(s.email || '').toLowerCase() === 'joe@plyntr.com'
      if (s.plyntrBrain && joeNow && !list.some((c) => c.slug === 'plyntr' || c.company.toLowerCase() === 'plyntr')) {
        const row: Client = {
          company: 'Plyntr',
          slug: 'plyntr',
          hqName: 'Plyntr HQ',
          hqAddress: '',
          projects: [],
          setupLink: ''
        }
        list = [row, ...list]
        await window.brain.settings.saveClients(list)
      }
      setClients(list)
      const plyntrAt = list.findIndex((c) => c.slug === 'plyntr' || c.company.toLowerCase() === 'plyntr')
      if (s.plyntrBrain && plyntrAt >= 0) setCur(plyntrAt)
      setSavedKeys(list.map((c) => c.slug || slugify(c.company)).filter(Boolean))
      setLoaded(true)
    })()
  }, [])

  const client = clients[cur]
  const companyName = client?.company.trim() || ''
  const companyLabel = companyName || 'this new company'
  const companyKey = (client?.slug || slugify(companyName)).trim()
  const namedProjects = (client?.projects || []).filter((p) => p.name.trim())
  const shownPeople = people.filter((p) => {
    if (!client) return false
    if (!p.client) return cur === 0
    return p.client === companyKey
  })

  useEffect(() => {
    const first = namedProjects[0]?.id || ''
    setDraft((d) => ({ ...d, brain: namedProjects.some((p) => p.id === d.brain) ? d.brain : first }))
  }, [cur, client?.slug, namedProjects.map((p) => p.id).join('|')])

  async function persistTeam(next: Person[]) {
    const saved = (await window.brain.settings.saveTeam(next)) as Person[]
    setPeople(saved)
    setNote(`People for ${companyLabel} saved on this Mac. This does not email them.`)
  }

  async function persistClients(next: Client[], msg?: string) {
    const keep = next.filter(
      (c) => c.company.trim() || c.hqName.trim() || c.hqAddress.trim() || c.projects.some((p) => p.name.trim())
    )
    const raw = await window.brain.settings.saveClients(keep)
    const saved = Array.isArray(raw) ? raw.map((row) => asClient(row as Record<string, unknown>)) : keep
    setClients(saved)
    setSavedKeys(saved.map((c) => c.slug || slugify(c.company)).filter(Boolean))
    if (cur >= saved.length) setCur(Math.max(0, saved.length - 1))
    setNote(msg || `Saved ${companyLabel} on this Mac.`)
  }

  function patchClient(patch: Partial<Client>) {
    const next = clients.slice()
    if (!next[cur]) return
    next[cur] = { ...next[cur], ...patch }
    setClients(next)
  }

  function addCompany() {
    const next = [...clients, blankClient()]
    setClients(next)
    setCur(next.length - 1)
    setNote('Name this company in job 1, then Save company.')
  }

  async function saveCompany() {
    if (!client?.company.trim()) {
      setNote('Type the company name first.')
      return
    }
    const next = clients.slice()
    next[cur] = {
      ...client,
      slug: client.slug.trim() || slugify(client.company),
      hqName: client.hqName.trim() || `${client.company.trim()} HQ`
    }
    await persistClients(next, `Company saved: ${next[cur].company}. Next: add brains for that company.`)
  }

  async function saveBrains() {
    if (!client?.company.trim()) {
      setNote('Save the company name first.')
      return
    }
    const next = clients.slice()
    next[cur] = {
      ...client,
      slug: client.slug.trim() || slugify(client.company),
      hqName: client.hqName.trim() || `${client.company.trim()} HQ`
    }
    await persistClients(next, `Brains saved for ${next[cur].company}. Next: add people to that company.`)
  }

  function addProjectBrain() {
    if (!client) return
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
    setNote(`Adding a project brain under ${companyLabel}.`)
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

  const seatLabel = joe ? 'Superadmin' : teamSeat ? 'Team' : role === 'scout' ? 'Scout' : 'Owner'

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
      </p>

      {ownerish ? (
        <>
          <div className="set-now">
            <p className="set-now-k">{plyntrBrain ? 'You are in the Plyntr brain' : 'Chat'}</p>
            <p>
              {plyntrBrain
                ? `This computer is on ${brainName || 'Plyntr'}${brainPath ? ` (${folderName(brainPath)})` : ''}.`
                : watching && brainPath
                  ? `Talks in the folder Agency Brain is watching: ${folderName(brainPath)}.`
                  : 'Chat starts when Agency Brain is watching a folder.'}
            </p>
            {joe ? (
            <p className="set-now-k" style={{ marginTop: '0.7rem' }}>
              Companies you set up
            </p>
            ) : null}
            {!joe ? (
              <p className="tiny">The owner decides companies, brains, and people.</p>
            ) : clients.length === 0 ? (
              <p>
                Plyntr is this brain. Add another company only when you are setting up a client’s HQ and people.
              </p>
            ) : (
              <>
                <label className="field" style={{ marginBottom: 0 }}>
                  Company whose brains and people you are editing
                  <select value={String(cur)} onChange={(e) => setCur(Number(e.target.value))}>
                    {clients.map((c, i) => (
                      <option key={c.slug || `c-${i}`} value={i}>
                        {c.company.trim() || 'Untitled company (name it in job 1)'}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="tiny" style={{ marginTop: '0.45rem', marginBottom: 0 }}>
                  Jobs 2 and 3 apply to <strong>{companyLabel}</strong> only.
                </p>
              </>
            )}
          </div>

          <section className="set-block">
            <p className="kicker">Job 1 of 3 · Company</p>
            <h3 className="set-h">The business</h3>
            <p>The client or firm. Start here. Brains and people attach to this name.</p>
            {!client ? (
              <button className="primary" type="button" onClick={addCompany}>
                Add a company
              </button>
            ) : (
              <>
                <label className="field">
                  Company name
                  <input
                    value={client.company}
                    onChange={(e) => patchClient({ company: e.target.value })}
                    placeholder="Acme Ministries"
                  />
                </label>
                <label className="field">
                  Short id (optional)
                  <input
                    value={client.slug}
                    onChange={(e) => patchClient({ slug: e.target.value })}
                    placeholder={slugify(client.company) || 'acme'}
                  />
                </label>
                <div className="actions" style={{ marginTop: 0, paddingTop: 0 }}>
                  <button className="primary" type="button" onClick={() => void saveCompany()}>
                    Save company
                  </button>
                  <button className="ghost" type="button" onClick={addCompany}>
                    Add a company
                  </button>
                  {clients.length > 0 ? (
                    <button
                      className="linkish"
                      type="button"
                      onClick={() => {
                        const next = clients.filter((_, i) => i !== cur)
                        setClients(next)
                        setCur(0)
                        void persistClients(next, 'Removed that company from this Mac.')
                      }}
                    >
                      Remove this company from this Mac
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </section>

          {client ? (
            <>
              <section className="set-block">
                <p className="kicker">Job 2 of 3 · Brains for {companyLabel}</p>
                <h3 className="set-h">Folders this company uses</h3>
                <p>
                  HQ is the main brain for owners and scouts at {companyLabel}. A project brain is an extra folder for
                  one group at {companyLabel}, so they do not see HQ or the other groups. Create each repo in Agency
                  Brain, then paste org/repo here.
                </p>
                <label className="field">
                  HQ brain name
                  <input
                    value={client.hqName}
                    onChange={(e) => patchClient({ hqName: e.target.value })}
                    placeholder={`${companyName || 'Acme'} HQ`}
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
                {client.projects.map((p, i) => (
                  <div className="bridge-project" key={p.id}>
                    <p className="tiny">
                      Project brain {i + 1} at {companyLabel}
                    </p>
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
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => patchClient({ projects: client.projects.filter((_, j) => j !== i) })}
                    >
                      Remove this project brain from {companyLabel}
                    </button>
                  </div>
                ))}
                <div className="actions" style={{ marginTop: '0.5rem', paddingTop: 0 }}>
                  <button className="ghost" type="button" onClick={addProjectBrain}>
                    Add a project brain to {companyLabel}
                  </button>
                  <button className="primary" type="button" onClick={() => void saveBrains()}>
                    Save brains for {companyLabel}
                  </button>
                </div>
                <p className="tiny" style={{ marginTop: '0.8rem' }}>
                  To copy files between HQ and project brains, copy the copier prompt, paste it into Grok in the
                  brain-bridge folder, then paste the setup link it gives you.
                </p>
                <label className="field">
                  Setup link for {companyLabel}
                  <input
                    value={client.setupLink}
                    onChange={(e) => patchClient({ setupLink: e.target.value })}
                    placeholder="https://…/setup?token=…"
                  />
                </label>
                <button
                  className="ghost"
                  type="button"
                  disabled={!companyName}
                  onClick={() => void navigator.clipboard.writeText(copierPrompt(draftFrom(client)))}
                >
                  Copy copier prompt for {companyLabel}
                </button>
              </section>

              <section className="set-block">
                <p className="kicker">Job 3 of 3 · People at {companyLabel}</p>
                <h3 className="set-h">Who uses this company’s brains</h3>
                <p>
                  A person belongs to {companyLabel}. Owners and scouts use HQ. Team uses one project brain. Adding
                  them here does not email them. They still install Brain and watch their repo.
                </p>
                {!savedKeys.includes(companyKey) || !companyName ? (
                  <p className="note">Save the company in job 1 first. Then you can add people to {companyLabel}.</p>
                ) : null}
                {shownPeople.length === 0 && companyName ? (
                  <p className="tiny">No one listed at {companyLabel} yet.</p>
                ) : null}
                {shownPeople.map((p) => {
                  const proj = namedProjects.find((x) => x.id === p.brain)
                  const seat = p.role === 'team' ? proj?.name || p.brain : `${companyLabel} HQ`
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
                        Remove from {companyLabel}
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
                    Seat at {companyLabel}
                    <select
                      value={draft.role}
                      onChange={(e) => setDraft({ ...draft, role: e.target.value as Person['role'] })}
                    >
                      <option value="team">Team</option>
                      <option value="scout">Scout</option>
                      <option value="owner">Owner</option>
                    </select>
                  </label>
                  <p className="tiny">{roleLine(draft.role, companyLabel)}</p>
                  {draft.role === 'team' ? (
                    namedProjects.length ? (
                      <label className="field">
                        Which {companyLabel} project brain
                        <select value={draft.brain} onChange={(e) => setDraft({ ...draft, brain: e.target.value })}>
                          {namedProjects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="note">
                        Add a named project brain in job 2 for {companyLabel} before you add a team person.
                      </p>
                    )
                  ) : (
                    <p className="tiny">They use {companyLabel} HQ.</p>
                  )}
                  <button
                    className="primary"
                    type="button"
                    disabled={
                      !companyName ||
                      !savedKeys.includes(companyKey) ||
                      !draft.name.trim() ||
                      !draft.email.includes('@') ||
                      (draft.role === 'team' && !namedProjects.length)
                    }
                    onClick={() => {
                      const row: Person = {
                        ...draft,
                        email: draft.email.trim().toLowerCase(),
                        brain: draft.role === 'team' ? draft.brain || namedProjects[0]?.id || '' : 'hq',
                        client: companyKey
                      }
                      const rest = people.filter((p) => !(p.email === row.email && (p.client || '') === companyKey))
                      void persistTeam([...rest, row])
                      setDraft({ name: '', email: '', role: 'team', brain: namedProjects[0]?.id || '' })
                    }}
                  >
                    Add this person to {companyLabel}
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {joe ? (
            <label className="need-row" style={{ marginTop: '1rem' }}>
              <input
                type="checkbox"
                checked={superAdmin}
                onChange={(e) => {
                  const on = e.target.checked
                  setSuper(on)
                  void window.brain.settings.setSuper(on)
                }}
              />
              <span>You are Plyntr superadmin on this Mac. Lets you keep more than one company’s brains here. Team members never see this.</span>
            </label>
          ) : null}
        </>
      ) : (
        <>
          <div className="set-now">
            <p className="set-now-k">{plyntrBrain ? 'You are in the Plyntr brain' : 'Chat'}</p>
            <p>
              {plyntrBrain
                ? `This computer is on ${brainName || 'Plyntr'}.`
                : watching && brainPath
                  ? `Folder: ${folderName(brainPath)}.`
                  : 'Chat starts when Agency Brain is watching a folder.'}
            </p>
          </div>
          <p>You use this brain as team. The owner decides who is here.</p>
        </>
      )}

      {note ? <p className="tiny">{note}</p> : null}
    </div>
  )
}
