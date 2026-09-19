import { queueSpec, specFromStreamEvent, userMessageSpec } from '../../../shared/skin/from-events'
import type { SkinSpec } from '../../../shared/skin/spec'
import { SkinCard } from './Registry'
import { RawDrawer } from './RawDrawer'

type Msg = { who: string; text: string }

export function SkinPane({
  tabId,
  cwd,
  kind,
  messages,
  busy,
  waitLabel,
  waitSec,
  queue,
  permission,
  rawOpen,
  onRaw,
  onAction
}: {
  tabId: string
  cwd: string
  kind: string
  messages: Msg[]
  busy: boolean
  waitLabel: string
  waitSec: number
  queue: { text: string }[]
  permission: {
    title?: string
    path?: string
    options?: { id: string; label: string }[]
    requestId?: string
  } | null
  rawOpen: boolean
  onRaw: (open: boolean) => void
  onAction: (id: string, spec: SkinSpec) => void
}) {
  const specs: SkinSpec[] = []
  for (const m of messages) {
    if (m.who === 'me' && m.text) specs.push(userMessageSpec(m.text))
    else if (m.who === 'think' && m.text) {
      const s = specFromStreamEvent({ kind: 'thought', data: m.text })
      if (s) specs.push(s)
    } else if (m.who === 'sys' && m.text) {
      const s = specFromStreamEvent({ kind: 'status', data: 'compacted' })
      if (s) specs.push(s)
    } else if (m.text) {
      const s = specFromStreamEvent({ kind: 'text', data: m.text })
      if (s) specs.push(s)
    }
  }
  if (permission) {
    const s = specFromStreamEvent({ kind: 'permission', ...permission })
    if (s) specs.push(s)
  }
  if (busy) {
    const s = specFromStreamEvent({ kind: 'status', data: 'work:' + (waitLabel || 'Working') })
    if (s) {
      s.props.seconds = waitSec
      specs.push(s)
    }
  }
  const q = queueSpec(queue)
  if (q) specs.push(q)
  specs.forEach((s, i) => {
    s.id = 'row-' + i + '-' + s.component
  })

  return (
    <div className="skin-pane">
      <div className="skin-thread">
        {specs.map((spec) => (
          <SkinCard
            key={spec.id}
            spec={spec}
            onAction={(id, s) => {
              if (id === 'openRaw') onRaw(true)
              else onAction(id, s)
            }}
          />
        ))}
      </div>
      <RawDrawer id={tabId} cwd={cwd} open={rawOpen} onHide={() => onRaw(false)} />
      <p className="tiny skin-cli">{kind} · catalog view · same session as Chat</p>
    </div>
  )
}
