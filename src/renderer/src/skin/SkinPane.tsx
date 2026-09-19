import { useState } from 'react'
import { queueSpec, specFromStreamEvent, userMessageSpec } from '../../../shared/skin/from-events'
import type { SkinSpec } from '../../../shared/skin/spec'
import type { AiKind } from '@shared/contracts'
import { cleanThink, stripAnsi, type FileHit } from '../ptyChat'
import { SkinCard } from './Registry'
import { SkinTerm } from './SkinTerm'
import type { RefObject, UIEventHandler } from 'react'

type Msg = { who: string; text: string; steps?: { title: string; status?: string }[] }

function protocolJunk(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^\{"(?:jsonrpc|method|id)"/.test(t) && t.length < 400 && !/\n/.test(t)) return true
  return false
}

function thinkIsLive(messages: Msg[], idx: number, busy: boolean): boolean {
  if (!busy) return false
  for (let j = idx + 1; j < messages.length; j++) {
    if (messages[j].who === 'brain' && messages[j].text) return false
    if (messages[j].who === 'think' && messages[j].text) return false
  }
  return true
}

export function SkinPane({
  tabId,
  cwd,
  kind,
  visible,
  restart,
  peel,
  messages,
  busy,
  waitLabel,
  waitSec,
  queue,
  permission,
  threadRef,
  onScroll,
  onPeel,
  onFiles,
  onAction
}: {
  tabId: string
  cwd: string
  kind: AiKind
  visible: boolean
  restart: number
  peel: boolean
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
  threadRef: RefObject<HTMLDivElement | null>
  onScroll: UIEventHandler<HTMLDivElement>
  onPeel: (open: boolean) => void
  onFiles: (hits: FileHit[], live: boolean) => void
  onAction: (id: string, spec: SkinSpec) => void
}) {
  const [openThink, setOpenThink] = useState<Record<string, boolean>>({})
  const specs: { spec: SkinSpec; thinkKey?: string; thinkLive?: boolean }[] = []
  messages.forEach((m, i) => {
    if (m.who === 'me' && m.text) specs.push({ spec: userMessageSpec(m.text) })
    else if (m.who === 'plan' && m.steps?.length) {
      const s = specFromStreamEvent({ kind: 'plan', steps: m.steps })
      if (s) specs.push({ spec: s })
    } else if (m.who === 'err' && m.text) {
      const s = specFromStreamEvent({ kind: 'error', data: m.text })
      if (s) specs.push({ spec: s })
    } else if (m.who === 'think') {
      const text = cleanThink(m.text || '')
      if (!text) return
      const s = specFromStreamEvent({ kind: 'thought', data: text })
      if (s) specs.push({ spec: s, thinkKey: 't-' + i, thinkLive: thinkIsLive(messages, i, busy) })
    } else if (m.who === 'sys' && m.text) {
      if (m.text.startsWith('Older turns were summarized')) {
        const s = specFromStreamEvent({ kind: 'status', data: 'compacted' })
        if (s) specs.push({ spec: s })
      } else {
        specs.push({
          spec: {
            id: 'sys-' + i,
            component: 'CompactNotice',
            props: { text: m.text },
            actions: [],
            source: 'sys'
          }
        })
      }
    } else if (m.text) {
      const text = stripAnsi(m.text)
      if (protocolJunk(text)) return
      const s = specFromStreamEvent({ kind: 'text', data: text })
      if (s) specs.push({ spec: s })
    }
  })
  if (permission) {
    const s = specFromStreamEvent({ kind: 'permission', ...permission })
    if (s) specs.push({ spec: s })
  }
  if (busy) {
    const s = specFromStreamEvent({ kind: 'status', data: 'work:' + (waitLabel || 'Working') })
    if (s) {
      s.props.seconds = waitSec
      specs.push({ spec: s })
    }
  }
  const q = queueSpec(queue)
  if (q) specs.push({ spec: q })
  specs.forEach((row, i) => {
    row.spec.id = 'row-' + i + '-' + row.spec.component
  })

  return (
    <div className={visible ? (peel ? 'skin-pane peel' : 'skin-pane') : 'skin-pane hide'}>
      <div className="skin-term">
        <SkinTerm
          key={`${tabId}:${cwd}:${kind}:${restart}`}
          id={tabId}
          cwd={cwd}
          kind={kind}
          visible={visible}
          interactive={visible && peel}
          onFiles={onFiles}
        />
      </div>
      <div className="skin-thread" ref={threadRef} onScroll={onScroll}>
        {specs.map((row) => {
          const thinkOpen = row.thinkKey ? (openThink[row.thinkKey] ?? Boolean(row.thinkLive)) : undefined
          return (
            <SkinCard
              key={row.spec.id}
              spec={row.spec}
              thinkOpen={thinkOpen}
              thinkLive={row.thinkLive}
              onThinkToggle={
                row.thinkKey
                  ? () =>
                      setOpenThink((m) => ({
                        ...m,
                        [row.thinkKey!]: !(m[row.thinkKey!] ?? row.thinkLive)
                      }))
                  : undefined
              }
              onAction={(id, s) => {
                if (id === 'openRaw') onPeel(true)
                else onAction(id, s)
              }}
            />
          )
        })}
      </div>
      <p className="tiny skin-cli">
        {kind} · skin on this chat
        <button type="button" className="linkish" onClick={() => onPeel(!peel)}>
          {peel ? 'Hide terminal' : 'Show terminal'}
        </button>
      </p>
    </div>
  )
}
