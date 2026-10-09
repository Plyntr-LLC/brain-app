import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AiKind, Session } from '@shared/contracts'
import { CLAUDE_DEFAULT_MODEL, keepClaudeModel } from '../../shared/claude-defaults'
import { defaultEffort, hydrateEffort, normalizeEffort, prettyEffort } from '../../shared/effort'
import { mdToHtml, tidy, outsideProject, rel, type FileHit } from './ptyChat'
import { AwayBlock } from './AwayBlock'
import { ActivityRail } from './ActivityRail'
import { SessionCard, type SessionRow } from './SessionCard'
import { railFor, type Activity } from './activity'
import { bgLine, chatActivity, fileAction, mergePlanSteps, nextAction, type ActionState } from './chat-activity'
import { sameCwd } from '../../shared/paths'
import { APP_SLASH, TUI_ONLY_SLASH } from '../../shared/slash-lanes'
import { routeLine } from '../../shared/slash-route'
import { panelBlocks } from '../../shared/panel-blocks'
import { WorkPulse } from './WorkPulse'
import { FactoryPane } from './FactoryPane'
import { DeskPane } from './DeskPane'
import type { DeskCli } from '@shared/desk'
import { MediaLibraryPane } from './MediaLibraryPane'
import type { MediaLibraryFile } from '../../shared/media'
import { SkinPane } from './skin/SkinPane'
import { SkinCard } from './skin/Registry'
import { skinPtyId } from './skin/SkinTerm'
import { specFromStreamEvent } from '../../shared/skin/from-events'
import { isHiddenStreamKind, isProtocolNoise } from '../../shared/skin/hidden-kinds'
import { isSkinComponent } from '../../shared/skin/catalog'
import { appendThought, collapseAdjacentThinks, paintsThreadSpec } from '../../shared/think-run'
import { CHAT_RULES } from '../../shared/chat-reach'
import { pageAfterSend } from '@shared/page-picture'
import { ChatPageTurn } from './ChatPageTurn'
import { usePageFollow } from './pin-thread'
import type { Paste } from '../../shared/saved-msg'
import { expandPastes, isBigPaste, livePastes, nextPasteNumber, pasteLines, pasteSize, pasteToken } from './paste'
import {
  MEDIA_OPEN_FAIL,
  MEDIA_PLAY_NOTES
} from '../../shared/media'

type Mode = 'chat' | 'term'
type Attach = { path: string; name: string; mime: string; preview?: string }

function collectFiles(from: DataTransfer | null): File[] {
  if (!from) return []
  const out: File[] = []
  if (from.items && from.items.length) {
    for (const it of Array.from(from.items)) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  if (out.length) return out
  return Array.from(from.files || [])
}

function filePath(f: File): string {
  const tagged = f as File & { path?: string }
  if (tagged.path) return tagged.path
  try {
    return window.brain.files.pathFor(f) || ''
  } catch {
    return ''
  }
}
type Msg = {
  who: 'me' | 'brain' | 'think' | 'sys' | 'plan' | 'err' | 'raw' | 'tool'
  text: string
  files?: Attach[]
  at?: number
  end?: number
  /** Tool rows: the file a step touched, and whether the turn is still on it. */
  path?: string
  tool?: string
  live?: boolean
  steps?: { title: string; status?: string }[]
  rawKind?: string
  skinLabel?: string | null
  fingerprint?: string
  pastes?: Paste[]
}
type Queued = { id: string; text: string; files?: Attach[]; wire?: string; pastes?: Paste[] }

function wantsStop(text: string): boolean {
  return /^\s*(please\s+)?(just\s+)?(stop|cancel|abort|never mind|nevermind|halt)\b/i.test(text)
}

function justStop(text: string): boolean {
  return /^\s*(please\s+)?(just\s+)?(stop|cancel|abort|never mind|nevermind|halt)\s*[.!]?\s*$/i.test(text)
}

function PanelBody({ body, rich }: { body: string; rich?: boolean }) {
  if (!rich) return <pre className="cmdbody">{body}</pre>
  const blocks = panelBlocks(body)
  if (!blocks.length) return <pre className="cmdbody">{body}</pre>
  return (
    <div className="cmdblocks">
      {blocks.map((b, i) => (
        <section className="cmdblock" key={i}>
          {b.heading ? <h4>{b.heading}</h4> : null}
          {b.rows.map((r, j) =>
            r.kind === 'line' ? (
              <p className="cmdline" key={j}>
                {r.text}
              </p>
            ) : (
              <div className={r.percent != null ? 'cmdrow meter' : 'cmdrow'} key={j}>
                <span className="cmdkey">{r.key}</span>
                {r.href ? (
                  <button type="button" className="linkish cmdval" onClick={() => void window.brain.bridge.openUrl(r.href!)}>
                    {r.href.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </button>
                ) : (
                  <span className="cmdval">{r.value}</span>
                )}
                {r.percent != null ? (
                  <span
                    className={r.percent >= 90 ? 'cmdbar hot' : 'cmdbar'}
                    role="meter"
                    aria-label={r.key}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={r.percent}
                  >
                    <i style={{ width: `${r.percent}%` }} />
                  </span>
                ) : null}
              </div>
            )
          )}
        </section>
      ))}
    </div>
  )
}

function liveUsageNote(ctx: { used?: number; total?: number; percent?: number }): string {
  if (ctx.percent == null && ctx.used == null) return ''
  const n = (v: number) => v.toLocaleString('en-US')
  const bits = ['This chat']
  if (ctx.percent != null) bits.push(`Context used: ${ctx.percent}%`)
  if (ctx.used != null && ctx.total != null) bits.push(`${n(ctx.used)} / ${n(ctx.total)} tokens`)
  else if (ctx.used != null) bits.push(`${n(ctx.used)} tokens`)
  return bits.join('\n')
}
type FileNode = { name: string; path: string; dir: boolean; kids?: FileNode[] }
type Cap = { id: string; label: string }
type SessionCmd = { name: string; description: string; hint?: string }

const SESSION_QUIET = new Set(['compact', 'rewind', 'undo', 'flush', 'dream', 'context', 'session-info', 'usage'])

const SLASH_ALIAS: Record<string, string> = {
  undo: 'rewind',
  exit: 'quit',
  welcome: 'home',
  m: 'model',
  auto: 'always-approve',
  status: 'session-info',
  info: 'session-info',
  mem: 'memory',
  howto: 'docs',
  guides: 'docs',
  changelog: 'release-notes',
  'agents-dashboard': 'dashboard',
  agents: 'config-agents',
  cost: 'usage',
  'show-plan': 'view-plan',
  'plan-view': 'view-plan'
}

function slashLine(raw: string): string {
  const t = raw.trim()
  if (!t.startsWith('/')) return t
  const [cmd, ...rest] = t.slice(1).split(/\s+/)
  const name = SLASH_ALIAS[(cmd || '').toLowerCase()] || (cmd || '').toLowerCase()
  const arg = rest.join(' ')
  return arg ? `/${name} ${arg}` : `/${name}`
}

const NEED_ARG = new Set([
  'imagine',
  'imagine-video',
  'remember',
  'btw',
  'deep-research',
  'goal',
  'loop',
  'plan',
  'feedback',
  'rename',
  'title',
  'model',
  'effort',
  'workflow'
])
type Tab = {
  id: string
  type: 'chat' | 'file' | 'term' | 'factory' | 'library' | 'desk'
  title: string
  kind?: AiKind
  mode?: Mode
  sessionId?: string
  model?: string
  effort?: string
  speed?: string
  agentMode?: string
  models?: Cap[]
  efforts?: Cap[]
  speeds?: Cap[]
  agentModes?: Cap[]
  cliSessionId?: string
  alwaysApprove?: boolean
  path?: string
  fileKind?: string
  html?: string
  url?: string
  text?: string
  dirty?: boolean
  modelsLive?: boolean
  mediaId?: string
  mediaTitle?: string
  mediaMime?: string
  mediaBytes?: number
  mediaNote?: string
  /** Factory tabs: the run this tab shows. */
  runId?: string
}

function MediaFilePane({
  tab,
  setNote
}: {
  tab: Tab
  setNote: (note: string) => void
}) {
  const src = tab.mediaId ? `brain-media://${tab.mediaId}` : ''
  const note = tab.mediaNote
  useEffect(() => {
    if (!src) {
      setNote(MEDIA_OPEN_FAIL)
      return
    }
    let dead = false
    void fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then(async (r) => {
        if (dead || r.ok || r.status === 206) return
        const text = (await r.text()).trim()
        setNote((MEDIA_PLAY_NOTES as readonly string[]).includes(text) ? text : MEDIA_OPEN_FAIL)
      })
      .catch(() => {
        if (!dead) setNote(MEDIA_OPEN_FAIL)
      })
    return () => {
      dead = true
    }
  }, [src])
  const mediaId = tab.mediaId || ''
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (mediaId) void window.brain.media.prepare({ mediaId })
  }, [mediaId])
  const act = async (run: () => Promise<{ ok: boolean; detail?: string; canceled?: boolean; path?: string }>, done: string) => {
    const r = await run()
    setSaid(r.ok ? done : r.canceled ? '' : r.detail || MEDIA_OPEN_FAIL)
  }
  const arm = () => {
    if (mediaId) void window.brain.media.armDrag({ mediaId })
  }
  const drag = (e: React.DragEvent) => {
    e.preventDefault()
    if (mediaId) window.brain.media.startDrag({ mediaId })
  }
  const mime = tab.mediaMime || ''
  return (
    <>
      <div className="filetab-head">
        {tab.mediaTitle || tab.title}
        {mediaId ? (
          <span className="filetab-actions">
            <button type="button" onClick={() => void act(() => window.brain.media.open({ mediaId }), '')}>
              Open
            </button>
            <button type="button" onClick={() => void act(() => window.brain.media.saveCopy({ mediaId }), 'Saved a copy.')}>
              Save a copy…
            </button>
            <button type="button" onClick={() => void act(() => window.brain.media.copyHere({ mediaId }), 'Put a copy in this folder.')}>
              Put a copy in this folder
            </button>
          </span>
        ) : null}
      </div>
      {said ? <p className="tiny">{said}</p> : null}
      {note ? (
        <p className="note">{note}</p>
      ) : mime.startsWith('image/') ? (
        <div className="filemedia">
          <img
            src={src}
            alt={tab.mediaTitle || tab.title}
            draggable
            onMouseDown={arm}
            onDragStart={drag}
            onError={() => {
              if (!note) setNote(MEDIA_OPEN_FAIL)
            }}
          />
        </div>
      ) : mime.startsWith('video/') || mime.startsWith('audio/') ? (
        <div className="filemedia">
          <video
            controls
            src={src}
            draggable
            onMouseDown={arm}
            onDragStart={drag}
            onError={() => {
              if (!note) setNote(MEDIA_OPEN_FAIL)
            }}
          />
        </div>
      ) : (
        <div className="filemedia">
          <p className="tiny">
            {mime || 'File'}
            {tab.mediaBytes ? ` · ${Math.max(1, Math.round(tab.mediaBytes / 1024))} KB` : ''}. Use Open to view it in its own app.
          </p>
        </div>
      )}
    </>
  )
}

/** What a tab keeps across restarts. A stored file opened from the library keeps enough to open it again. */
function savedTab(x: Tab) {
  return {
    id: x.id,
    type: x.type,
    title: x.title,
    kind: x.kind,
    mode: x.mode,
    model: x.model,
    effort: x.effort,
    speed: x.speed,
    agentMode: x.agentMode,
    cliSessionId: x.cliSessionId,
    path: x.path,
    runId: x.runId,
    ...(x.fileKind === 'media' && !x.path
      ? { fileKind: x.fileKind, mediaId: x.mediaId, mediaTitle: x.mediaTitle, mediaMime: x.mediaMime, mediaBytes: x.mediaBytes }
      : {})
  }
}

function widthPref(key: string, fallback: number): number {
  const n = Number(localStorage.getItem(key) || '')
  return Number.isFinite(n) && n >= 160 && n <= 520 ? n : fallback
}

function nid(): string {
  return crypto.randomUUID()
}

function label(kind: AiKind): string {
  if (kind === 'claude') return 'Claude'
  if (kind === 'gpt') return 'ChatGPT'
  if (kind === 'cursor') return 'Cursor'
  return 'Grok'
}

function prettySpeed(id?: string, speeds?: Cap[]): string {
  if (!id) return 'Default'
  return speeds?.find((s) => s.id === id)?.label || id
}

function prettyModel(id?: string, kind?: AiKind, models?: Cap[]): string {
  if (!id) return label(kind || 'grok')
  const hit = models?.find((m) => m.id === id || m.label === id)
  if (hit) return hit.label
  const base = id.replace(/\[.*$/, '')
  return base
    .replace(/^grok-/i, 'Grok ')
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gpt-/i, 'GPT-')
}

function cliModels(kind: AiKind | undefined, list?: Cap[] | null): Cap[] {
  const raw = Array.isArray(list) ? list : []
  if (!kind || kind === 'grok' || kind === 'cursor') return raw
  return raw.filter((m) => {
    const id = String(m.id || '')
    const lab = String(m.label || '')
    if (/^cursor-grok/i.test(id) || /cursor grok/i.test(lab)) return true
    return !/^grok[-_]/i.test(id) && !/^grok\s/i.test(lab)
  })
}

function modelOnList(id: string | undefined, list: Cap[]): string | undefined {
  if (!id) return undefined
  return list.some((m) => m.id === id || m.label === id) ? id : undefined
}

function claudeModelOnList(id: string | undefined, list: Cap[]): string {
  return keepClaudeModel(id, list)
}

function deskModels(cli: DeskCli, list?: Cap[]): Cap[] {
  const rows = cliModels(cli, list)
  return rows.length ? rows : [{ id: 'default', label: 'Default' }]
}

function deskEfforts(cli: DeskCli): Cap[] {
  if (cli === 'gpt' || cli === 'cursor') return []
  return fallbackEfforts(cli)
}

function fallbackEfforts(kind?: AiKind): Cap[] {
  if (kind === 'cursor') return []
  if (kind === 'claude') {
    return [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' }
    ]
  }
  if (kind === 'gpt') {
    return [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' }
    ]
  }
  return [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' }
  ]
}

function hitLabel(cwd: string, abs: string): string {
  const away = outsideProject(cwd, abs)
  if (!away) return rel(cwd, abs)
  const name = away.split('/').filter(Boolean).pop() || away
  const rest = rel(away, abs)
  return rest && rest !== name ? `${name}/${rest}` : name
}

function TermPane({ id, cwd, active }: { id: string; cwd: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#1a1612',
        foreground: '#f3eee8',
        cursor: '#f0810e',
        black: '#1a1612',
        red: '#c45f00',
        green: '#2c6e3a',
        yellow: '#f0810e',
        blue: '#5c534a',
        magenta: '#8a5a12',
        cyan: '#5c534a',
        white: '#f3eee8'
      },
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    let live = true
    void window.brain.pty.create({ id, cwd, cols: term.cols, rows: term.rows, shell: true })
    const offData = window.brain.pty.onData((ev) => {
      if (live && ev.id === id) {
        term.write(ev.data)
        if (active) term.scrollToBottom()
      }
    })
    const offExit = window.brain.pty.onExit((ev) => {
      if (live && ev.id === id) term.write(`\r\n[session ended ${ev.exitCode}]\r\n`)
    })
    const sub = term.onData((data) => {
      if (live) void window.brain.pty.write(id, data)
    })
    const onResize = () => {
      try {
        fit.fit()
        void window.brain.pty.resize(id, term.cols, term.rows)
      } catch {
        /* */
      }
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(host.current)
    return () => {
      live = false
      offData()
      offExit()
      sub.dispose()
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      void window.brain.pty.kill(id)
      term.dispose()
      termRef.current = null
    }
  }, [id, cwd])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) void window.brain.pty.resize(id, term.cols, term.rows)
        term?.scrollToBottom()
        term?.focus()
      } catch {
        /* */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [active, id])

  return <div className={`termhost ${active ? 'on' : ''}`} ref={host} />
}

function Rich({ text }: { text: string }) {
  const parts = tidy(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
        return p.split('\n').map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            {line}
            {j < arr.length - 1 ? <br /> : null}
          </span>
        ))
      })}
    </>
  )
}

export function ChatPane({
  id,
  kind,
  cwd,
  sessionId,
  active,
  greeting,
  initialMessages,
  model,
  effort,
  speed,
  agentMode,
  resumeId,
  alwaysApprove,
  onFiles,
  onNew,
  onModel,
  onEffort,
  onCaps,
  onTranscript,
  onContext,
  onApprove,
  onRename,
  onResume,
  onFork,
  onAgentMode,
  onDelete,
  onOpenTerm,
  onBusy,
  onActivity,
  onPowerPickers
}: {
  id: string
  kind: AiKind
  cwd: string
  sessionId: string
  active: boolean
  greeting: string
  initialMessages?: Msg[]
  model?: string
  effort?: string
  speed?: string
  agentMode?: string
  resumeId?: string
  alwaysApprove?: boolean
  onFiles: (id: string, files: FileHit[]) => void
  onNew: () => void
  onModel: (m: string) => void
  onEffort: (e: string) => void
  onCaps: (c: {
    model?: string
    effort?: string
    speed?: string
    agentMode?: string
    sessionId?: string
    models?: Cap[]
    efforts?: Cap[]
    speeds?: Cap[]
    agentModes?: Cap[]
  }) => void
  onTranscript: (id: string, messages: Msg[]) => void
  onContext: (id: string, ctx: { used?: number; total?: number; percent?: number }) => void
  onApprove: (v: boolean) => void
  onRename: (title: string) => void
  onResume: (sessionId: string) => void
  onFork: (messages: Msg[], sessionId?: string) => void
  onAgentMode: (mode: string) => void
  onDelete: () => void
  onOpenTerm: () => void
  onBusy: (id: string, busy: boolean) => void
  /** What the right rail shows for this chat: Now, its Plan, Done so far, Files. */
  onActivity: (id: string, activity: Activity | null) => void
  onPowerPickers?: () => void
}) {
  const [messages, setMessages] = useState<Msg[]>(
    initialMessages && initialMessages.length ? initialMessages : [{ who: 'brain', text: greeting }]
  )
  const [say, setSay] = useState('')
  const [pageAt, setPageAt] = useState<number | null>(null)
  const [pageView, setPageView] = useState<'small' | 'wide' | 'note'>('small')
  const [pageShot, setPageShot] = useState<string | null>(null)
  const [pageSignIn, setPageSignIn] = useState(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const pageAtRef = useRef(pageAt)
  pageAtRef.current = pageAt
  const [busy, setBusy] = useState(false)
  const [warming, setWarming] = useState(false)
  const [waitLabel, setWaitLabel] = useState('Working')
  // The right rail: this turn's actions (work: labels and file events), its plan steps, and its files.
  const [action, setAction] = useState<ActionState>({ log: [] })
  const [railSteps, setRailSteps] = useState<{ title: string; status?: string }[]>([])
  const [turnAt, setTurnAt] = useState(0)
  const [railFiles, setRailFiles] = useState<FileHit[]>([])
  const [waitSec, setWaitSec] = useState(0)
  /** Background work the agent started (another AI, a long command), with when it began. */
  const [bgTasks, setBgTasks] = useState<{ label: string; at: number }[]>([])
  const [bgNow, setBgNow] = useState(Date.now())
  /** Last Ctrl-C this tab sent to the Skin: Claude quits on a second one inside a few seconds. */
  const lastCtrlC = useRef(0)
  const [cmds, setCmds] = useState<{ name: string; kind: 'builtin' | 'skill'; description: string }[]>([])
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [hi, setHi] = useState(0)
  const [panel, setPanel] = useState<{ title: string; body: string; rich?: boolean } | null>(null)
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  const [drops, setDrops] = useState<Attach[]>([])
  const [pastes, setPastes] = useState<Paste[]>([])
  const [enterSends, setEnterSends] = useState(true)
  const [showTimes, setShowTimes] = useState(false)
  const [over, setOver] = useState(false)
  const [dropNote, setDropNote] = useState('')
  const [sessionCmds, setSessionCmds] = useState<SessionCmd[]>([])
  const [resumeRows, setResumeRows] = useState<{ id: string; title: string; updated: string }[] | null>(null)
  const ctxRef = useRef<{ used?: number; total?: number; percent?: number }>({})
  const [ctx, setCtx] = useState<{ used?: number; total?: number; percent?: number }>({})
  const dropsRef = useRef<Attach[]>([])
  const pastesRef = useRef<Paste[]>([])
  const pendingDrops = useRef(Promise.resolve())
  const thread = useRef<HTMLDivElement>(null)
  const sayBox = useRef<HTMLTextAreaElement>(null)
  const filesRef = useRef<FileHit[]>([])
  const turn = useRef({ think: false, answer: false })
  const [queue, setQueue] = useState<Queued[]>([])
  const queueRef = useRef<Queued[]>([])
  const [skinOn] = useState(true)
  const [planOn, setPlanOn] = useState(false)
  const planOnRef = useRef(false)
  planOnRef.current = planOn
  const [wantPower] = useState(false)
  const [cliSid, setCliSid] = useState(resumeId || '')
  const [tuiGen, setTuiGen] = useState(0)
  const [peel, setPeel] = useState(false)
  const firstMe = messages.findIndex((m) => m.who === 'me')
  const sentOnce =
    firstMe >= 0 && messages.slice(firstMe + 1).some((m) => m.who === 'brain' && Boolean(m.text))
  const showPower = wantPower || sentOnce
  const lastWarm = useRef('')
  const [permission, setPermission] = useState<{
    title?: string
    path?: string
    detail?: string
    options?: { id: string; label: string }[]
    requestId?: string
  } | null>(null)
  const sendTextRef = useRef<(t: string, opts?: { cancel?: boolean; fromQueue?: boolean; files?: Attach[]; pastes?: Paste[] }) => Promise<void>>(async () => {})
  const sendSkillRef = useRef<(display: string, prompt: string, fromQueue?: boolean, files?: Attach[]) => Promise<void>>(async () => {})
  const pinBottom = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const skipDrain = useRef(0)
  const busyRef = useRef(false)
  const onFilesRef = useRef(onFiles)
  const onContextRef = useRef(onContext)
  const skinOnRef = useRef(skinOn)
  onFilesRef.current = onFiles
  onContextRef.current = onContext
  skinOnRef.current = skinOn
  const kindRef = useRef(kind)
  kindRef.current = kind
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const agentModeRef = useRef(agentMode)
  agentModeRef.current = agentMode
  const onAgentModeRef = useRef(onAgentMode)
  onAgentModeRef.current = onAgentMode
  const cliSidRef = useRef(cliSid)
  const showPlanRef = useRef<(on: boolean) => void>(() => {})
  cliSidRef.current = cliSid
  busyRef.current = busy

  function markBusy(next: boolean) {
    busyRef.current = next
    setBusy(next)
  }

  /** A new message clears Done so far. The plan stays, and a later plan event adds to it. /clear and /home empty the plan. */
  function freshTurnRail() {
    setAction({ log: [] })
    setTurnAt(Date.now())
  }

  function resetRail() {
    freshTurnRail()
    setRailSteps([])
  }

  function reportFiles(files: FileHit[]) {
    onFilesRef.current(id, files)
    setRailFiles(files)
  }

  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  useEffect(() => {
    if (!active || pageAt == null || pageView === 'note') return
    let dead = false
    let busyShot = false
    const tickShot = () => {
      if (busyShot || dead || !window.brain.browser?.face) return
      busyShot = true
      void window.brain.browser.face(`chat:${id}`).then((face) => {
        if (dead || !face) return
        if (face.src) setPageShot(face.src)
        setPageSignIn(!!face.signIn)
      }).finally(() => {
        busyShot = false
      })
    }
    tickShot()
    const timer = window.setInterval(tickShot, pageView === 'wide' ? 500 : 1500)
    return () => {
      dead = true
      window.clearInterval(timer)
    }
  }, [active, pageAt, pageView])
  // This chat's AI opened or moved a page with its browser tools: the picture goes under the message it is answering.
  useEffect(
    () =>
      window.brain.browser.onOpened((owner) => {
        if (owner !== `chat:${id}`) return
        const asked = [...messagesRef.current].reverse().find((m) => m.who === 'me')
        if (asked?.at == null || asked.at === pageAtRef.current) return
        setPageAt(asked.at)
        setPageView('small')
        setPageSignIn(false)
      }),
    [id]
  )
  // Only real changes reach the workspace: the rail runs its own timer from since.
  useEffect(() => {
    onActivityRef.current(id, chatActivity({ busy, turnAt, action, permission, steps: railSteps, files: railFiles, bg: bgTasks }))
  }, [id, busy, turnAt, action, permission, railSteps, railFiles, bgTasks])
  useEffect(() => () => onActivityRef.current(id, null), [id])

  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(() => sayBox.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [active])

  useEffect(() => {
    if (sentOnce) onPowerPickers?.()
  }, [sentOnce, onPowerPickers])

  useEffect(() => {
    if (!panel && !resumeRows) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setPanel(null)
      setResumeRows(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, resumeRows])

  function writeQueue(next: Queued[]) {
    queueRef.current = next
    setQueue(next)
    window.brain.phone.reportQueue(
      id,
      next.map((q) => ({
        id: q.id,
        // The phone has no paste chips: it gets the full text to edit and the folded line to show.
        text: expandPastes(q.text, q.pastes || []),
        ...(q.pastes?.length ? { label: q.text } : {}),
        names: (q.files || []).map((f) => f.name),
        files: (q.files || []).map((f) => ({ path: f.path, name: f.name, mime: f.mime }))
      }))
    )
  }

  useEffect(() => {
    return window.brain.phone.onIncoming((ev) => {
      if (ev.tabId !== id) return
      const files = ev.files || []
      if (ev.queued) {
        writeQueue([
          ...queueRef.current,
          { id: ev.queueId || crypto.randomUUID(), text: ev.text, files: files.length ? files : undefined }
        ])
        return
      }
      markBusy(true)
      setWaitLabel('Working')
      freshTurnRail()
      turn.current = { think: false, answer: false }
      pinBottom.current = true
      setAtBottom(true)
      setMessages((m) => [...m, { who: 'me', text: ev.text, files: files.length ? files : undefined, at: Date.now() }])
    })
  }, [id])

  useEffect(() => {
    const off = window.brain.chat.onEvent((ev) => {
      if (ev.tabId !== id) return
      if (ev.kind === 'thought' && ev.data) {
        setWaitLabel('Thinking')
        const bit = ev.data
        turn.current.think = true
        setMessages((msgs) => appendThought(msgs, bit))
      }
      if (ev.kind === 'text' && ev.data) {
        setWaitLabel('Writing')
        const bit = ev.data
        setMessages((msgs) => {
          const next = [...msgs]
          const last = next[next.length - 1]
          if (turn.current.answer && last && last.who === 'brain') last.text += bit
          else {
            turn.current.answer = true
            next.push({ who: 'brain', text: bit })
          }
          return next
        })
      }
      if (ev.kind === 'plan' && ev.steps?.length) {
        const steps = ev.steps
        setRailSteps((prev) => mergePlanSteps(prev, steps))
        setMessages((msgs) => {
          const next = [...msgs]
          let lastMe = -1
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].who === 'me') {
              lastMe = i
              break
            }
          }
          let planAt = -1
          for (let i = next.length - 1; i > lastMe; i--) {
            if (next[i].who === 'plan') {
              planAt = i
              break
            }
          }
          const row = { who: 'plan' as const, text: '', steps }
          if (planAt >= 0) next[planAt] = row
          else next.push(row)
          return next
        })
      }
      if (ev.kind === 'commands' && ev.commands) {
        setSessionCmds(ev.commands)
      }
      if (ev.kind === 'mode' && ev.mode) {
        if (kindRef.current === 'grok' || kindRef.current === 'claude') {
          showPlanRef.current(ev.mode === 'plan')
        } else if (ev.mode !== agentModeRef.current) {
          onAgentModeRef.current(ev.mode)
        }
      }
      if (ev.kind === 'context') {
        const next = { used: ev.used, total: ev.total, percent: ev.percent }
        ctxRef.current = next
        setCtx(next)
        onContextRef.current(id, next)
      }
      if (ev.kind === 'status' && ev.data === 'compacting') {
        compactingRef.current = true
        setCompacting(true)
        setWaitLabel('Compacting')
      }
      if (ev.kind === 'status' && ev.data === 'compacted') {
        compactingRef.current = false
        setCompacting(false)
        setWaitLabel('Working')
        setMessages((m) => {
          if (m.some((x) => x.who === 'sys' && x.text.startsWith('Older turns were summarized'))) return m
          return [
            ...m,
            {
              who: 'sys',
              text: 'Older turns were summarized for the model. The thread on screen is unchanged.'
            }
          ]
        })
      }
      // Claude started a turn on its own (a background task it was waiting on finished): show it live.
      if (ev.kind === 'status' && ev.data === 'turn:auto') {
        markBusy(true)
        setWaitLabel('Picking up background results')
        freshTurnRail()
        turn.current = { think: false, answer: false }
      }
      // Claude's own turn ended while your message still waits: your answer starts a fresh bubble.
      if (ev.kind === 'status' && ev.data === 'turn:auto-done') {
        setWaitLabel('Working')
        turn.current = { think: false, answer: false }
      }
      if (ev.kind === 'status' && ev.data && ev.data.startsWith('bg:')) {
        try {
          const list = JSON.parse(ev.data.slice(3)) as { label: string; at: number }[]
          setBgTasks(Array.isArray(list) ? list.filter((t) => t && t.label) : [])
        } catch {
          setBgTasks([])
        }
      }
      if (ev.kind === 'status' && ev.data && ev.data.startsWith('work:')) {
        const label = ev.data.slice(5).trim()
        if (label) setWaitLabel(label)
        if (label) setAction((a) => nextAction(a, label, Date.now()))
      }
      if (ev.kind === 'permission' && !ev.detail && kindRef.current === 'grok' && planOnRef.current && cliSidRef.current) {
        void window.brain.slash.grokPlan(cwdRef.current, cliSidRef.current).then((text) => {
          if (text.trim()) setPanel({ title: 'The plan', body: text })
        })
      }
      if (ev.kind === 'permission') {
        setPermission({
          title: ev.title,
          path: ev.path,
          detail: ev.detail,
          options: ev.options,
          requestId: ev.requestId
        })
      }
      if (ev.kind === 'file' && ev.path) {
        const hit = { path: ev.path, tool: ev.tool, live: true }
        setAction((a) => nextAction(a, fileAction(hit.path, hit.tool), Date.now()))
        if (!skinOnRef.current) {
          const base = ev.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ev.path
          setWaitLabel(ev.tool ? `${ev.tool} · ${base}` : `Reading ${base}`)
        }
        if (!filesRef.current.some((f) => f.path === hit.path)) {
          filesRef.current = [...filesRef.current, hit]
          reportFiles(filesRef.current)
        }
        // The thread gets a chip per file in the current run of tool steps.
        setMessages((msgs) => {
          for (let i = msgs.length - 1; i >= 0 && msgs[i].who === 'tool'; i--) {
            if (msgs[i].path === hit.path) return msgs
          }
          return [...msgs, { who: 'tool', text: '', path: hit.path, tool: hit.tool, live: true }]
        })
      }
      if (ev.kind === 'done' || ev.kind === 'error') {
        setWaitLabel('Working')
        if (compactingRef.current && ev.kind === 'done') {
          setMessages((m) => [
            ...m,
            {
              who: 'sys',
              text: 'This CLI did not compact this session. The thread is unchanged.'
            }
          ])
        }
        compactingRef.current = false
        setCompacting(false)
        filesRef.current = filesRef.current.map((f) => ({ ...f, live: false }))
        reportFiles(filesRef.current)
        setMessages((msgs) => (msgs.some((m) => m.live) ? msgs.map((m) => (m.live ? { ...m, live: false } : m)) : msgs))
        if (ev.kind === 'error' && ev.data) {
          setMessages((m) => [...m, { who: 'err', text: ev.data || '' }])
        }
        if (ev.kind === 'done') setPermission(null)
        if (skipDrain.current > 0) {
          skipDrain.current -= 1
          return
        }
        const nxt = queueRef.current[0]
        if (ev.kind === 'done' && nxt) {
          writeQueue(queueRef.current.slice(1))
          if (nxt.wire) void sendSkillRef.current(nxt.text, nxt.wire, true, nxt.files || [])
          else void sendTextRef.current(nxt.text, { fromQueue: true, files: nxt.files, pastes: nxt.pastes })
          return
        }
        markBusy(false)
      }
      const known = new Set([
        'thought',
        'text',
        'file',
        'status',
        'context',
        'commands',
        'done',
        'error',
        'permission',
        'plan'
      ])
      const rawSpec = specFromStreamEvent({ kind: ev.kind, data: ev.data })
      const rawComponent =
        ev.skinLabel && isSkinComponent(ev.skinLabel) && ev.skinLabel !== 'RawFallback'
          ? ev.skinLabel
          : rawSpec?.component
      if (
        ev.kind &&
        !known.has(ev.kind) &&
        !isHiddenStreamKind(ev.kind) &&
        ev.skinLabel !== 'ignore' &&
        rawComponent &&
        paintsThreadSpec(rawComponent, ev.data || '')
      ) {
        setMessages((m) => [
          ...m,
          {
            who: 'raw',
            text: ev.data || ev.kind,
            rawKind: ev.kind,
            skinLabel: ev.skinLabel,
            fingerprint: ev.fingerprint
          }
        ])
      }
    })
    return () => {
      off()
    }
  }, [id])

  useEffect(() => {
    return window.brain.phone.onStop((ev) => {
      if (ev.tabId !== id) return
      skipDrain.current += 1
      markBusy(false)
    })
  }, [id])

  useEffect(() => {
    return window.brain.phone.onQueue((ev) => {
      if (ev.tabId !== id) return
      if (ev.op === 'drop') writeQueue(queueRef.current.filter((x) => x.id !== ev.id))
      if (ev.op === 'now') void sendNow(ev.id)
    })
  }, [id])

  useEffect(() => {
    return window.brain.skin.onHealed((ev) => {
      setMessages((m) =>
        m.map((row) => {
          if (row.fingerprint && row.fingerprint === ev.fingerprint) {
            return { ...row, skinLabel: ev.component }
          }
          if (row.who === 'raw' && row.rawKind === ev.eventKind && (!row.skinLabel || row.skinLabel === 'RawFallback')) {
            return { ...row, skinLabel: ev.component, fingerprint: row.fingerprint || ev.fingerprint }
          }
          return row
        })
      )
    })
  }, [])

  useEffect(() => {
    if (!pinBottom.current) return
    thread.current?.scrollTo(0, thread.current.scrollHeight)
  }, [messages, busy, queue, permission, skinOn])

  usePageFollow(thread, pinBottom, `${pageView}:${pageShot ?? ''}`)

  function onThreadScroll() {
    const el = thread.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinBottom.current = pinned
    setAtBottom(pinned)
  }

  const reviewOn = bgTasks.some((t) => t.label.replace(/^Started in the background: /, '') === 'Opus is reviewing')
  const turnLive = busy || compacting || warming

  useEffect(() => {
    if (!bgTasks.length) return
    const t = setInterval(() => setBgNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [bgTasks.length])
  const bgFirst = bgTasks.length ? Math.min(...bgTasks.map((t) => t.at)) : 0
  const bgLabel = bgLine(bgTasks)

  useEffect(() => {
    if (!turnLive) {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [turnLive])

  useEffect(() => {
    onBusy(id, turnLive || reviewOn)
    return () => onBusy(id, false)
  }, [id, turnLive, reviewOn])

  useEffect(() => {
    onTranscript(id, messages)
  }, [messages, active])

  useEffect(() => {
    let live = true
    setModels([])
    window.brain.slash
      .list(cwd, kind)
      .then((r) => {
        if (!live) return
        setCmds(r.commands)
        setModels(cliModels(kind, r.models))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd, kind])

  useEffect(() => {
    if (!cwd) return
    const key = [id, kind, cwd, model, effort, speed, agentMode, resumeId].join('|')
    if (lastWarm.current === key) return
    lastWarm.current = key
    setWarming(true)
    setWaitLabel(`Starting ${kind === 'gpt' ? 'ChatGPT' : kind === 'cursor' ? 'Cursor' : kind === 'claude' ? 'Claude' : 'Grok'}`)
    void window.brain.chat
      .warm({ tabId: id, kind, cwd, model, effort, speed, agentMode, resumeId })
      .then((r) => {
        const listed = r?.models?.length ? cliModels(kind, r.models) : undefined
        if (listed?.length) setModels(listed)
        if (r?.commands?.length) setSessionCmds(r.commands)
        if (r?.sessionId) setCliSid(r.sessionId)
        onCaps({
          model: r?.model,
          effort: r?.effort,
          speed: r?.speed,
          agentMode: r?.agentMode,
          sessionId: r?.sessionId,
          models: listed,
          efforts: r?.efforts,
          speeds: r?.speeds,
          agentModes: r?.agentModes
        })
      })
      .catch((e) => {
        setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
      })
      .finally(() => setWarming(false))
  }, [id, kind, cwd, model, effort, speed, agentMode, resumeId])

  useEffect(() => {
    return () => {
      void window.brain.chat.close(id)
    }
  }, [id, cwd])

  const EFFORTS =
    kind === 'gpt' ? ['low', 'medium', 'high'] : kind === 'cursor' ? [] : ['low', 'medium', 'high', 'xhigh']
  const menuCmds = useMemo(() => {
    const seen = new Set<string>()
    const out: { name: string; kind: 'builtin' | 'skill'; description: string }[] = []
    for (const c of cmds) {
      seen.add(c.name)
      out.push(c)
    }
    for (const c of sessionCmds) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      out.push({ name: c.name, kind: 'builtin', description: c.description || 'Session command' })
    }
    return out
  }, [cmds, sessionCmds])
  const spaceNames = useMemo(() => {
    const s = new Set(NEED_ARG)
    for (const c of sessionCmds) if (c.hint) s.add(c.name)
    return s
  }, [sessionCmds])
  const slashOn = say.startsWith('/')
  const after = slashOn ? say.slice(1) : ''
  const space = after.indexOf(' ')
  const cmdTok = (space === -1 ? after : after.slice(0, space)).toLowerCase()
  const argTok = space === -1 ? '' : after.slice(space + 1)
  type Pick = { name: string; kind: 'builtin' | 'skill' | 'arg'; description: string; insert: string }
  let matches: Pick[] = []
  if (slashOn && (cmdTok === 'model' || cmdTok === 'm') && space !== -1) {
    matches = models
      .filter((m) => m.id.toLowerCase().includes(argTok.toLowerCase()) || m.label.toLowerCase().includes(argTok.toLowerCase()))
      .slice(0, 16)
      .map((m) => ({ name: m.id, kind: 'arg', description: m.label, insert: `/model ${m.id}` }))
  } else if (slashOn && cmdTok === 'effort' && space !== -1) {
    matches = EFFORTS.filter((e) => e.startsWith(argTok.toLowerCase())).map((e) => ({
      name: e,
      kind: 'arg',
      description: 'Reasoning effort',
      insert: `/effort ${e}`
    }))
  } else if (slashOn) {
    matches = menuCmds
      .filter((c) => c.name.toLowerCase().startsWith(cmdTok) || c.name.toLowerCase().includes(cmdTok))
      .sort((a, b) => {
        const al = a.name.toLowerCase()
        const bl = b.name.toLowerCase()
        const as = al === cmdTok ? 0 : al.startsWith(cmdTok) ? 1 : 2
        const bs = bl === cmdTok ? 0 : bl.startsWith(cmdTok) ? 1 : 2
        return as - bs || al.localeCompare(bl)
      })
      .slice(0, 40)
      .map((c) => ({
        name: c.name,
        kind: c.kind,
        description: c.description,
        insert: spaceNames.has(c.name) ? `/${c.name} ` : `/${c.name}`
      }))
  }

  async function loadResume(sessionId: string) {
    const r = await window.brain.chat.resume({ tabId: id, kind, cwd, sessionId })
    if (!r.ok) {
      note(r.error || 'Could not load that session.')
      return
    }
    const msgs = (r.messages || []).map((m) => ({ who: m.who, text: m.text })) as Msg[]
    setMessages(msgs.length ? msgs : [{ who: 'sys', text: 'Session loaded. The model has the history.' }])
    setBgTasks([])
    // A loaded session starts outside plan mode; Grok re-announces plan mode if that session is in it.
    planOnRef.current = false
    setPlanOn(false)
    setCliSid(r.sessionId || sessionId)
    onResume(r.sessionId || sessionId)
  }

  function showPlan(on: boolean) {
    if (on === planOnRef.current) return
    planOnRef.current = on
    setPlanOn(on)
    note(
      on
        ? kindRef.current === 'claude'
          ? 'Plan mode is on. Claude reads and plans but does not edit files. /plan off lets it build.'
          : 'Plan mode is on. Grok reads and writes a plan first, then asks you before it edits anything.'
        : 'Plan mode is off.'
    )
  }
  showPlanRef.current = showPlan

  function note(text: string) {
    setMessages((m) => [...m, { who: 'sys', text }])
  }

  async function resetCli() {
    const r = await window.brain.chat.reset({ tabId: id, kind, cwd, model, effort })
    if (r?.sessionId) {
      setCliSid(r.sessionId)
      onCaps({ sessionId: r.sessionId, model: r.model, effort: r.effort })
    }
  }

  function popup(title: string, body: string, rich = false) {
    setPanel({ title, body, rich })
  }

  function runSlash(raw: string): boolean {
    const t = raw.trim()
    if (!t.startsWith('/')) return false
    const [cmd, ...rest] = t.slice(1).split(/\s+/)
    const name = SLASH_ALIAS[(cmd || '').toLowerCase()] || (cmd || '').toLowerCase()
    const arg = rest.join(' ')
    if (name === 'new') {
      onNew()
      return true
    }
    if (name === 'clear') {
      planOnRef.current = false
      setPlanOn(false)
      setMessages([{ who: 'brain', text: greeting }])
      filesRef.current = []
      reportFiles([])
      setBgTasks([])
      resetRail()
      void resetCli()
        .then(() => {
          if (skinOn) setTuiGen((g) => g + 1)
        })
        .catch(() => {})
      return true
    }
    if (name === 'delete') {
      onDelete()
      return true
    }
    if (name === 'help') {
      popup('Commands', menuCmds.map((c) => `/${c.name}  ${c.description}`).join('\n'), true)
      return true
    }
    if (name === 'skills') {
      const rows = menuCmds.filter((c) => c.kind === 'skill')
      popup(
        'Skills',
        rows.length
          ? rows.map((c) => `/${c.name}  ${c.description}`).join('\n')
          : 'No skills found. Brain looks in .claude, .agents, .grok and .cursor skills and commands (this folder and your home folder), .claude/commands/<ns>/<name>.md as /ns:name, .codex/skills in this folder, ~/.claude/skills/synced, ~/.claude/plugins, and Codex home skills and prompts ($CODEX_HOME, default ~/.codex).',
        rows.length > 0
      )
      return true
    }
    if (name === 'usage' || name === 'cost') {
      popup('Usage', 'Loading…')
      const live = liveUsageNote(ctxRef.current)
      const show = (body: string) => popup('Usage', [body, live].filter(Boolean).join('\n\n') || '(no output)', true)
      void window.brain.slash
        .usage(cwd, kind, cliSid)
        .then(async (body) => {
          show(body)
          if (kind !== 'grok' || !body.includes('Grok is still starting')) return
          // One retry once the booting agent is ready, only if this popup is still the one on screen.
          if (!(await window.brain.slash.grokReady(cwd))) return
          const again = await window.brain.slash.usage(cwd, kind, cliSid)
          setPanel((p) => (p && p.title === 'Usage' && p.body.includes('Grok is still starting') ? { ...p, body: [again, live].filter(Boolean).join('\n\n') } : p))
        })
        .catch((e: unknown) => popup('Usage', String((e as Error).message || e)))
      return true
    }
    if (name === 'model' || name === 'm') {
      if (!arg) {
        popup('Pick a model', models.slice(0, 20).map((m) => `${m.id}\n  ${m.label}`).join('\n') || 'No models yet.')
        return true
      }
      const q = arg.trim().toLowerCase()
      const exact = models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q)
      const hits = exact
        ? [exact]
        : models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      if (hits.length === 1) {
        onModel(hits[0].id)
        note(`Model is ${hits[0].id} (${hits[0].label}) for this ${kind} chat.`)
        return true
      }
      popup(
        hits.length ? 'Pick a model' : `"${arg}" isn't a model for ${kind}`,
        (hits.length ? hits : models.slice(0, 14)).map((m) => `${m.id}\n  ${m.label}`).join('\n')
      )
      setSay('/model ')
      return true
    }
    if (name === 'effort') {
      if (!EFFORTS.length) return false
      if (!arg) {
        popup('Pick effort', EFFORTS.join('\n'))
        return true
      }
      const want = arg.toLowerCase()
      if (!EFFORTS.includes(want)) {
        popup('Pick effort', EFFORTS.join('\n'))
        return true
      }
      onEffort(want)
      note(`Effort is ${want}.`)
      return true
    }
    if (name === 'plan') {
      const off = /^(off|exit|stop|leave|done)$/i.test(arg.trim())
      const ask = off ? '' : arg.trim()
      if (kind === 'grok' || kind === 'claude') {
        const want = !off
        if (planOnRef.current === want && !ask) {
          note(want ? 'Plan mode is already on. /plan off leaves it.' : 'Plan mode is already off.')
          return true
        }
        void (async () => {
          const r = await window.brain.chat.planMode({ tabId: id, kind, on: want })
          if (!r.ok) {
            note(r.error || 'Plan mode did not switch.')
            return
          }
          if (!r.confirmed) {
            note(
              `${label(kind)} did not confirm the switch in time, so plan mode is unknown right now. /permissions shows the last state Brain saw.`
            )
            return
          }
          showPlan(!!r.on)
          if (ask) await sendTextRef.current(ask)
        })()
        return true
      }
      if (kind === 'cursor') {
        if (ask) return false
        onAgentMode(off ? 'agent' : 'plan')
        note(off ? 'Cursor mode is agent.' : 'Cursor mode is plan. /plan off goes back to agent.')
        return true
      }
      popup(
        'Plan mode',
        `${label(kind)} plan mode is an experimental Codex app-server setting that Brain does not turn on yet.\nAsk for a plan first, for example: make a plan for this and do not edit files until I say go.`
      )
      return true
    }
    if (name === 'view-plan') {
      if (kind !== 'grok' || !cliSid) {
        note('No plan yet in this chat.')
        return true
      }
      void window.brain.slash.grokPlan(cwd, cliSid).then((text) =>
        text.trim() ? setPanel({ title: 'The plan', body: text }) : note('No plan yet in this chat.')
      )
      return true
    }
    if (name === 'permissions') {
      const approve = alwaysApprove !== false
      const lines: string[] = ['Asks']
      if (kind === 'grok' || kind === 'cursor') {
        lines.push(`Always approve: ${approve ? 'On' : 'Off'}`)
        lines.push(
          approve
            ? `${label(kind)} runs tools without stopping to ask.`
            : `${label(kind)} stops and asks before a tool runs. Answer on the card in the chat.`
        )
        if (kind === 'grok') {
          lines.push(`Plan mode: ${planOn ? 'On' : 'Off'}`)
          if (planOn) lines.push('In plan mode Grok only edits its plan, and always asks before it starts coding.')
        }
        if (kind === 'cursor' && agentMode) lines.push(`Mode: ${agentMode}`)
        lines.push('It may read, edit, and run commands anywhere your Mac login can, the same as Terminal.')
        lines.push('', 'Switch', '/always-approve turns asking on or off for this chat.')
      } else if (kind === 'claude') {
        lines.push(`Plan mode: ${planOn ? 'On' : 'Off'}`)
        if (planOn) lines.push('In plan mode Claude reads and plans but does not edit files.')
        lines.push('Claude chat does not stop to ask.')
        lines.push('It may read, edit, and run commands anywhere your Mac login can, the same as Terminal.')
      } else {
        lines.push('ChatGPT chat does not stop to ask.')
        lines.push('It may read, edit, and run commands anywhere your Mac login can, the same as Terminal.')
      }
      lines.push('', 'Always', 'Google Ads changes and outbound mail still need a clear yes from you.')
      popup('Permissions', lines.join('\n'), true)
      return true
    }
    if ((name === 'session-info' || name === 'context') && kind !== 'grok') {
      const c = ctxRef.current
      const pick = models.find((m) => m.id === model)
      const lines = [
        name === 'context' ? 'Context window' : 'This chat',
        `CLI: ${label(kind)}`,
        `Model: ${pick?.label || model || 'Default'}`,
        EFFORTS.length ? `Effort: ${effort || 'Default'}` : '',
        agentMode ? `Mode: ${agentMode}` : '',
        c.percent != null ? `Context used: ${c.percent}%` : '',
        c.used != null ? `Tokens in context: ${c.used.toLocaleString('en-US')}${c.total ? ` of ${c.total.toLocaleString('en-US')}` : ''}` : '',
        c.percent == null && c.used == null ? 'Context: fills in after the first answer' : '',
        name === 'session-info' ? `Folder: ${cwd}` : '',
        name === 'session-info' && cliSid ? `Session: ${cliSid}` : ''
      ].filter(Boolean)
      popup(name === 'context' ? 'Context' : 'Status', lines.join('\n'), true)
      return true
    }
    if (name === 'compact') {
      if (!busy) {
        compactingRef.current = true
        setCompacting(true)
      }
      void sendQuiet(arg ? `/compact ${arg}` : '/compact')
      return true
    }
    if (name === 'home') {
      planOnRef.current = false
      setPlanOn(false)
      setMessages([{ who: 'brain', text: greeting }])
      filesRef.current = []
      reportFiles([])
      setBgTasks([])
      resetRail()
      void resetCli()
        .then(() => {
          if (skinOn) setTuiGen((g) => g + 1)
        })
        .catch(() => {})
      return true
    }
    if (name === 'terminal') {
      onOpenTerm()
      return true
    }
    if (name === 'edit-prompt') {
      const last = [...messages].reverse().find((m) => m.who === 'me')
      if (last) {
        setSay(last.text)
        keepPastes(last.pastes || [])
      } else note('No prompt to edit yet.')
      return true
    }
    if (name === 'multiline') {
      setEnterSends((v) => {
        note(v ? 'Enter inserts a newline. Shift+Enter sends.' : 'Enter sends.')
        return !v
      })
      return true
    }
    if (name === 'always-approve') {
      const next = !alwaysApprove
      onApprove(next)
      note(next ? 'Always-approve is on for this chat.' : 'Always-approve is off.')
      return true
    }
    if (name === 'timestamps') {
      setShowTimes((v) => !v)
      return true
    }
    if (name === 'fork') {
      void (async () => {
        try {
          const r = await window.brain.chat.fork({ tabId: id, kind, cwd })
          if (r.ok && r.sessionId) {
            onFork(
              [...messages, { who: 'sys', text: 'Forked the live session into this tab.' }],
              r.sessionId
            )
            return
          }
          onFork([
            ...messages,
            {
              who: 'sys',
              text: r.error || 'This CLI has no session fork, so the model starts fresh in this tab.'
            }
          ])
        } catch (e) {
          onFork([
            ...messages,
            { who: 'sys', text: String((e as Error).message || e) }
          ])
        }
      })()
      return true
    }
    if (name === 'rewind' || name === 'undo') {
      setMessages((m) => {
        const next = [...m]
        while (next.length && next[next.length - 1].who !== 'me') next.pop()
        next.pop()
        return next.length ? next : [{ who: 'brain', text: greeting }]
      })
      void sendQuiet('/rewind')
      note('Rewind sent to the live session. Last turn removed on screen.')
      return true
    }
    if (name === 'copy') {
      const last = [...messages].reverse().find((m) => m.who === 'brain' && m.text)
      const text = last?.text || ''
      if (text) void navigator.clipboard.writeText(text)
      note(text ? 'Copied the last answer.' : 'Nothing to copy yet.')
      return true
    }
    if (name === 'export') {
      const body = messages.map((m) => `## ${m.who}\n${m.text}`).join('\n\n')
      void window.brain.files.saveText(arg || 'chat.md', body).then((path) => {
        note(path ? `Saved ${path}` : 'Export cancelled.')
      }).catch((err) => note(String((err as Error).message || err)))
      return true
    }
    if (name === 'quit' || name === 'exit') {
      void window.brain.quit()
      return true
    }
    if (name === 'rename' || name === 'title') {
      if (!arg) return false
      onRename(arg)
      note(`Tab title: ${arg}`)
      return true
    }
    if (name === 'history') {
      popup(
        'History',
        messages
          .filter((m) => m.who === 'me')
          .map((m) => m.text)
          .join('\n') || '(no prompts yet)'
      )
      return true
    }
    if (name === 'doctor' || name === 'login' || name === 'logout') {
      if (kind === 'grok') {
        void window.brain.slash.cli([name], cwd).then((body) => popup(name, body))
        return true
      }
      return false
    }
    if (name === 'resume') {
      if (kind !== 'grok') return false
      if (arg && /^[0-9a-f-]{20,}$/i.test(arg)) {
        void loadResume(arg)
        return true
      }
      void window.brain.slash.sessions(cwd).then((rows) => setResumeRows(rows))
      return true
    }
    if (TUI_ONLY_SLASH.has(name)) {
      note(`/${name} is terminal chrome in the CLI's own screen, not a chat skill. Use Show terminal for it.`)
      return true
    }
    const sessionHit = sessionCmds.find((c) => c.name === name)
    if (sessionHit && !APP_SLASH.has(name)) {
      if (SESSION_QUIET.has(name)) {
        void sendQuiet(arg ? `/${name} ${arg}` : `/${name}`)
        return true
      }
      return false
    }
    if (SESSION_QUIET.has(name)) {
      void sendQuiet(arg ? `/${name} ${arg}` : `/${name}`)
      return true
    }
    return false
  }

  async function takeSlash(raw: string): Promise<boolean> {
    const t = raw.trim()
    if (!t.startsWith('/')) return false
    setPeel(false)
    if (runSlash(t)) return true
    let hit: { display: string; prompt: string } | null = null
    try {
      hit = await window.brain.slash.expand(cwd, t)
    } catch {
      hit = null
    }
    if (!hit) return false
    await pendingDrops.current
    const files = dropsRef.current
    dropsRef.current = []
    setDrops([])
    setDropNote('')
    await sendSkill(hit.display, hit.prompt, false, files)
    return true
  }

  async function sendSkill(display: string, prompt: string, fromQueue = false, files: Attach[] = []) {
    if (busyRef.current && !fromQueue) {
      writeQueue([
        ...queueRef.current,
        { id: crypto.randomUUID(), text: display, wire: prompt, files: files.length ? files : undefined }
      ])
      return
    }
    setPeel(false)
    pinBottom.current = true
    setAtBottom(true)
    const shown = files.length ? `${display}\n${files.map((a) => a.name).join(', ')}` : display
    setMessages((m) => [...m, { who: 'me', text: shown, files, at: Date.now() }])
    await sendQuiet(prompt, true, files)
  }
  sendSkillRef.current = sendSkill

  async function applyPick(pick: Pick) {
    if (pick.kind === 'arg') {
      setSay('')
      const raw = pick.insert.trim()
      if (!(await takeSlash(raw))) await sendText(slashLine(raw))
      return
    }
    if (pick.insert.endsWith(' ') && pick.kind !== 'skill') {
      setSay(pick.insert)
      setHi(0)
      return
    }
    setSay('')
    const line = '/' + pick.name
    if (!(await takeSlash(line))) await sendText(line)
  }

  async function stop() {
    if (busyRef.current) {
      await stopWarm()
      return
    }
    if (skinOn && peel) await ctrlC()
  }

  /** One Ctrl-C to the Skin. Claude's own screen quits on a second Ctrl-C within a few seconds, so skip that one. */
  async function ctrlC() {
    const now = Date.now()
    if (kindRef.current === 'claude' && now - lastCtrlC.current < 3000) return
    lastCtrlC.current = now
    await window.brain.pty.write(skinPtyId(id), '\x03')
  }

  async function stopWarm() {
    skipDrain.current += 1
    await window.brain.chat.stop(id)
    markBusy(false)
  }

  async function send() {
    await pendingDrops.current
    const t = say.trim()
    if (!t && !dropsRef.current.length) {
      if (queueRef.current[0]) void sendNow(queueRef.current[0].id)
      return
    }
    const onlyCmd = slashOn && !/\s/.test(t.trim())
    if (onlyCmd && matches.length && matches[hi]) {
      await applyPick(matches[hi])
      return
    }
    setSay('')
    const held = livePastes(t, pastesRef.current)
    keepPastes([])
    // A command gets its pastes written out; a message keeps them folded in the thread.
    const typed = t.startsWith('/') ? expandPastes(t, held) : t
    const folded = t.startsWith('/') ? [] : held
    const line = typed.startsWith('/') ? slashLine(typed) : typed
    if (await takeSlash(typed)) return
    if (busy && wantsStop(line)) {
      await stop()
      if (justStop(line)) return
      await sendText(line, { pastes: folded })
      return
    }
    if (busy) {
      const attached = dropsRef.current
      dropsRef.current = []
      setDrops([])
      writeQueue([
        ...queueRef.current,
        { id: crypto.randomUUID(), text: line, files: attached.length ? attached : undefined, pastes: folded.length ? folded : undefined }
      ])
      return
    }
    await sendText(line, { pastes: folded })
  }

  async function sendNow(qid: string) {
    const item = queueRef.current.find((q) => q.id === qid)
    if (!item) return
    writeQueue(queueRef.current.filter((q) => q.id !== qid))
    if (justStop(item.text)) {
      if (busyRef.current) await stop()
      return
    }
    if (item.wire) {
      if (busyRef.current) await stopWarm()
      await sendSkill(item.text, item.wire, true, item.files || [])
      return
    }
    await sendTextRef.current(item.text, { fromQueue: true, files: item.files || [], cancel: busyRef.current, pastes: item.pastes })
  }

  function editQueued(qid: string) {
    const item = queueRef.current.find((q) => q.id === qid)
    if (!item) return
    writeQueue(queueRef.current.filter((q) => q.id !== qid))
    setSay(item.text)
    keepPastes(item.pastes || [])
    if (item.files?.length) {
      dropsRef.current = item.files
      setDrops(item.files)
    }
  }

  async function sendQuiet(t: string, force = false, files: Attach[] = []) {
    if (busyRef.current && !force) {
      writeQueue([...queueRef.current, { id: crypto.randomUUID(), text: t }])
      return
    }
    markBusy(true)
    setWaitLabel('Working')
    freshTurnRail()
    turn.current = { think: false, answer: false }
    try {
      await window.brain.chat.send({
        tabId: id,
        text: t,
        kind,
        cwd,
        sessionId,
        model,
        effort,
        agentMode,
        alwaysApprove,
        history: [],
        ...(files.length ? { attachments: files.map(({ path, name, mime }) => ({ path, name, mime })) } : {}),
        system:
          CHAT_RULES
      })
    } catch (e) {
      markBusy(false)
      setCompacting(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
  }

  function keepPastes(next: Paste[]) {
    pastesRef.current = next
    setPastes(next)
  }

  /** Types at the caret through the browser, so one undo takes it back out. */
  function insertAtCaret(box: HTMLTextAreaElement, text: string) {
    box.focus()
    if (document.execCommand('insertText', false, text)) return
    const at = box.selectionStart
    const next = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd)
    setSay(next)
    requestAnimationFrame(() => box.setSelectionRange(at + text.length, at + text.length))
  }

  function expandPaste(p: Paste) {
    setSay((s) => s.replace(p.token, () => p.text))
    keepPastes(pastesRef.current.filter((x) => x !== p))
  }

  function dropPaste(p: Paste) {
    setSay((s) => s.split(p.token).join(''))
    keepPastes(pastesRef.current.filter((x) => x !== p))
  }

  function takeFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const files = Array.from(list)
    pendingDrops.current = pendingDrops.current
      .then(() => addFiles(files))
      .catch((err: unknown) => {
        setDropNote(String((err as Error).message || err))
      })
  }

  async function addFiles(files: File[]) {
    const next: Attach[] = []
    const skipped: string[] = []
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) {
        skipped.push(`${f.name} is larger than 20 MB`)
        continue
      }
      const mime = f.type && f.type !== 'application/octet-stream' ? f.type : ''
      const preview = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name) ? URL.createObjectURL(f) : undefined
      const path = filePath(f)
      if (path) {
        next.push({ path, name: f.name, mime, preview })
        continue
      }
      try {
        const buf = new Uint8Array(await f.arrayBuffer())
        const saved = await window.brain.files.stash(f.name, buf, mime)
        next.push({ ...saved, preview })
      } catch (err) {
        skipped.push(`${f.name} (${String((err as Error).message || err)})`)
      }
    }
    if (next.length) {
      const merged = [...dropsRef.current, ...next]
      dropsRef.current = merged
      setDrops(merged)
    }
    setDropNote(skipped.length ? skipped.join('. ') : '')
  }

  function removeDrop(i: number) {
    const gone = dropsRef.current[i]
    if (gone?.preview) URL.revokeObjectURL(gone.preview)
    const next = dropsRef.current.filter((_, j) => j !== i)
    dropsRef.current = next
    setDrops(next)
  }

  async function pickAttach() {
    const got = await window.brain.files.pick()
    if (!got) return
    if (got.files.length) {
      const merged = [...dropsRef.current, ...got.files]
      dropsRef.current = merged
      setDrops(merged)
    }
    setDropNote(got.skipped.length ? got.skipped.join('. ') : '')
  }

  function mergeSkinFiles(hits: FileHit[], live: boolean) {
    if (!live) {
      filesRef.current = filesRef.current.map((f) => ({ ...f, live: false }))
      reportFiles(filesRef.current)
      return
    }
    let next = filesRef.current
    for (const h of hits) {
      const i = next.findIndex((f) => f.path === h.path)
      if (i < 0) next = [...next, { ...h, live: true }]
      else next = next.map((f, j) => (j === i ? { ...f, live: true } : f))
    }
    filesRef.current = next
    reportFiles(next)
  }

  async function sendText(t: string, opts?: { cancel?: boolean; fromQueue?: boolean; files?: Attach[]; pastes?: Paste[] }) {
    await pendingDrops.current
    const folded = livePastes(t, opts?.pastes || [])
    const wire = expandPastes(t, folded)
    const route = routeLine(t, { peel: skinOn && peel })
    if (route === 'pty') {
      const attached = opts?.fromQueue ? opts.files || [] : opts?.files || dropsRef.current
      if (!opts?.fromQueue) {
        dropsRef.current = []
        setDrops([])
        setDropNote('')
      }
      if (opts?.cancel) await ctrlC()
      const shown = attached.length ? `${wire}${wire ? '\n' : ''}${attached.map((a) => a.path).join('\n')}` : wire
      if (shown) await window.brain.pty.write(skinPtyId(id), shown + '\r')
      return
    }
    if (t.trim().startsWith('/')) setPeel(false)
    if (opts?.cancel && busyRef.current) await stopWarm()
    if (busyRef.current && !opts?.fromQueue && !opts?.cancel) {
      writeQueue([...queueRef.current, { id: crypto.randomUUID(), text: t, files: opts?.files, pastes: folded.length ? folded : undefined }])
      return
    }
    filesRef.current = []
    reportFiles([])
    markBusy(true)
    setWaitLabel('Working')
    freshTurnRail()
    turn.current = { think: false, answer: false }
    if (!opts?.fromQueue) {
      pinBottom.current = true
      setAtBottom(true)
    }
    const attached = opts?.fromQueue ? opts.files || [] : opts?.files || dropsRef.current
    if (!opts?.fromQueue) {
      dropsRef.current = []
      setDrops([])
      setDropNote('')
    }
    const shown = attached.length ? `${t}${t ? '\n' : ''}${attached.map((a) => a.name).join(', ')}` : t
    const at = Date.now()
    const opened = pageAfterSend(wire, at)
    if (opened) {
      setPageAt(opened.at)
      setPageView(opened.view)
      setPageSignIn(false)
    }
    setMessages((m) => [...m, { who: 'me', text: shown, files: attached, at, ...(folded.length ? { pastes: folded } : {}) }])
    try {
      await window.brain.chat.send({
        tabId: id,
        text: wire,
        kind,
        cwd,
        sessionId,
        model,
        effort,
        agentMode,
        alwaysApprove,
        history: [],
        attachments: attached.map(({ path, name, mime }) => ({ path, name, mime })),
        system:
          CHAT_RULES
      })
    } catch (e) {
      markBusy(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
  }
  sendTextRef.current = sendText

  const pageOwner = `chat:${id}`
  const pageSlot = pageAt == null ? null : (
    <ChatPageTurn
      mode={pageView}
      src={pageShot}
      signIn={pageSignIn}
      owner={pageOwner}
      active={active}
      onToggle={() => setPageView((v) => (v === 'small' ? 'wide' : v))}
      onHide={() => setPageView('note')}
      onShow={() => setPageView('small')}
      onWiden={() => setPageView('wide')}
    />
  )

  return (
    <div
      className={`chatpane ${active ? 'on' : ''} ${over ? 'drop-on' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        takeFiles(collectFiles(e.dataTransfer))
      }}
    >
      {panel && (
        <div className="cmdpanel">
          <div className="invitehead">
            <strong>{panel.title}</strong>
            <button type="button" className="tabx" onClick={() => setPanel(null)} aria-label="Close">
              ×
            </button>
          </div>
          <PanelBody body={panel.body} rich={panel.rich} />
        </div>
      )}
      {resumeRows && (
        <div className="cmdpanel">
          <div className="invitehead">
            <strong>Resume a Grok session</strong>
            <button type="button" className="tabx" onClick={() => setResumeRows(null)} aria-label="Close">
              ×
            </button>
          </div>
          {resumeRows.length === 0 ? (
            <pre className="cmdbody">No saved Grok sessions for this folder.</pre>
          ) : (
            <div className="resumelist">
              {resumeRows.map((row) => (
                <button
                  type="button"
                  className="resumerow"
                  key={row.id}
                  onClick={() => {
                    setResumeRows(null)
                    void loadResume(row.id)
                  }}
                >
                  <strong>{row.title}</strong>
                  <span>
                    {row.updated ? new Date(row.updated).toLocaleString('en-US') : ''} · {row.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {false ? (
      <div className="skin-switch">
        <button type="button" className={skinOn ? 'on' : ''}>
          Skin
        </button>
        <button type="button" className={!skinOn ? 'on' : ''}>
          Chat
        </button>
      </div>
      ) : null}
      {skinOn ? null : permission ? (
        <div className="skin-perm">
          <p className="skin-perm-title">{permission.title || 'Allow this?'}</p>
          {permission.path ? <p className="tiny">{permission.path}</p> : null}
          {permission.detail ? <pre className="skin-perm-detail">{permission.detail}</pre> : null}
          <div className="skin-perm-actions">
            {(permission.options?.length
              ? permission.options
              : [
                  { id: 'allowOnce', label: 'Allow' },
                  { id: 'skip', label: 'Skip' },
                  { id: 'alwaysAllowInFolder', label: 'Always in this folder' }
                ]
            ).map((o, i) => (
              <button
                type="button"
                key={o.id}
                className={i === 0 ? 'primary' : 'ghost'}
                onClick={() => {
                  void window.brain.skin.decide(id, o.id)
                  setPermission(null)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <SkinPane
        tabId={id}
        cwd={cwd}
        kind={kind}
        visible={skinOn && active}
        restart={tuiGen}
        peel={peel}
        messages={messages}
        busy={busy || compacting || warming}
        waitLabel={compacting ? 'Compacting' : waitLabel}
        waitSec={waitSec}
        bgTasks={bgTasks}
        bgNow={bgNow}
        context={ctx}
        permission={permission}
        threadRef={thread}
        onScroll={onThreadScroll}
        onPeel={setPeel}
        onFiles={mergeSkinFiles}
        showPower={showPower}
        wantPower={wantPower}
        canPeel={false}
        cliName={label(kind)}
        pageAt={pageAt}
        pageSlot={pageSlot}
        onAction={(actionId, spec) => {
          if (actionId === 'selectOption') {
            const opt = String(spec.props.value || '')
            if (opt) void window.brain.skin.decide(id, opt)
            setPermission(null)
            return
          }
          if (actionId === 'allowOnce' || actionId === 'skip' || actionId === 'alwaysAllowInFolder') {
            void window.brain.skin.decide(id, actionId)
            setPermission(null)
            return
          }
          if (actionId === 'stop') {
            void window.brain.chat.stop(id)
            return
          }
          if (actionId === 'login') {
            void window.brain.ai.login(kind)
            return
          }
          if (actionId === 'runSlash') {
            const name = String(spec.props.name || '')
            if (name) {
              const line = '/' + name
              void takeSlash(line).then((took) => (took ? undefined : sendTextRef.current(line)))
            }
          }
        }}
      />
      {!skinOn ? (
      <div className="thread" ref={thread} onScroll={onThreadScroll}>
        {collapseAdjacentThinks(messages).map((m, i, view) =>
          m.who === 'plan' && m.steps?.length ? (
            <ol className="skin-plan" key={i}>
              {m.steps.map((s, j) => (
                <li key={j}>
                  {s.title} {s.status ? <span className="tiny">{s.status}</span> : null}
                </li>
              ))}
            </ol>
          ) : m.who === 'raw' && m.text && m.skinLabel !== 'ignore' && !isHiddenStreamKind(m.rawKind || '') && !isProtocolNoise(m.text) ? (
            <div className="bubble" key={i}>
              {m.text}
            </div>
          ) : m.who === 'err' && m.text ? (
            <SkinCard
              key={i}
              spec={(() => {
                const s = specFromStreamEvent({ kind: 'error', data: m.text }) || {
                  id: 'err-' + i,
                  component: 'ErrorNotice' as const,
                  props: { text: m.text },
                  actions: [],
                  source: 'error'
                }
                return s.component === 'LoginNeed' ? { ...s, props: { ...s.props, cliName: label(kind) } } : s
              })()}
              onAction={(id) => {
                if (id === 'login') void window.brain.ai.login(kind)
              }}
            />
          ) : m.text || m.who === 'me' ? (
            <div
              className={`bubble ${m.who === 'me' ? 'me' : ''} ${m.who === 'think' ? 'think' : ''} ${m.who === 'brain' ? 'md' : ''} ${m.who === 'sys' ? 'sys' : ''}`}
              key={i}
            >
              {m.who === 'think' && (
                <div className={`think-label ${busy && i === view.length - 1 ? 'live' : ''}`}>
                  Thinking
                  {busy && i === view.length - 1 ? <span className="dots" /> : null}
                </div>
              )}
              {m.who === 'brain' ? (
                <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(m.text) }} />
              ) : (
                <Rich text={m.text} />
              )}
              {m.who === 'me' && m.at === pageAt ? pageSlot : null}
              {m.who === 'me' && m.files && m.files.some((f) => f.preview) ? (
                <div className="attachrow in-bubble">
                  {m.files.map((a, j) =>
                    a.preview ? <img className="thumb" src={a.preview} alt={a.name} key={a.path + j} /> : null
                  )}
                </div>
              ) : null}
              {showTimes && m.at ? (
                <div className="when">{new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
              ) : null}
            </div>
          ) : null
        )}
      </div>
      ) : null}
      {(busy || compacting || warming) && !skinOn && (
        <WorkPulse label={compacting ? 'Compacting' : waitLabel} seconds={waitSec} />
      )}
      {!(busy || compacting || warming) && !skinOn && bgTasks.length ? (
        <WorkPulse label={bgLabel} seconds={Math.max(0, Math.floor((bgNow - bgFirst) / 1000))} />
      ) : null}
      {!atBottom && !(skinOn && peel) ? (
        <button type="button" className="jump-latest" onClick={() => {
          pinBottom.current = true
          setAtBottom(true)
          thread.current?.scrollTo(0, thread.current.scrollHeight)
        }}>
          Latest
        </button>
      ) : null}
      {over && <div className="dropveil">Drop images or docs here</div>}
      <div className="composer">
        {queue.length > 0 ? (
          <div className="followq">
            <p className="tiny">Queued. Runs after this turn. Say stop if you want it to halt first.</p>
            {queue.map((q) => (
              <div className="followq-row" key={q.id}>
                <span>{q.text}</span>
                <button type="button" className="linkish" onClick={() => void sendNow(q.id)}>
                  Send now
                </button>
                <button type="button" className="linkish" onClick={() => editQueued(q.id)}>
                  Edit
                </button>
                <button type="button" className="linkish" onClick={() => writeQueue(queueRef.current.filter((x) => x.id !== q.id))}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {matches.length > 0 && (
          <div className="slashmenu">
            {matches.map((c, i) => (
              <button
                type="button"
                key={c.insert}
                className={i === hi ? 'on' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => void applyPick(c)}
              >
                <strong>{c.insert.startsWith('/') ? c.insert : '/' + c.name}</strong>
                <span>{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {planOn && (kind === 'grok' || kind === 'claude') ? (
          <div className="modepill" role="status">
            <span className="modepill-tag">Plan mode</span>
            <span className="modepill-text">
              {kind === 'claude' ? 'Claude plans and does not edit.' : 'Grok plans first and asks before it edits.'}
            </span>
            <button type="button" className="linkish" onClick={() => runSlash('/plan off')}>
              Leave
            </button>
          </div>
        ) : null}
        {dropNote ? <div className="dropnote">{dropNote}</div> : null}
        {drops.length > 0 && (
          <div className="attachrow">
            {drops.map((a, i) => (
              <span className="chip" key={a.path + i}>
                {a.preview ? <img src={a.preview} alt="" /> : null}
                {a.name}
                <button type="button" className="tabx" onClick={() => removeDrop(i)} aria-label="Remove">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={sayBox}
          rows={1}
          value={say}
          onChange={(e) => {
            setSay(e.target.value)
            setHi(0)
          }}
          onPaste={(e) => {
            const files = collectFiles(e.clipboardData)
            if (files.length) {
              takeFiles(files)
              if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
              return
            }
            const text = e.clipboardData?.getData('text/plain') || ''
            if (!isBigPaste(text)) return
            e.preventDefault()
            const token = pasteToken(nextPasteNumber(pastesRef.current), pasteLines(text))
            keepPastes([...pastesRef.current, { token, text }])
            insertAtCaret(e.currentTarget, token)
          }}
          onKeyDown={(e) => {
            if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setHi((h) => (e.key === 'ArrowDown' ? Math.min(matches.length - 1, h + 1) : Math.max(0, h - 1)))
              return
            }
            if (e.key === 'Escape') {
              if (panel || resumeRows) {
                e.preventDefault()
                setPanel(null)
                setResumeRows(null)
                return
              }
              if (slashOn) {
                setSay('')
                return
              }
            }
            if (e.key === 'Enter') {
              if (enterSends && !e.shiftKey) {
                e.preventDefault()
                void send()
              } else if (!enterSends && e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }
          }}
          placeholder={
            busy
              ? queue.length
                ? 'Enter queues. Empty Enter sends the next one.'
                : 'Working. Enter queues a follow-up.'
              : showPower
                ? 'Message, drop a file, or / for commands'
                : 'Ask about this folder'
          }
        />
        <button className="ghost" type="button" onClick={() => void pickAttach()} title="Attach">
          Attach
        </button>
        {busy ? (
          <>
            <button className="primary" type="button" onClick={() => void send()}>
              {say.trim() || drops.length ? 'Queue' : queue.length ? 'Send now' : 'Queue'}
            </button>
            <button className="ghost" type="button" onClick={() => void stop()}>
              Stop
            </button>
          </>
        ) : (
          <button className="primary" type="button" onClick={() => void send()}>
            Send
          </button>
        )}
        {livePastes(say, pastes).length > 0 && (
          <div className="attachrow pasterow">
            {livePastes(say, pastes).map((p) => {
              const lines = pasteLines(p.text)
              return (
                <span className="chip paste-chip" key={p.token} title={p.token}>
                  <span className="paste-chip-label">
                    Pasted text {/#\d+/.exec(p.token)?.[0]} · {pasteSize(p.text)} · {lines} {lines === 1 ? 'line' : 'lines'}
                  </span>
                  <button type="button" className="linkish" onClick={() => expandPaste(p)}>
                    Expand
                  </button>
                  <button type="button" className="tabx" onClick={() => dropPaste(p)} aria-label="Remove paste">
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const KINDS: { id: AiKind; name: string }[] = [
  { id: 'grok', name: 'Grok' },
  { id: 'claude', name: 'Claude' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'gpt', name: 'ChatGPT' }
]

export function TerminalWorkspace({
  session: s,
  railOpen,
  setRailOpen,
  libraryAsk
}: {
  session: Session
  railOpen: boolean
  setRailOpen: (v: boolean) => void
  /** Bumped by Settings → See files to open the stored-file library tab. */
  libraryAsk?: number
}) {
  const setupKind = (s.ai || 'grok') as AiKind
  const [cwd, setCwd] = useState(s.brainPath || '')
  const [pick, setPick] = useState<null | 'model' | 'effort' | 'speed' | 'folder' | 'agentMode'>(null)
  const [modelsByKind, setModelsByKind] = useState<Partial<Record<AiKind, Cap[]>>>({})
  const [explorerW, setExplorerW] = useState(() => widthPref('brain-explorer-w', 220))
  const [refsW, setRefsW] = useState(() => widthPref('brain-refs-w', 260))
  const [recents, setRecents] = useState<{ path: string; name: string; watching?: boolean }[]>([])
  const [busyTabs, setBusyTabs] = useState<Record<string, boolean>>({})
  function freshTab(): Tab {
    return {
      id: nid(),
      type: 'chat',
      kind: setupKind,
      mode: 'chat',
      title: label(setupKind),
      sessionId: crypto.randomUUID(),
      model: setupKind === 'claude' ? CLAUDE_DEFAULT_MODEL : undefined,
      effort: defaultEffort(setupKind),
      agentMode: setupKind === 'cursor' ? 'agent' : undefined
    }
  }
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const tabsRef = useRef<Tab[]>([])
  const activeRef = useRef('')
  tabsRef.current = tabs
  activeRef.current = active
  const [filesByTab, setFilesByTab] = useState<Record<string, FileHit[]>>({})
  /** A Factory tab's rail: what its run is doing. Missing until the run starts. */
  const [activityByTab, setActivityByTab] = useState<Record<string, Activity | null>>({})
  const [filesOpen, setFilesOpen] = useState(true)
  const [picker, setPicker] = useState(false)
  const [pausedRuns, setPausedRuns] = useState<{ id: string; title: string; workRepo: string }[]>([])
  useEffect(() => {
    if (!picker) return
    let live = true
    void window.brain.factory
      .list()
      .then((rows) => {
        if (!live || !Array.isArray(rows)) return
        const open = new Set(tabsRef.current.map((t) => t.runId).filter(Boolean))
        setPausedRuns(rows.filter((r) => (r.phase === 'paused' || r.phase === 'failed' || r.phase === 'upgrade') && !open.has(r.id)))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [picker])
  const [closingId, setClosingId] = useState<string | null>(null)
  const [deskCloseId, setDeskCloseId] = useState<string | null>(null)
  const [deskRail, setDeskRail] = useState<HTMLElement | null>(null)

  const [detected, setDetected] = useState<Partial<Record<AiKind, boolean>>>({})
  const [kids, setKids] = useState<Record<string, FileNode[]>>({})
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const refsList = useRef<HTMLUListElement>(null)
  const [lastChatId, setLastChatId] = useState('')
  /** Always true. Model and Effort stay visible. Do not hide them. */
  const [powerPickers, setPowerPickers] = useState(true)
  const [transcripts, setTranscripts] = useState<Record<string, Msg[]>>({})
  const [contextByTab, setContextByTab] = useState<Record<string, { used?: number; total?: number; percent?: number }>>({})
  const [hydrated, setHydrated] = useState(false)
  const [hydratedCwd, setHydratedCwd] = useState('')
  const saveRef = useRef({ cwd: '', active: '', tabs: [] as Tab[], transcripts: {} as Record<string, Msg[]> })

  const tab = tabs.find((t) => t.id === active) || tabs[0]
  const chatId = tab?.type === 'chat' ? tab.id : lastChatId
  const chatTab = tabs.find((t) => t.id === chatId)
  // A Factory tab shows its own run's files; Chat tabs (and everything else) show the last chat's.
  const filesId = tab?.type === 'factory' ? tab.id : chatId
  const hits = filesByTab[filesId] || []
  const deskOn = tab?.type === 'desk'
  const railActivity = deskOn ? null : railFor(tab, lastChatId, activityByTab)
  const folderName = cwd.split('/').filter(Boolean).pop() || 'Agency Brain'
  const modelChoices = cliModels(
    chatTab?.kind,
    chatTab?.models && chatTab.models.length ? chatTab.models : modelsByKind[chatTab?.kind || 'grok']
  )
  const ctx = contextByTab[chatId || '']
  const effortList = chatTab?.efforts?.length ? chatTab.efforts : fallbackEfforts(chatTab?.kind)
  const showEffort = !!(chatTab?.efforts?.length || (chatTab?.kind && chatTab.kind !== 'cursor' && fallbackEfforts(chatTab.kind).length))
  const folderRow: SessionRow = {
    key: 'folder',
    label: 'Folder',
    value: folderName,
    title: cwd,
    choices: recents.map((r) => ({ id: r.path, label: `${r.name}${r.watching ? ' · watching' : ''}`, on: r.path === cwd })),
    onChoose: (path: string) => void useFolder(path),
    extra: { label: 'Choose folder…', onClick: () => void pickFolder() }
  }
  const sessionRows: SessionRow[] = deskOn
    ? [folderRow]
    : [
    ...(powerPickers
      ? [
          {
            key: 'model',
            label: 'Model',
            value: prettyModel(chatTab?.model, chatTab?.kind, modelChoices),
            choices: modelChoices.map((m) => ({ id: m.id, label: m.label, on: m.id === chatTab?.model || m.label === chatTab?.model })),
            onChoose: setChatModel,
            empty: chatTab?.models ? 'No models for this CLI.' : 'Loading models…'
          },
          ...(showEffort
            ? [
                {
                  key: 'effort',
                  label: 'Effort',
                  value: prettyEffort(chatTab?.effort, chatTab?.kind),
                  choices: effortList.map((e) => ({ id: e.id, label: e.label, on: normalizeEffort(e.id) === normalizeEffort(chatTab?.effort) })),
                  onChoose: setChatEffort
                }
              ]
            : []),
          ...(chatTab?.speeds?.length
            ? [
                {
                  key: 'speed',
                  label: 'Speed',
                  value: prettySpeed(chatTab.speed, chatTab.speeds),
                  choices: chatTab.speeds.map((x) => ({ id: x.id, label: x.label, on: x.id === chatTab.speed })),
                  onChoose: setChatSpeed
                }
              ]
            : []),
          ...(chatTab?.agentModes?.length
            ? [
                {
                  key: 'agentMode',
                  label: 'Mode',
                  value: chatTab.agentModes.find((m) => m.id === chatTab.agentMode)?.label || chatTab.agentMode || 'Agent',
                  choices: chatTab.agentModes.map((m) => ({ id: m.id, label: m.label, on: m.id === chatTab.agentMode })),
                  onChoose: setChatAgentMode
                }
              ]
            : [])
        ]
      : []),
    ...(ctx && (ctx.percent != null || ctx.used)
      ? [{ key: 'context', label: 'Context', value: ctx.percent != null ? `${ctx.percent}%` : `${Math.round((ctx.used || 0) / 1000)}k tokens` }]
      : []),
    folderRow
  ]

  useEffect(() => {
    if (s.brainPath && s.brainPath !== cwd) setCwd(s.brainPath)
  }, [s.brainPath])

  const libraryDone = useRef(0)
  useEffect(() => {
    if (!libraryAsk || !hydrated || libraryDone.current === libraryAsk) return
    libraryDone.current = libraryAsk
    addLibrary()
  }, [libraryAsk, hydrated])

  useEffect(() => {
    if (!closingId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setClosingId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closingId])

  useEffect(() => {
    if (!cwd) return
    let live = true
    const wanted = cwd
    setHydrated(false)
    setHydratedCwd('')
    void window.brain.chat
      .loadState(wanted)
      .then(async (raw) => {
        if (!live) return
        const saved = raw as {
          cwd?: string
          active?: string
          tabs?: Tab[]
          messages?: Record<string, Msg[]>
        } | null
        if (saved && sameCwd(saved.cwd || '', wanted) && Array.isArray(saved.tabs) && saved.tabs.length) {
          setTabs(
            saved.tabs.map((t) => ({
              ...t,
              model: t.kind === 'claude' ? t.model || CLAUDE_DEFAULT_MODEL : t.model,
              effort: hydrateEffort(t.kind, t.effort)
            }))
          )
          setActive(saved.active || saved.tabs[0].id)
          setLastChatId(saved.tabs.find((t) => t.type === 'chat')?.id || saved.tabs[0].id)
          setTranscripts(saved.messages || {})
        } else {
          const t = freshTab()
          let opening: Msg[] | null = null
          try {
            const welcome = await window.brain.chat.firstWelcome(wanted)
            if (welcome?.show && welcome.text) opening = [{ who: 'brain', text: welcome.text }]
          } catch {
            opening = null
          }
          if (!live) return
          setTabs([t])
          setActive(t.id)
          setLastChatId(t.id)
          setTranscripts(opening ? { [t.id]: opening } : {})
        }
      })
      .catch(() => {
        if (!live) return
        const t = freshTab()
        setTabs([t])
        setActive(t.id)
        setLastChatId(t.id)
        setTranscripts({})
      })
      .finally(() => {
        if (!live) return
        setHydratedCwd(wanted)
        setHydrated(true)
      })
    return () => {
      live = false
      const s = saveRef.current
      if (s.cwd) {
        window.brain.chat.saveStateSync({
          cwd: s.cwd,
          active: s.active,
          tabs: s.tabs.map(savedTab),
          messages: s.transcripts
        })
      }
    }
  }, [cwd])

  useEffect(() => {
    if (!hydrated || !cwd || hydratedCwd !== cwd) return
    saveRef.current = { cwd, active, tabs, transcripts }
    const payload = {
      cwd,
      active,
      tabs: tabs.map(savedTab),
      messages: transcripts
    }
    const t = window.setTimeout(() => {
      void window.brain.chat.saveState(payload)
    }, 500)
    return () => window.clearTimeout(t)
  }, [hydrated, hydratedCwd, cwd, active, tabs, transcripts])

  useEffect(() => {
    return window.brain.chat.onWillQuit(() => {
      const s = saveRef.current
      if (s.cwd) {
        window.brain.chat.saveStateSync({
          cwd: s.cwd,
          active: s.active,
          tabs: s.tabs.map(savedTab),
          messages: s.transcripts
        })
      }
      window.brain.chat.flushDone()
    })
  }, [])

  useEffect(() => {
    window.brain.ai.detect().then(setDetected).catch(() => {})
    void window.brain.files.recents().then(setRecents).catch(() => {})
    if (!cwd) return
    window.brain.files
      .list(cwd, cwd)
      .then((rows) => setKids({ [cwd]: rows }))
      .catch(() => setKids({}))
    setOpenDirs({})
  }, [cwd])

  useEffect(() => {
    const kind = (chatTab?.kind || 'grok') as AiKind
    const tabId = chatTab?.id
    if (!cwd) return
    let live = true
    window.brain.slash
      .list(cwd, kind)
      .then((r) => {
        if (!live) return
        const listed = cliModels(kind, r.models)
        setModelsByKind((m) => ({ ...m, [kind]: listed }))
        if (!tabId) return
        setTabs((all) =>
          all.map((x) => {
            if (x.id !== tabId || x.kind !== kind || x.modelsLive) return x
            const nextModels = listed.length ? listed : cliModels(x.kind, x.models)
            return {
              ...x,
              models: nextModels,
              model: x.kind === 'claude' ? claudeModelOnList(x.model, nextModels) : modelOnList(x.model, nextModels)
            }
          })
        )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd, chatTab?.kind, chatTab?.id])

  useEffect(() => {
    if (tab?.type === 'chat') setLastChatId(tab.id)
  }, [tab?.id, tab?.type])

  useEffect(() => {
    const el = refsList.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hits, chatId])

  useEffect(() => {
    if (!pick) return
    const close = () => setPick(null)
    const t = window.setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', close)
    }
  }, [pick])

  function dragWidth(
    which: 'explorer' | 'refs',
    e: { clientX: number; preventDefault: () => void },
    startW: number,
    setW: (n: number) => void
  ) {
    e.preventDefault()
    const startX = e.clientX
    let latest = startW
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      latest = Math.max(160, Math.min(520, which === 'explorer' ? startW + dx : startW - dx))
      setW(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      localStorage.setItem(which === 'explorer' ? 'brain-explorer-w' : 'brain-refs-w', String(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  async function saveOpenFile(tab: Tab) {
    if (!tab.path) return
    try {
      await window.brain.files.write(cwd, tab.path, tab.text || '')
      setTabs((all) =>
        all.map((x) =>
          x.id === tab.id
            ? { ...x, dirty: false, html: tab.fileKind === 'md' ? mdToHtml(tab.text || '') : x.html }
            : x
        )
      )
    } catch {
      setTabs((all) =>
        all.map((x) => (x.id === tab.id ? { ...x, title: `${tab.title.split(' · ')[0]} · not saved` } : x))
      )
    }
  }

  async function openFile(abs: string) {
    const existing = tabs.find((t) => t.type === 'file' && t.path === abs)
    if (existing) {
      setActive(existing.id)
      return
    }
    const id = nid()
    const title = abs.split('/').pop() || 'file'
    try {
      const r = await window.brain.files.read(cwd, abs)
      if (r.kind === 'media') {
        setTabs((t) => [
          ...t,
          {
            id,
            type: 'file',
            title: r.title || r.name,
            path: abs,
            fileKind: 'media',
            mediaId: r.mediaId,
            mediaTitle: r.title,
            mediaMime: r.mime,
            mediaBytes: r.bytes,
            text: r.text
          }
        ])
        setActive(id)
        return
      }
      let html = ''
      let url = ''
      if (r.kind === 'html') url = await window.brain.files.fileUrl(cwd, abs)
      else {
        const esc = r.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
        html = r.kind === 'md' ? mdToHtml(r.text) : `<pre>${esc}</pre>`
      }
      setTabs((t) => [...t, { id, type: 'file', title: r.name, path: abs, fileKind: r.kind, html, url, text: r.text }])
      setActive(id)
    } catch (e) {
      const msg = String((e as Error).message || e)
      setTabs((t) => [
        ...t,
        {
          id,
          type: 'file',
          title,
          path: abs,
          fileKind: 'text',
          html: `<p>${msg}</p>`
        }
      ])
      setActive(id)
    }
  }

  function setMode(mode: Mode) {
    setTabs((all) => all.map((t) => (t.id === active ? { ...t, mode } : t)))
  }

  function addTab(kind: AiKind, copied?: Msg[], resumeId?: string, tabId?: string) {
    const id = tabId || nid()
    if (tabId && tabsRef.current.some((t) => t.id === tabId)) {
      setActive(tabId)
      setPicker(false)
      return
    }
    setTabs((t) => [
      ...t,
      {
        id,
        type: 'chat',
        kind,
        mode: 'chat',
        title: label(kind),
        sessionId: crypto.randomUUID(),
        cliSessionId: resumeId,
        model: kind === 'claude' ? CLAUDE_DEFAULT_MODEL : undefined,
        effort: defaultEffort(kind),
        agentMode: kind === 'cursor' ? 'agent' : undefined
      }
    ])
    if (copied?.length) setTranscripts((m) => ({ ...m, [id]: copied }))
    setActive(id)
    setPicker(false)
  }

  function addTerm() {
    const id = nid()
    const n = tabsRef.current.filter((t) => t.type === 'term').length + 1
    setTabs((t) => [...t, { id, type: 'term', title: n === 1 ? 'Terminal' : `Terminal ${n}` }])
    setActive(id)
    setPicker(false)
  }

  function addFactory(runId?: string) {
    const open = runId ? tabsRef.current.find((t) => t.type === 'factory' && t.runId === runId) : undefined
    if (open) {
      setActive(open.id)
      setPicker(false)
      return
    }
    const id = nid()
    setTabs((t) => [...t, { id, type: 'factory', title: 'Factory', runId }])
    setActive(id)
    setPicker(false)
  }

  function addDesk() {
    const id = nid()
    setTabs((t) => [...t, { id, type: 'desk', title: 'Desk' }])
    setActive(id)
    setPicker(false)
  }

  function addLibrary() {
    const open = tabsRef.current.find((t) => t.type === 'library')
    if (open) {
      setActive(open.id)
      return
    }
    const id = nid()
    setTabs((t) => [...t, { id, type: 'library', title: 'Stored files' }])
    setActive(id)
  }

  function openStored(row: MediaLibraryFile) {
    const open = tabsRef.current.find((t) => t.type === 'file' && t.fileKind === 'media' && t.mediaId === row.id)
    if (open) {
      setActive(open.id)
      return
    }
    const id = nid()
    const title = row.title || 'Untitled'
    setTabs((t) => [
      ...t,
      {
        id,
        type: 'file',
        title,
        fileKind: 'media',
        mediaId: row.id,
        mediaTitle: title,
        mediaMime: row.mime,
        mediaBytes: row.bytes
      }
    ])
    setActive(id)
  }

  function dropTab(id: string) {
    setClosingId(null)
    const closing = tabsRef.current.find((t) => t.id === id)
    // Closing a Factory tab pauses its run; the lock and record stay until Abandon.
    if (closing?.type === 'factory' && closing.runId) void window.brain.factory.detach(closing.runId)
    const next = tabsRef.current.filter((t) => t.id !== id)
    setTabs(next)
    if (next.length === 0) setActive('')
    else if (activeRef.current === id) setActive(next[next.length - 1].id)
    void window.brain.pty.kill(id)
    void window.brain.chat.close(id)
  }

  function closeTab(id: string) {
    const t = tabsRef.current.find((x) => x.id === id)
    if (t?.type === 'desk') {
      setActive(id)
      setDeskCloseId(id)
      return
    }
    setClosingId(id)
  }

  function keepTab() {
    setClosingId(null)
  }

  function confirmCloseTab() {
    if (closingId) dropTab(closingId)
  }

  const addTabRef = useRef(addTab)
  const dropTabRef = useRef(dropTab)
  addTabRef.current = addTab
  dropTabRef.current = dropTab

  useEffect(() => {
    return window.brain.phone.onTab((ev) => {
      const kind: AiKind =
        ev.kind === 'claude' || ev.kind === 'gpt' || ev.kind === 'cursor' || ev.kind === 'grok' ? ev.kind : 'grok'
      if (ev.op === 'new' && ev.id) addTabRef.current(kind, undefined, undefined, ev.id)
      if (ev.op === 'close' && ev.id) dropTabRef.current(ev.id)
    })
  }, [])

  function onActivity(id: string, activity: Activity | null) {
    setActivityByTab((m) => (m[id] === activity ? m : { ...m, [id]: activity }))
  }

  function onFiles(id: string, files: FileHit[]) {
    setFilesByTab((m) => ({ ...m, [id]: files }))
  }

  function setChatModel(id: string) {
    if (!chatId) return
    setTabs((all) => all.map((x) => (x.id === chatId ? { ...x, model: id } : x)))
    setPick(null)
  }

  function setChatEffort(id: string) {
    if (!chatId) return
    setTabs((all) => all.map((x) => (x.id === chatId ? { ...x, effort: id } : x)))
    setPick(null)
  }

  function setChatSpeed(id: string) {
    if (!chatId) return
    setTabs((all) => all.map((x) => (x.id === chatId ? { ...x, speed: id } : x)))
    setPick(null)
  }

  function setChatAgentMode(id: string) {
    if (!chatId) return
    setTabs((all) => all.map((x) => (x.id === chatId ? { ...x, agentMode: id } : x)))
    setPick(null)
  }

  async function useFolder(path: string) {
    const r = await window.brain.files.remember(path)
    setCwd(r.path)
    setKids({})
    setPick(null)
    void window.brain.files.recents().then(setRecents).catch(() => {})
  }

  async function pickFolder() {
    const r = await window.brain.files.pickFolder()
    if (!r) {
      setPick(null)
      return
    }
    setCwd(r.path)
    setKids({})
    setPick(null)
    void window.brain.files.recents().then(setRecents).catch(() => {})
  }

  function commitRename() {
    if (editId && editTitle.trim()) {
      setTabs((all) => all.map((t) => (t.id === editId ? { ...t, title: editTitle.trim() } : t)))
    }
    setEditId(null)
  }

  async function toggleDir(p: string) {
    const willOpen = !openDirs[p]
    setOpenDirs((d) => ({ ...d, [p]: willOpen }))
    if (willOpen && !kids[p]) {
      const rows = await window.brain.files.list(cwd, p)
      setKids((k) => ({ ...k, [p]: rows }))
    }
  }

  function turnHit(path: string, isDir: boolean) {
    const a = path.replace(/\\/g, '/').replace(/\/$/, '')
    const matches = hits.filter((h) => {
      const b = h.path.replace(/\\/g, '/').replace(/\/$/, '')
      if (isDir) return b === a || b.startsWith(a + '/')
      return a === b || b.endsWith('/' + path.replace(/\\/g, '/').split('/').pop())
    })
    if (!matches.length) return null
    return matches.find((h) => h.live) || matches[0]
  }

  function renderTree(dir: string, depth = 0): ReactNode {
    return (kids[dir] || []).map((n) => {
      const open = Boolean(n.dir && openDirs[n.path])
      const hit = turnHit(n.path, n.dir)
      return (
        <div key={n.path} className="fnode" style={{ paddingLeft: 8 + depth * 10 }}>
          {n.dir ? (
            <button
              type="button"
              className={`flink${hit ? ' turn' : ''}${hit?.live ? ' live' : ''}`}
              onClick={() => void toggleDir(n.path)}
            >
              {open ? '▾' : '▸'} {n.name}
            </button>
          ) : (
            <button
              type="button"
              className={`flink${hit ? ' turn' : ''}${hit?.live ? ' live' : ''}`}
              onClick={() => void openFile(n.path)}
            >
              {n.name}
            </button>
          )}
          {n.dir && open ? renderTree(n.path, depth + 1) : null}
        </div>
      )
    })
  }

  return (
    <div className={`workspace ${filesOpen ? '' : 'files-off'} ${railOpen ? '' : 'rail-off'}`}>
      {closingId ? (
        <div className="tab-close">
          <div className="tab-close-card" role="alertdialog" aria-labelledby="tab-close-title">
            <h3 id="tab-close-title">Are you sure you want to close this tab?</h3>
            <p>This chat or terminal will leave the window.</p>
            <div className="actions">
              <button className="primary" type="button" onClick={confirmCloseTab}>
                Close tab
              </button>
              <button className="ghost" type="button" onClick={keepTab}>
                Keep it
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="tabbar">
        <button type="button" className="edgebtn" onClick={() => setRailOpen(!railOpen)} title={railOpen ? 'Hide files' : 'Show files'}>
          {railOpen ? '‹' : '›'}
        </button>
        <div className="tablist">
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active ? 'on' : ''} ${busyTabs[t.id] ? 'working' : ''}`}>
              {editId === t.id ? (
                <input
                  className="tabrename"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditId(null)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="tabname"
                  onClick={() => setActive(t.id)}
                  onDoubleClick={() => {
                    setEditId(t.id)
                    setEditTitle(t.title)
                  }}
                >
                  {busyTabs[t.id] ? <span className="wheel tab-wheel" aria-hidden="true" /> : null}
                  {t.title}
                </button>
              )}
              <button type="button" className="tabx" onClick={() => closeTab(t.id)} aria-label="Close tab">
                  ×
                </button>
            </div>
          ))}
          <button type="button" className="tabadd" onClick={() => setPicker((p) => !p)} aria-label="New session">
            +
          </button>
        </div>
        <button type="button" className="edgebtn" onClick={() => setFilesOpen(!filesOpen)} title={filesOpen ? 'Hide right sidebar' : 'Show right sidebar'}>
          {filesOpen ? '›' : '‹'}
        </button>
      </div>
      {picker && (
        <div className="picker">
          <span className="tiny">New chat, Desk, Factory, or a terminal in this window. Terminal is a shell, not the AI.</span>
          {KINDS.map((k) => (
            <div key={k.id} className="picker-row">
              <button type="button" className="ghost" disabled={detected[k.id] === false} onClick={() => addTab(k.id)}>
                {k.name}
              </button>
              {detected[k.id] === false && <span className="tiny">not installed</span>}
            </div>
          ))}
          <div className="picker-row">
            <button type="button" className="ghost" onClick={() => addTerm()}>
              Terminal
            </button>
          </div>
          <div className="picker-row">
            <button type="button" className="ghost" onClick={() => addDesk()}>
              Desk
            </button>
          </div>
          <div className="picker-row">
            <button type="button" className="ghost" onClick={() => addFactory()}>
              Factory
            </button>
          </div>
          {pausedRuns.length ? (
            <div className="picker-row picker-runs">
              <span className="tiny">Paused runs</span>
              {pausedRuns.map((r) => (
                <button key={r.id} type="button" className="ghost" onClick={() => addFactory(r.id)} title={r.workRepo}>
                  {r.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      <div
        className="chatrow"
        style={{
          gridTemplateColumns: `${railOpen ? explorerW : 0}px minmax(0, 1fr) ${filesOpen ? refsW : 0}px`
        }}
      >
        <aside className="explorer">
          <h2>
            <button
              type="button"
              className="folderpick"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setPick((p) => (p === 'folder' ? null : 'folder'))}
              title={cwd}
            >
              {folderName}
            </button>
          </h2>
          <div className="ftree">{renderTree(cwd)}</div>
          <AwayBlock cwd={cwd} hits={hits} />
          {railOpen ? (
            <button
              type="button"
              className="sidegrip"
              aria-label="Resize files"
              onPointerDown={(e) => dragWidth('explorer', e, explorerW, setExplorerW)}
            />
          ) : null}
        </aside>
        <div className="stage">
          {tabs.length === 0 ? (
            <div className="stage-empty">
              <p>No tabs open.</p>
              <p className="tiny">Use + to start a chat or a terminal.</p>
            </div>
          ) : null}
          {hydrated && hydratedCwd === cwd &&
            tabs
              .filter((t) => t.type === 'chat')
              .map((t) => (
                <ChatPane
                  key={'c' + t.id}
                  id={t.id}
                  kind={t.kind || 'grok'}
                  cwd={cwd}
                  sessionId={t.sessionId || t.id}
                  resumeId={t.cliSessionId}
                  model={t.model}
                  effort={t.effort}
                  speed={t.speed}
                  agentMode={t.agentMode}
                  alwaysApprove={t.alwaysApprove}
                  active={t.id === active}
                  greeting={`You're in ${folderName}. Ask a question. I'll use the files in this folder.`}
                  initialMessages={transcripts[t.id]}
                  onFiles={onFiles}
                  onNew={() => addTab(t.kind || 'grok')}
                  onModel={(m) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, model: m } : x)))}
                  onEffort={(e) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, effort: e } : x)))}
                  onCaps={(c) =>
                    setTabs((all) =>
                      all.map((x) =>
                        x.id === t.id
                          ? {
                              ...x,
                              model:
                                x.kind === 'claude'
                                  ? claudeModelOnList(c.model || x.model, cliModels(x.kind, c.models ?? x.models))
                                  : modelOnList(c.model || x.model, cliModels(x.kind, c.models ?? x.models)) ||
                                    modelOnList(x.model, cliModels(x.kind, c.models ?? x.models)),
                              effort:
                                normalizeEffort(c.effort) ||
                                hydrateEffort(x.kind, x.effort) ||
                                defaultEffort(x.kind),
                              efforts:
                                c.efforts && c.efforts.length ? c.efforts : x.efforts && x.efforts.length ? x.efforts : fallbackEfforts(x.kind),
                              speeds: Array.isArray(c.speeds) ? c.speeds : x.speeds,
                              speed: c.speed || x.speed,
                              agentMode: c.agentMode || x.agentMode,
                              cliSessionId: c.sessionId || x.cliSessionId,
                              models: c.models?.length ? cliModels(x.kind, c.models) : cliModels(x.kind, x.models),
                              modelsLive: Boolean(c.models?.length) || x.modelsLive,
                              agentModes: c.agentModes ?? x.agentModes
                            }
                          : x
                      )
                    )
                  }
                  onTranscript={(id, msgs) => setTranscripts((m) => ({ ...m, [id]: msgs }))}
                  onContext={(id, ctx) => setContextByTab((m) => ({ ...m, [id]: ctx }))}
                  onApprove={(v) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, alwaysApprove: v } : x)))}
                  onRename={(title) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, title } : x)))}
                  onResume={(sessionId) => {
                    setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, cliSessionId: sessionId } : x)))
                  }}
                  onFork={(msgs, sessionId) => addTab(t.kind || 'grok', msgs, sessionId)}
                  onAgentMode={(mode) => setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, agentMode: mode } : x)))}
                  onDelete={() => closeTab(t.id)}
                  onOpenTerm={() => addTerm()}
                  onBusy={(id, on) => setBusyTabs((m) => (m[id] === on ? m : { ...m, [id]: on }))}
                  onActivity={onActivity}
                  onPowerPickers={() => setPowerPickers(true)}
                />
              ))}
          {tabs
            .filter((t) => t.type === 'term')
            .map((t) => (
              <div key={t.id} className={`termwrap ${t.id === active ? 'on' : ''}`}>
                <TermPane id={t.id} cwd={cwd} active={t.id === active} />
              </div>
            ))}
          {tabs
            .filter((t) => t.type === 'factory')
            .map((t) => (
              <FactoryPane
                key={'f' + t.id}
                id={t.id}
                runId={t.runId}
                cwd={cwd}
                active={t.id === active}
                onFiles={onFiles}
                onActivity={onActivity}
                onRun={(runId, title) =>
                  setTabs((all) =>
                    all.map((x) => (x.id === t.id ? { ...x, runId, title: title.length > 24 ? title.slice(0, 22) + '...' : title } : x))
                  )
                }
              />
            ))}
          {tabs
            .filter((t) => t.type === 'desk')
            .map((t) => (
              <DeskPane
                key={'d' + t.id}
                id={t.id}
                cwd={cwd}
                active={t.id === active}
                rail={t.id === active ? deskRail : null}
                closing={deskCloseId === t.id}
                onClosed={() => {
                  setDeskCloseId(null)
                  dropTab(t.id)
                }}
                onKeep={() => setDeskCloseId(null)}
                onOpenFile={(p) => void openFile(p)}
                modelsFor={deskModels}
                effortsFor={deskEfforts}
              />
            ))}
          {tabs
            .filter((t) => t.type === 'library' && t.id === active)
            .map((t) => (
              <div key={t.id} className="filetab">
                <MediaLibraryPane folder={cwd} askSeq={libraryAsk} onOpen={openStored} />
              </div>
            ))}
          {tabs
            .filter((t) => t.type === 'file' && t.id === active)
            .map((t) => (
              <div key={t.id} className="filetab">
                {t.fileKind === 'media' ? (
                  <MediaFilePane
                    tab={t}
                    setNote={(note) =>
                      setTabs((all) => all.map((x) => (x.id === t.id ? { ...x, mediaNote: note } : x)))
                    }
                  />
                ) : (
                  <>
                    <div className="filetab-head">{t.title}</div>
                    {t.fileKind === 'html' && t.url ? (
                      <webview className="fileweb" src={t.url} allowpopups />
                    ) : (
                      <div className="fileedit">
                        <div className="fileedit-bar">
                          <button type="button" className="ghost" disabled={!t.dirty} onClick={() => void saveOpenFile(t)}>
                            Save
                          </button>
                          <span className="tiny">{t.dirty ? 'Unsaved' : 'Saved'}</span>
                        </div>
                        <textarea
                          className="fileedit-box"
                          value={t.text || ''}
                          spellCheck={false}
                          onChange={(e) =>
                            setTabs((all) =>
                              all.map((x) => (x.id === t.id ? { ...x, text: e.target.value, dirty: true } : x))
                            )
                          }
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
        </div>
        <aside className="refs">
          {filesOpen ? (
            <button
              type="button"
              className="sidegrip sidegrip-left"
              aria-label="Resize in use"
              onPointerDown={(e) => dragWidth('refs', e, refsW, setRefsW)}
            />
          ) : null}
          {railActivity ? (
            <ActivityRail
              activity={railActivity}
              onPush={railActivity.runId ? () => void window.brain.factory.publish(railActivity.runId || '') : undefined}
              openFile={{ open: (p) => void openFile(p), canOpen: (p) => !outsideProject(cwd, p) }}
            />
          ) : deskOn ? (
            <div className="desk-rail" ref={setDeskRail} />
          ) : (
            <>
          <h2>In use</h2>
          <ul className="looking looking-log" ref={refsList}>
            {hits.length === 0 && <li className="tiny">{tab?.type === 'factory' ? 'Nothing for this run yet.' : 'Nothing for this chat yet.'}</li>}
            {hits.map((h) => (
              <li key={h.path} className={h.live ? 'live' : ''}>
                {outsideProject(cwd, h.path) ? (
                  <span className="flink">{hitLabel(cwd, h.path)}</span>
                ) : (
                  <button type="button" className="flink" onClick={() => void openFile(h.path)}>
                    {hitLabel(cwd, h.path)}
                  </button>
                )}
              </li>
            ))}
          </ul>
            </>
          )}
          <SessionCard rows={sessionRows} open={pick} setOpen={(k) => setPick(k as typeof pick)} />
        </aside>
      </div>

    </div>
  )
}
