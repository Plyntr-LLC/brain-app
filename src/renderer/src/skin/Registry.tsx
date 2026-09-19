import { WorkPulse } from '../WorkPulse'
import type { SkinSpec } from '../../../shared/skin/spec'

function md(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br/>')
}

export function SkinCard({
  spec,
  onAction
}: {
  spec: SkinSpec
  onAction: (id: string, spec: SkinSpec) => void
}) {
  const p = spec.props
  if (spec.component === 'UserMessage') {
    return <div className="bubble me">{String(p.text || '')}</div>
  }
  if (spec.component === 'AgentMessage') {
    return (
      <div className="bubble md">
        <div className="mdbody" dangerouslySetInnerHTML={{ __html: md(String(p.text || '')) }} />
      </div>
    )
  }
  if (spec.component === 'Thought') {
    return (
      <div className="bubble think">
        <div className="think-label">Thinking</div>
        {String(p.text || '')}
      </div>
    )
  }
  if (spec.component === 'ToolCard') {
    return (
      <div className="skin-tool">
        <strong>{String(p.tool || 'file')}</strong>
        <span>{String(p.path || '')}</span>
      </div>
    )
  }
  if (spec.component === 'WorkPulse') {
    return <WorkPulse label={String(p.label || 'Working')} seconds={Number(p.seconds || 0) || undefined} />
  }
  if (spec.component === 'PermissionAsk') {
    return (
      <div className="skin-perm">
        <p className="skin-perm-title">{String(p.title || 'Allow this?')}</p>
        {p.path ? <p className="tiny">{String(p.path)}</p> : null}
        <div className="skin-perm-actions">
          {spec.actions.map((a) => (
            <button
              type="button"
              key={a.id}
              className={a.id === 'allowOnce' ? 'primary' : 'ghost'}
              onClick={() => onAction(a.id, spec)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (spec.component === 'CompactNotice') {
    return (
      <div className="bubble">
        <div className="think-label">Command</div>
        {p.phase === 'compacting' ? 'Compacting…' : 'Older turns were summarized. The thread on screen is unchanged.'}
      </div>
    )
  }
  if (spec.component === 'ErrorNotice' || spec.component === 'LoginNeed') {
    return (
      <div className="bubble">
        {String(p.text || '')}
        {spec.component === 'LoginNeed' ? (
          <div className="skin-perm-actions">
            <button type="button" className="primary" onClick={() => onAction('login', spec)}>
              Sign in
            </button>
          </div>
        ) : null}
      </div>
    )
  }
  if (spec.component === 'ContextMeter') {
    const pct = p.percent != null ? `${p.percent}%` : ''
    return <div className="tiny">Context {pct}</div>
  }
  if (spec.component === 'SlashMenu') {
    const cmds = Array.isArray(p.commands) ? (p.commands as { name: string; description?: string }[]) : []
    return (
      <div className="slashmenu on">
        {cmds.slice(0, 8).map((c) => (
          <button type="button" key={c.name} onClick={() => onAction('runSlash', { ...spec, props: { ...p, name: c.name } })}>
            /{c.name}
            <span>{c.description || ''}</span>
          </button>
        ))}
      </div>
    )
  }
  if (spec.component === 'Plan') {
    const steps = Array.isArray(p.steps) ? (p.steps as { title: string; status?: string }[]) : []
    return (
      <ol className="skin-plan">
        {steps.map((s, i) => (
          <li key={i}>
            {s.title} {s.status ? <span className="tiny">{s.status}</span> : null}
          </li>
        ))}
      </ol>
    )
  }
  if (spec.component === 'Queue') {
    const items = Array.isArray(p.items) ? (p.items as string[]) : []
    return (
      <div className="followq">
        <p className="tiny">Queued.</p>
        {items.map((t, i) => (
          <div className="followq-row" key={i}>
            <span>{t}</span>
          </div>
        ))}
      </div>
    )
  }
  if (spec.component === 'RawFallback') {
    return (
      <div className="skin-raw-card">
        <p>This screen is not in the catalog yet.</p>
        <button type="button" className="ghost" onClick={() => onAction('openRaw', spec)}>
          Open raw
        </button>
      </div>
    )
  }
  if (spec.component === 'Picker') {
    const options = Array.isArray(p.options) ? (p.options as { id: string; label: string }[]) : []
    return (
      <div className="runpick">
        {options.map((o) => (
          <button type="button" key={o.id} onClick={() => onAction('selectOption', { ...spec, props: { ...p, value: o.id } })}>
            {o.label}
          </button>
        ))}
      </div>
    )
  }
  return null
}
