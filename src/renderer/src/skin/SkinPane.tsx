import { useState } from 'react'
import { specFromStreamEvent, userMessageSpec } from '../../../shared/skin/from-events'
import { isHiddenStreamKind } from '../../../shared/skin/hidden-kinds'
import { isSkinComponent } from '../../../shared/skin/catalog'
import type { SkinSpec } from '../../../shared/skin/spec'
import type { AiKind } from '@shared/contracts'
import { cleanThink, stripAnsi, type FileHit } from '../ptyChat'
import { SkinCard } from './Registry'
import { SkinTerm } from './SkinTerm'
import type { RefObject, UIEventHandler } from 'react'

type Msg = { who: string; text: string; steps?: { title: string; status?: string }[]; rawKind?: string; skinLabel?: string | null }

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

/** Hide tool-name noise in the pulse; keep Thinking / Writing / Compacting. */
function busyLabel(waitLabel: string, wantPower: boolean): string {
  const label = waitLabel || 'Working'
  if (wantPower) return label
  if (label === 'Thinking' || label === 'Writing' || label === 'Compacting') return label
  return 'Working'
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
  context,
  permission,
  threadRef,
  onScroll,
  onPeel,
  onFiles,
  onAction,
  showPower,
  wantPower,
  canPeel,
  cliName
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
  context?: { used?: number; total?: number; percent?: number }
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
  showPower: boolean
  wantPower: boolean
  canPeel: boolean
  cliName: string
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
      if (s) {
        specs.push({
          spec: s.component === 'LoginNeed' ? { ...s, props: { ...s.props, cliName } } : s
        })
      }
    } else if (m.who === 'raw') {
      if (m.skinLabel === 'ignore' || isHiddenStreamKind(m.rawKind || '')) return
      const ev = { kind: m.rawKind || 'unknown', data: m.text }
      if (!ev.kind || isHiddenStreamKind(ev.kind)) return
      let s = specFromStreamEvent(ev)
      if (m.skinLabel && isSkinComponent(m.skinLabel) && m.skinLabel !== 'RawFallback') {
        s = s
          ? { ...s, component: m.skinLabel, props: { ...s.props, text: m.text || s.props.data } }
          : {
              id: 'raw-' + i,
              component: m.skinLabel,
              props: { text: m.text },
              actions: [],
              source: m.rawKind || 'raw'
            }
      }
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
    const s = specFromStreamEvent({ kind: 'status', data: 'work:' + busyLabel(waitLabel, wantPower) })
    if (s) {
      s.props.seconds = waitSec
      specs.push({ spec: s })
    }
  }
  specs.forEach((row, i) => {
    row.spec.id = 'row-' + i + '-' + row.spec.component
  })

  const ctxSpec =
    context && (context.percent != null || context.used)
      ? specFromStreamEvent({
          kind: 'context',
          used: context.used,
          total: context.total,
          percent: context.percent
        })
      : null
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
      {(wantPower || peel || ctxSpec || canPeel) ? (
      <p className="tiny skin-cli">
        {wantPower || peel ? `${cliName} · this chat` : null}
        {ctxSpec && wantPower ? <SkinCard spec={ctxSpec} onAction={onAction} /> : null}
        {canPeel ? (
          <button type="button" className="linkish" onClick={() => onPeel(!peel)}>
            {peel ? 'Hide terminal' : 'Show terminal'}
          </button>
        ) : null}
      </p>
      ) : null}
    </div>
  )
}
