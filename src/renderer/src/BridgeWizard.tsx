import { useEffect, useState } from 'react'

export type BridgeProject = { id: string; name: string; people: string; address: string }

export type BridgeDraft = {
  company: string
  slug: string
  hqName: string
  hqAddress: string
  role: 'owner' | 'scout' | 'team'
  brainKind: 'hq' | 'project'
  projects: BridgeProject[]
  setupLink: string
  creating: boolean
}

const SCREENS = ['who', 'name', 'projects', 'create', 'copier', 'connect', 'done'] as const
type Screen = (typeof SCREENS)[number]

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

function blank(): BridgeDraft {
  return {
    company: '',
    slug: '',
    hqName: '',
    hqAddress: '',
    role: 'owner',
    brainKind: 'hq',
    projects: [{ id: 'project-1', name: '', people: '', address: '' }],
    setupLink: '',
    creating: true
  }
}

export function copierPrompt(d: BridgeDraft): string {
  const slug = d.slug || slugify(d.company)
  const lines = [
    'Please set up Brain Bridge mappings on the Plyntr Railway service (project plyntr-brain-bridge) and give me the setup link.',
    '',
    `Client slug: ${slug}`,
    `HQ brain address (master): ${d.hqAddress}`,
    '',
    'Projects:'
  ]
  for (const p of d.projects) {
    lines.push(
      `- id: ${p.id} | folder on HQ: projects/${p.id} | project brain address: ${p.address} | name: ${p.name}`
    )
  }
  lines.push('')
  lines.push(`Write those rows into MAPPINGS_JSON with client = the slug. Do not print secrets. Then run: railway run node scripts/setup-link.js ${slug}`)
  lines.push('Work in ~/Projects/brain-bridge.')
  return lines.join('\n')
}

function uniqueProjectId(name: string, used: Set<string>): string {
  const base = slugify(name) || 'project'
  let id = base
  let n = 2
  while (used.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  used.add(id)
  return id
}

export function BridgeWizard({
  onCancel,
  onDone,
  watching
}: {
  onCancel: () => void
  onDone: (draft: BridgeDraft) => void
  watching: boolean
}) {
  const [screen, setScreen] = useState<Screen>('who')
  const [d, setD] = useState<BridgeDraft>(blank)
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.brain.bridge.load().then((saved) => {
      if (saved?.company) setD((prev) => ({ ...prev, ...saved }))
    }).catch(() => {})
  }, [])

  function patch(p: Partial<BridgeDraft>) {
    setErr('')
    setD((prev) => {
      const next = { ...prev, ...p }
      void window.brain.bridge.save(next)
      return next
    })
  }

  function next() {
    const i = SCREENS.indexOf(screen)
    if (i < SCREENS.length - 1) setScreen(SCREENS[i + 1])
  }

  function back() {
    const i = SCREENS.indexOf(screen)
    if (i <= 0) onCancel()
    else setScreen(SCREENS[i - 1])
  }

  const slug = d.slug || slugify(d.company)

  return (
    <>
      {screen === 'who' && (
        <>
          <p className="kicker">Brain Bridge</p>
          <h1>Who are you on this brain?</h1>
          <p>One HQ brain for owners and managers. One project brain per team that should not see the others.</p>
          <button type="button" className={`choice ${d.role === 'owner' ? 'on' : ''}`} onClick={() => patch({ role: 'owner', creating: true, brainKind: 'hq' })}>
            <h3>Owner</h3>
            <p>You decide who is a scout and who is on the team. You can set up HQ and project brains.</p>
          </button>
          <button type="button" className={`choice ${d.role === 'scout' ? 'on' : ''}`} onClick={() => patch({ role: 'scout', creating: true, brainKind: 'hq' })}>
            <h3>Scout</h3>
            <p>You build skills and set up brains. You cannot transfer ownership.</p>
          </button>
          <button type="button" className={`choice ${d.role === 'team' ? 'on' : ''}`} onClick={() => patch({ role: 'team', creating: false, brainKind: 'project' })}>
            <h3>Team</h3>
            <p>You use the brain. You cannot change skills or house rules.</p>
          </button>
          {err && <p className="note">{err}</p>}
          <div className="actions">
            <button
              className="primary"
              type="button"
              onClick={() => {
                if (d.role === 'team') {
                  void window.brain.bridge.save(d)
                  onDone(d)
                  return
                }
                next()
              }}
            >
              Continue
            </button>
            <button className="linkish" type="button" onClick={onCancel}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'name' && (
        <>
          <p className="kicker">This client</p>
          <h1>Name the HQ brain.</h1>
          <label className="field">
            Company
            <input value={d.company} onChange={(e) => patch({ company: e.target.value })} placeholder="Acme Ministries" />
          </label>
          <label className="field">
            Short id (lowercase). Leave blank to make one.
            <input value={d.slug} onChange={(e) => patch({ slug: e.target.value })} placeholder={slugify(d.company) || 'acme'} />
          </label>
          <label className="field">
            HQ brain name
            <input value={d.hqName} onChange={(e) => patch({ hqName: e.target.value })} placeholder="Acme HQ" />
          </label>
          {err && <p className="note">{err}</p>}
          <div className="actions">
            <button
              className="primary"
              type="button"
              disabled={!d.company.trim()}
              onClick={() => {
                patch({ slug: slug, hqName: d.hqName || `${d.company.trim()} HQ` })
                next()
              }}
            >
              Continue
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'projects' && (
        <>
          <p className="kicker">{d.company || 'This client'}</p>
          <h1>Which project brains?</h1>
          <p className="muted">Each team that must not see the other teams’ files gets its own brain.</p>
          {d.projects.map((p, i) => (
            <div className="bridge-project" key={p.id}>
              <label className="field">
                Project brain name
                <input
                  value={p.name}
                  onChange={(e) => {
                    const projects = d.projects.slice()
                    projects[i] = { ...p, name: e.target.value }
                    patch({ projects })
                  }}
                  placeholder="Bible translation"
                />
              </label>
              <label className="field">
                Who is on it (not HQ)
                <input
                  value={p.people}
                  onChange={(e) => {
                    const projects = d.projects.slice()
                    projects[i] = { ...p, people: e.target.value }
                    patch({ projects })
                  }}
                  placeholder="Maya, translation staff"
                />
              </label>
              {d.projects.length > 1 && (
                <button
                  className="linkish"
                  type="button"
                  onClick={() => patch({ projects: d.projects.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            className="ghost"
            type="button"
            onClick={() =>
              patch({
                projects: [
                  ...d.projects,
                  { id: uniqueProjectId(`project-${Date.now()}`, new Set(d.projects.map((x) => x.id))), name: '', people: '', address: '' }
                ]
              })
            }
          >
            Add another project brain
          </button>
          <div className="actions">
            <button
              className="primary"
              type="button"
              disabled={!d.projects.every((p) => p.name.trim())}
              onClick={() => {
                const used = new Set<string>()
                const projects = d.projects.map((p) => ({ ...p, id: uniqueProjectId(p.name, used) }))
                patch({ projects })
                next()
              }}
            >
              Continue
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'create' && (
        <>
          <p className="kicker">Create brains</p>
          <h1>Write the GitHub address for each brain.</h1>
          <p>Create each brain in Agency Brain (I have a code). New GitHub organisation per brain. Then paste the org/repo here.</p>
          <label className="field">
            HQ · {d.hqName || 'HQ'}
            <input
              value={d.hqAddress}
              onChange={(e) => patch({ hqAddress: e.target.value })}
              placeholder="acme-hq/acme-hq-brain"
            />
          </label>
          {d.projects.map((p, i) => (
            <label className="field" key={p.id}>
              Project · {p.name}
              <input
                value={p.address}
                onChange={(e) => {
                  const projects = d.projects.slice()
                  projects[i] = { ...p, address: e.target.value }
                  patch({ projects })
                }}
                placeholder="acme-bible/acme-bible-brain"
              />
            </label>
          ))}
          {err && <p className="note">{err}</p>}
          <div className="actions">
            <button
              className="primary"
              type="button"
              disabled={!d.hqAddress.includes('/') || d.projects.some((p) => !p.address.includes('/'))}
              onClick={next}
            >
              Continue
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'copier' && (
        <>
          <p className="kicker">Make them sync</p>
          <h1>Ask Grok to wire the copier.</h1>
          <p>Paste this into Grok in the brain-bridge folder. It does not edit Agency Brain config on this computer.</p>
          <label className="field">
            Prompt
            <textarea readOnly rows={8} value={copierPrompt(d)} />
          </label>
          <button
            className="ghost"
            type="button"
            onClick={() => void navigator.clipboard.writeText(copierPrompt(d))}
          >
            Copy prompt
          </button>
          <label className="field">
            Setup link Grok gives you
            <input
              value={d.setupLink}
              onChange={(e) => patch({ setupLink: e.target.value })}
              placeholder="https://…/setup?token=…"
            />
          </label>
          <div className="actions">
            <button className="primary" type="button" disabled={!/^https?:\/\//i.test(d.setupLink)} onClick={next}>
              Continue
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'connect' && (
        <>
          <p className="kicker">Make them sync</p>
          <h1>Connect each brain.</h1>
          <p>
            Open the setup link. For each brain, Connect, then <strong>Only select repositories</strong>, that one brain. Never All
            repositories. Then Turn on.
          </p>
          {d.setupLink ? (
            <p>
              <a
                href={d.setupLink}
                onClick={(e) => {
                  e.preventDefault()
                  void window.brain.bridge.openUrl(d.setupLink)
                }}
              >
                Open setup page
              </a>
            </p>
          ) : null}
          <p className="muted">HQ {d.hqAddress}. Projects: {d.projects.map((p) => p.address).join(', ')}.</p>
          <div className="actions">
            <button className="primary" type="button" onClick={next}>
              I connected them
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}

      {screen === 'done' && (
        <>
          <p className="kicker">Ready</p>
          <h1>You are in.</h1>
          <p>
            {d.role === 'team'
              ? 'You can use this brain. Skills and house rules stay with owners and scouts.'
              : `HQ is ${d.hqName || d.company}. Project brains stay isolated. Chat opens against the folder Agency Brain is watching.`}
          </p>
          <div className="actions">
            <button
              className="primary"
              type="button"
              onClick={() => {
                void window.brain.bridge.save(d)
                onDone(d)
              }}
            >
              {watching ? 'Open chat' : 'Continue'}
            </button>
            <button className="linkish" type="button" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}
    </>
  )
}
