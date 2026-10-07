import { useState, type ReactNode } from 'react'
import { specFromStreamEvent, userMessageSpec } from '../../../shared/skin/from-events'
import { isHiddenStreamKind, isProtocolNoise } from '../../../shared/skin/hidden-kinds'
import { isSkinComponent } from '../../../shared/skin/catalog'
import type { SkinSpec } from '../../../shared/skin/spec'
import type { Paste } from '../../../shared/saved-msg'
import type { AiKind } from '@shared/contracts'
import { paintsThreadSpec } from '../../../shared/think-run'
import { skinActivity, type SkinBgTask } from '../../../shared/agent-label'
import { cleanThink, stripAnsi, type FileHit } from '../ptyChat'
import { SkinCard } from './Registry'
import { activityLabel, cliLetter, isActivityComponent, type ActivityPart } from './turn'
import { SkinTerm } from './SkinTerm'
import type { RefObject, UIEventHandler } from 'react'

type Msg = {
  who: string
  text: string
  steps?: { title: string; status?: string }[]
  rawKind?: string
  skinLabel?: string | null
  pastes?: Paste[]
  at?: number
  end?: number
  path?: string
  tool?: string
  live?: boolean
}
type Row = { spec: SkinSpec; thinkKey?: string; thinkLive?: boolean }

function protocolJunk(text: string): boolean {
  return isProtocolNoise(text)
}

function activityParts(rows: Row[]): ActivityPart[] {
  return rows.map((row) =>
    row.spec.component === 'ToolCard'
      ? { kind: 'file' }
      : {
          kind: 'thought',
          at: Number(row.spec.props.at) || undefined,
          end: Number(row.spec.props.end) || undefined,
          live: row.thinkLive
        }
  )
}

/** One closed row. Open it to see the thinking and the file chips, in the order they happened. */
function ActivityFold({
  parts,
  open,
  onToggle,
  card
}: {
  parts: Row[]
  open: boolean
  onToggle: () => void
  card: (row: Row) => ReactNode
}) {
  const blocks: ReactNode[] = []
  let chips: Row[] = []
  const flush = () => {
    if (!chips.length) return
    const batch = chips
    chips = []
    blocks.push(
      <div className="skin-chips" key={batch[0].spec.id}>
        {batch.map(card)}
      </div>
    )
  }
  if (open) {
    for (const row of parts) {
      if (row.spec.component === 'ToolCard') chips.push(row)
      else {
        flush()
        blocks.push(card(row))
      }
    }
    flush()
  }
  return (
    <div className="skin-activity">
      <button type="button" className="think-label" aria-expanded={open} onClick={onToggle}>
        {activityLabel(activityParts(parts), open)}
      </button>
      {open ? blocks : null}
    </div>
  )
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
  bgTasks,
  bgNow,
  context,
  permission,
  threadRef,
  onScroll,
  onPeel: _onPeel,
  onFiles,
  onAction,
  showPower,
  wantPower,
  canPeel: _canPeel,
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
  bgTasks: SkinBgTask[]
  bgNow: number
  context?: { used?: number; total?: number; percent?: number }
  permission: {
    title?: string
    path?: string
    detail?: string
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
  const specs: Row[] = []
  messages.forEach((m, i) => {
    if (m.who === 'me' && m.text) specs.push({ spec: userMessageSpec(m.text, m.pastes) })
    else if (m.who === 'tool' && m.path) {
      const s = specFromStreamEvent({ kind: 'file', path: m.path, tool: m.tool })
      if (s) specs.push({ spec: { ...s, props: { ...s.props, live: Boolean(m.live) } } })
    }    else if (m.who === 'plan' && m.steps?.length) {
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
      if (s && paintsThreadSpec(s.component, String(s.props.text || s.props.data || ''))) specs.push({ spec: s })
    } else if (m.who === 'think') {
      const text = cleanThink(m.text || '')
      if (!text) return
      let prevAt = -1
      for (let j = specs.length - 1; j >= 0; j--) {
        if (specs[j].spec.component === 'Thought') {
          prevAt = j
          break
        }
        if (specs[j].spec.component === 'ToolCard') break
        if (paintsThreadSpec(specs[j].spec.component, String(specs[j].spec.props.text || specs[j].spec.props.data || ''))) break
      }
      if (prevAt >= 0) {
        const prev = specs[prevAt]
        const prior = String(prev.spec.props.text || '')
        specs[prevAt] = {
          ...prev,
          thinkLive: thinkIsLive(messages, i, busy),
          spec: {
            ...prev.spec,
            props: { ...prev.spec.props, text: prior ? prior + '\n\n' + text : text, end: m.end ?? m.at ?? prev.spec.props.end }
          }
        }
        return
      }
      const s = specFromStreamEvent({ kind: 'thought', data: text })
      if (s) specs.push({ spec: { ...s, props: { ...s.props, at: m.at, end: m.end } }, thinkKey: 't-' + i, thinkLive: thinkIsLive(messages, i, busy) })
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
  const activity = skinActivity({ busy, waitLabel, waitSec, bgTasks, now: bgNow })
  if (activity.show) {
    const s = specFromStreamEvent({ kind: 'status', data: 'work:' + activity.label })
    if (s) {
      s.props.seconds = activity.seconds
      specs.push({ spec: s })
    }
  }
  specs.forEach((row, i) => {
    row.spec.id = 'row-' + i + '-' + row.spec.component
  })
  // Everything after one of your messages is one agent turn. The first row carries the avatar.
  // A run of thinking and file chips is one closed row. A reply, a question, or a plan starts the next.
  const turns: { key: string; user?: Row; card?: Row; activity?: Row[]; avatar: boolean }[] = []
  let afterUser = false
  for (const row of specs) {
    if (row.spec.component === 'UserMessage') {
      turns.push({ key: row.spec.id, user: row, avatar: false })
      afterUser = true
      continue
    }
    const last = turns[turns.length - 1]
    if (isActivityComponent(row.spec.component) && last?.activity) {
      last.activity.push(row)
      continue
    }
    turns.push({
      key: row.spec.id,
      ...(isActivityComponent(row.spec.component) ? { activity: [row] } : { card: row }),
      avatar: afterUser
    })
    afterUser = false
  }
  const card = (row: Row, forceThink?: boolean) => {
    const thinkOpen = forceThink ? true : row.thinkKey ? (openThink[row.thinkKey] ?? false) : undefined
    return (
      <SkinCard
        key={row.spec.id}
        spec={row.spec}
        thinkOpen={thinkOpen}
        thinkLive={row.thinkLive}
        onThinkToggle={
          !forceThink && row.thinkKey
            ? () => setOpenThink((m) => ({ ...m, [row.thinkKey!]: !(m[row.thinkKey!] ?? false) }))
            : undefined
        }
        onAction={onAction}
      />
    )
  }

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
        {turns.map((t) =>
          t.user ? (
            card(t.user)
          ) : (
            <div key={t.key} className="skin-row">
              <span className="skin-gutter">{t.avatar ? <span className="who w-lead skin-avatar">{cliLetter(kind)}</span> : null}</span>
              <div className="skin-row-body">
                {t.activity ? (
                  <ActivityFold
                    parts={t.activity}
                    open={openThink[t.key] ?? false}
                    onToggle={() => setOpenThink((m) => ({ ...m, [t.key]: !(m[t.key] ?? false) }))}
                    card={(row) => card(row, row.spec.component === 'Thought')}
                  />
                ) : (
                  card(t.card!)
                )}
              </div>
            </div>
          )
        )}
      </div>
      {(wantPower || peel || ctxSpec) ? (
      <p className="tiny skin-cli">
        {wantPower || peel ? `${cliName} · this chat` : null}
        {ctxSpec && wantPower ? <SkinCard spec={ctxSpec} onAction={onAction} /> : null}
      </p>
      ) : null}
    </div>
  )
}
