import { useLayoutEffect, useRef } from 'react'
import { WorkPulse } from '../WorkPulse'
import { cleanThink, mdToHtml, stripAnsi } from '../ptyChat'
import type { SkinSpec } from '../../../shared/skin/spec'

function ThoughtBody({ html, follow }: { html: string; follow: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const pin = useRef(true)
  useLayoutEffect(() => {
    if (!follow) return
    const el = box.current
    if (!el || !pin.current) return
    el.scrollTop = el.scrollHeight
  }, [html, follow])
  return (
    <div
      className="mdbody think-body"
      ref={box}
      onScroll={() => {
        const el = box.current
        if (!el) return
        pin.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function fileBase(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
}

export function SkinCard({
  spec,
  onAction,
  thinkOpen,
  thinkLive,
  onThinkToggle
}: {
  spec: SkinSpec
  onAction: (id: string, spec: SkinSpec) => void
  thinkOpen?: boolean
  thinkLive?: boolean
  onThinkToggle?: () => void
}) {
  const p = spec.props
  if (spec.component === 'UserMessage') {
    return <div className="bubble me">{String(p.text || '')}</div>
  }
  if (spec.component === 'AgentMessage') {
    const text = stripAnsi(String(p.text || '')).trim()
    if (!text) return null
    return (
      <div className="bubble md">
        <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />
      </div>
    )
  }
  if (spec.component === 'Thought') {
    const text = cleanThink(String(p.text || ''))
    if (!text) return null
    const open = thinkOpen === true
    return (
      <div className="bubble think">
        <button type="button" className="think-label" onClick={onThinkToggle} disabled={!onThinkToggle}>
          Thinking{open ? '' : ' · show'}
        </button>
        {open ? <ThoughtBody html={mdToHtml(text)} follow={thinkLive === true} /> : null}
      </div>
    )
  }
  if (spec.component === 'ToolCard') {
    const path = String(p.path || '')
    const live = Boolean(p.live)
    return (
      <div className={`skin-tool${live ? ' live' : ''}`}>
        <span className="k">{String(p.tool || 'file')}</span>
        <span className="p">{fileBase(path)}</span>
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
    const text =
      typeof p.text === 'string' && p.text
        ? p.text
        : p.phase === 'compacting'
          ? 'Compacting…'
          : 'Older turns were summarized. The thread on screen is unchanged.'
    return (
      <div className="bubble">
        <div className="think-label">Command</div>
        {text}
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
          Show terminal
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
