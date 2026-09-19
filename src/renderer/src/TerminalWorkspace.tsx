import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AiKind, Session } from '@shared/contracts'
import { mdToHtml, tidy, type FileHit } from './ptyChat'
import { WorldClocks } from './WorldClocks'
import { WorkPulse } from './WorkPulse'
import { SkinPane } from './skin/SkinPane'
import { SkinCard } from './skin/Registry'
import { skinPtyId } from './skin/SkinTerm'
import { specFromStreamEvent } from '../../shared/skin/from-events'

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
  who: 'me' | 'brain' | 'think' | 'sys' | 'plan' | 'err'
  text: string
  files?: Attach[]
  at?: number
  steps?: { title: string; status?: string }[]
}
type Queued = { id: string; text: string; files?: Attach[] }

function wantsStop(text: string): boolean {
  return /^\s*(please\s+)?(just\s+)?(stop|cancel|abort|never mind|nevermind|halt)\b/i.test(text)
}

function justStop(text: string): boolean {
  return /^\s*(please\s+)?(just\s+)?(stop|cancel|abort|never mind|nevermind|halt)\s*[.!]?\s*$/i.test(text)
}
type FileNode = { name: string; path: string; dir: boolean; kids?: FileNode[] }
type Cap = { id: string; label: string }
type SessionCmd = { name: string; description: string; hint?: string }

const SESSION_QUIET = new Set(['compact', 'rewind', 'undo', 'flush', 'dream', 'context', 'session-info'])

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
  cost: 'usage'
}

function slashLine(raw: string): string {
  const t = raw.trim()
  if (!t.startsWith('/')) return t
  const [cmd, ...rest] = t.slice(1).split(/\s+/)
  const name = SLASH_ALIAS[(cmd || '').toLowerCase()] || (cmd || '').toLowerCase()
  const arg = rest.join(' ')
  return arg ? `/${name} ${arg}` : `/${name}`
}

const APP_ONLY = new Set([
  'new',
  'clear',
  'delete',
  'help',
  'usage',
  'cost',
  'model',
  'm',
  'effort',
  'copy',
  'export',
  'quit',
  'exit',
  'rename',
  'title',
  'history',
  'resume',
  'fork',
  'login',
  'logout',
  'doctor',
  'terminal'
])

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
  type: 'chat' | 'file' | 'term'
  title: string
  kind?: AiKind
  mode?: Mode
  sessionId?: string
  model?: string
  effort?: string
  agentMode?: string
  models?: Cap[]
  efforts?: Cap[]
  agentModes?: Cap[]
  cliSessionId?: string
  alwaysApprove?: boolean
  path?: string
  fileKind?: string
  html?: string
  url?: string
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

function normalizeEffort(id?: string): string | undefined {
  if (!id) return undefined
  const k = id.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
  if (k === 'extra-high' || k === 'x-high' || k === 'extra') return 'xhigh'
  return k
}

function prettyEffort(id?: string): string {
  const k = normalizeEffort(id)
  if (!k) return 'Default'
  const map: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max'
  }
  return map[k] || k
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

function rel(root: string, abs: string): string {
  if (!root) return abs
  if (abs.startsWith(root)) {
    const r = abs.slice(root.length).replace(/^\//, '')
    return r || abs.split('/').pop() || abs
  }
  return abs.split('/').pop() || abs
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

function ChatPane({
  id,
  kind,
  cwd,
  sessionId,
  active,
  greeting,
  initialMessages,
  model,
  effort,
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
  onBusy
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
    agentMode?: string
    sessionId?: string
    models?: Cap[]
    efforts?: Cap[]
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
}) {
  const [messages, setMessages] = useState<Msg[]>(
    initialMessages && initialMessages.length ? initialMessages : [{ who: 'brain', text: greeting }]
  )
  const [say, setSay] = useState('')
  const [busy, setBusy] = useState(false)
  const [warming, setWarming] = useState(false)
  const [waitLabel, setWaitLabel] = useState('Working')
  const [waitSec, setWaitSec] = useState(0)
  const [cmds, setCmds] = useState<{ name: string; kind: 'builtin' | 'skill'; description: string }[]>([])
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [hi, setHi] = useState(0)
  const [panel, setPanel] = useState<{ title: string; body: string } | null>(null)
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  const [drops, setDrops] = useState<Attach[]>([])
  const [enterSends, setEnterSends] = useState(true)
  const [showTimes, setShowTimes] = useState(false)
  const [over, setOver] = useState(false)
  const [dropNote, setDropNote] = useState('')
  const [sessionCmds, setSessionCmds] = useState<SessionCmd[]>([])
  const [resumeRows, setResumeRows] = useState<{ id: string; title: string; updated: string }[] | null>(null)
  const ctxRef = useRef<{ used?: number; total?: number; percent?: number }>({})
  const dropsRef = useRef<Attach[]>([])
  const pendingDrops = useRef(Promise.resolve())
  const thread = useRef<HTMLDivElement>(null)
  const filesRef = useRef<FileHit[]>([])
  const turn = useRef({ think: false, answer: false })
  const [queue, setQueue] = useState<Queued[]>([])
  const queueRef = useRef<Queued[]>([])
  const [skinOn, setSkinOn] = useState(true)
  const [cliSid, setCliSid] = useState(resumeId || '')
  const [tuiGen, setTuiGen] = useState(0)
  const [peel, setPeel] = useState(false)
  const lastWarm = useRef('')
  const [permission, setPermission] = useState<{
    title?: string
    path?: string
    options?: { id: string; label: string }[]
    requestId?: string
  } | null>(null)
  const sendTextRef = useRef<(t: string, opts?: { cancel?: boolean; fromQueue?: boolean; files?: Attach[] }) => Promise<void>>(async () => {})
  const pinBottom = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const skipDrain = useRef(0)

  function writeQueue(next: Queued[]) {
    queueRef.current = next
    setQueue(next)
  }

  useEffect(() => {
    const off = window.brain.chat.onEvent((ev) => {
      if (ev.tabId !== id) return
      if (ev.kind === 'thought' && ev.data) {
        setWaitLabel('Thinking')
        const bit = ev.data
        setMessages((msgs) => {
          const next = [...msgs]
          const last = next[next.length - 1]
          if (turn.current.think && last && last.who === 'think') last.text += bit
          else {
            turn.current.think = true
            next.push({ who: 'think', text: bit })
          }
          return next
        })
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
      if (ev.kind === 'context') {
        ctxRef.current = { used: ev.used, total: ev.total, percent: ev.percent }
        onContext(id, { used: ev.used, total: ev.total, percent: ev.percent })
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
      if (ev.kind === 'status' && ev.data && ev.data.startsWith('work:')) {
        const label = ev.data.slice(5).trim()
        if (label) setWaitLabel(label)
      }
      if (ev.kind === 'permission') {
        setPermission({
          title: ev.title,
          path: ev.path,
          options: ev.options,
          requestId: ev.requestId
        })
      }
      if (ev.kind === 'file' && ev.path) {
        const hit = { path: ev.path, tool: ev.tool, live: true }
        const base = ev.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ev.path
        setWaitLabel(ev.tool ? `${ev.tool} · ${base}` : `Reading ${base}`)
        if (!filesRef.current.some((f) => f.path === hit.path)) {
          filesRef.current = [...filesRef.current, hit]
          onFiles(id, filesRef.current)
        }
      }
      if (ev.kind === 'done' || ev.kind === 'error') {
        setWaitLabel('Working')
        if (compactingRef.current && ev.kind === 'done') {
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
        compactingRef.current = false
        setCompacting(false)
        filesRef.current = filesRef.current.map((f) => ({ ...f, live: false }))
        onFiles(id, filesRef.current)
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
          void sendTextRef.current(nxt.text, { fromQueue: true, files: nxt.files })
          return
        }
        setBusy(false)
      }
    })
    return () => {
      off()
    }
  }, [id, greeting, onFiles])

  useEffect(() => {
    if (!pinBottom.current) return
    thread.current?.scrollTo(0, thread.current.scrollHeight)
  }, [messages, busy, queue, permission, skinOn])

  function onThreadScroll() {
    const el = thread.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinBottom.current = pinned
    setAtBottom(pinned)
  }

  const live = busy || compacting || warming

  useEffect(() => {
    if (!live) {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [live])

  useEffect(() => {
    onBusy(id, live)
    return () => onBusy(id, false)
  }, [id, live])

  useEffect(() => {
    onTranscript(id, messages)
  }, [messages, active])

  useEffect(() => {
    window.brain.slash.list(cwd, kind).then((r) => {
      setCmds(r.commands)
      setModels(r.models)
    }).catch(() => {})
  }, [cwd, kind])

  useEffect(() => {
    if (!cwd) return
    const key = [id, kind, cwd, model, effort, agentMode, resumeId].join('|')
    if (lastWarm.current === key) return
    lastWarm.current = key
    setWarming(true)
    setWaitLabel(`Starting ${kind === 'gpt' ? 'ChatGPT' : kind === 'cursor' ? 'Cursor' : kind === 'claude' ? 'Claude' : 'Grok'}`)
    void window.brain.chat
      .warm({ tabId: id, kind, cwd, model, effort, agentMode, resumeId })
      .then((r) => {
        if (r?.models?.length) setModels(r.models)
        if (r?.commands?.length) setSessionCmds(r.commands)
        if (r?.sessionId) setCliSid(r.sessionId)
        onCaps({
          model: r?.model,
          effort: r?.effort,
          agentMode: r?.agentMode,
          sessionId: r?.sessionId,
          models: r?.models,
          efforts: r?.efforts,
          agentModes: r?.agentModes
        })
      })
      .catch((e) => {
        setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
      })
      .finally(() => setWarming(false))
  }, [id, kind, cwd, model, effort, agentMode, resumeId])

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
    setCliSid(r.sessionId || sessionId)
    onResume(r.sessionId || sessionId)
  }

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

  function popup(title: string, body: string) {
    setPanel({ title, body })
  }

  async function sendSkinTerm(line: string) {
    const showing = peel
    setPeel(true)
    const ptyId = skinPtyId(id)
    const r = (await window.brain.pty.create({
      id: ptyId,
      cwd,
      kind,
      cols: 80,
      rows: 24
    })) as { reused?: boolean }
    const go = () => window.brain.pty.write(ptyId, line + '\r')
    if (showing && r?.reused) {
      await go()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      off()
      window.clearTimeout(timer)
      void go()
    }
    const off = window.brain.pty.onData((ev) => {
      if (ev.id === ptyId) finish()
    })
    const timer = window.setTimeout(finish, 2000)
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
      setMessages([{ who: 'brain', text: greeting }])
      filesRef.current = []
      onFiles(id, [])
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
      popup('Commands', menuCmds.map((c) => `/${c.name}  ${c.description}`).join('\n'))
      return true
    }
    if (name === 'usage' || name === 'cost') {
      void window.brain.slash.usage(cwd, kind).then((body) => popup('Usage', body))
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
    if (name === 'plan' && kind === 'cursor' && !arg) {
      onAgentMode('plan')
      note('Cursor mode is plan.')
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
      setMessages([{ who: 'brain', text: greeting }])
      filesRef.current = []
      onFiles(id, [])
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
      if (last) setSay(last.text)
      else note('No prompt to edit yet.')
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
      })
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
    const sessionHit = sessionCmds.find((c) => c.name === name)
    if (sessionHit && !APP_ONLY.has(name)) {
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

  function takeSlash(raw: string): boolean {
    if (runSlash(raw)) return true
    const t = raw.trim()
    if (!skinOn || !t.startsWith('/')) return false
    // Skin leftover `/` goes to the peel TUI, not ACP.
    void sendSkinTerm(slashLine(t))
    return true
  }

  function applyPick(pick: Pick) {
    if (pick.kind === 'arg') {
      setSay('')
      const raw = pick.insert.trim()
      if (!takeSlash(raw)) void sendText(slashLine(raw))
      return
    }
    if (pick.kind === 'skill') {
      setSay('')
      const line = '/' + pick.name
      if (!takeSlash(line)) void sendText(line)
      return
    }
    if (pick.insert.endsWith(' ')) {
      setSay(pick.insert)
      setHi(0)
      return
    }
    if (pick.kind === 'builtin') {
      setSay('')
      const line = '/' + pick.name
      if (!takeSlash(line)) void sendText(line)
      return
    }
    setSay('')
    const line = '/' + pick.name
    if (!takeSlash(line)) void sendText(line)
  }

  async function stop() {
    if (skinOn && peel) {
      await window.brain.pty.write(skinPtyId(id), '\x03')
      return
    }
    skipDrain.current += 1
    await window.brain.chat.stop(id)
    setBusy(false)
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
      applyPick(matches[hi])
      return
    }
    setSay('')
    const line = t.startsWith('/') ? slashLine(t) : t
    if (takeSlash(t)) return
    if (busy && wantsStop(line)) {
      await stop()
      if (justStop(line)) return
      await sendText(line)
      return
    }
    if (busy) {
      const attached = dropsRef.current
      dropsRef.current = []
      setDrops([])
      writeQueue([
        ...queueRef.current,
        { id: crypto.randomUUID(), text: line, files: attached.length ? attached : undefined }
      ])
      return
    }
    await sendText(line)
  }

  async function sendNow(qid: string) {
    const item = queueRef.current.find((q) => q.id === qid)
    if (!item) return
    writeQueue(queueRef.current.filter((q) => q.id !== qid))
    if (wantsStop(item.text) && busy) {
      await stop()
      if (!justStop(item.text)) await sendText(item.text, { fromQueue: true, files: item.files || [] })
      return
    }
    if (busy) {
      writeQueue([item, ...queueRef.current])
      return
    }
    await sendText(item.text, { fromQueue: true, files: item.files || [] })
  }

  function editQueued(qid: string) {
    const item = queueRef.current.find((q) => q.id === qid)
    if (!item) return
    writeQueue(queueRef.current.filter((q) => q.id !== qid))
    setSay(item.text)
    if (item.files?.length) {
      dropsRef.current = item.files
      setDrops(item.files)
    }
  }

  async function sendQuiet(t: string) {
    if (busy) {
      writeQueue([...queueRef.current, { id: crypto.randomUUID(), text: t }])
      return
    }
    setBusy(true)
    setWaitLabel('Working')
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
        system:
          'You are the brain on this computer. Answer in plain English. You may read and edit files in this folder. Do not dump tool names or keyboard shortcuts. Never change Google Ads unless the human clearly said yes. Never send external mail unless they said send.'
      })
    } catch (e) {
      setBusy(false)
      setCompacting(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
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
      onFiles(id, filesRef.current)
      return
    }
    let next = filesRef.current
    for (const h of hits) {
      const i = next.findIndex((f) => f.path === h.path)
      if (i < 0) next = [...next, { ...h, live: true }]
      else next = next.map((f, j) => (j === i ? { ...f, live: true } : f))
    }
    filesRef.current = next
    onFiles(id, next)
  }

  async function sendText(t: string, opts?: { cancel?: boolean; fromQueue?: boolean; files?: Attach[] }) {
    await pendingDrops.current
    if (skinOn && peel) {
      const attached = opts?.fromQueue ? opts.files || [] : opts?.files || dropsRef.current
      if (!opts?.fromQueue) {
        dropsRef.current = []
        setDrops([])
        setDropNote('')
      }
      const shown = attached.length ? `${t}${t ? '\n' : ''}${attached.map((a) => a.path).join('\n')}` : t
      if (shown) await window.brain.pty.write(skinPtyId(id), shown + '\r')
      return
    }
    if (opts?.cancel && busy) await stop()
    if (busy && !opts?.fromQueue && !opts?.cancel) {
      writeQueue([...queueRef.current, { id: crypto.randomUUID(), text: t, files: opts?.files }])
      return
    }
    filesRef.current = []
    onFiles(id, [])
    setBusy(true)
    setWaitLabel('Working')
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
    setMessages((m) => [...m, { who: 'me', text: shown, files: attached, at: Date.now() }])
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
        attachments: attached.map(({ path, name, mime }) => ({ path, name, mime })),
        system:
          'You are the brain on this computer. Answer in plain English. You may read and edit files in this folder. Do not dump tool names or keyboard shortcuts. Never change Google Ads unless the human clearly said yes. Never send external mail unless they said send.'
      })
    } catch (e) {
      setBusy(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
  }
  sendTextRef.current = sendText

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
          <pre className="cmdbody">{panel.body}</pre>
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
      <div className="skin-switch">
        <button type="button" className={skinOn ? 'on' : ''} onClick={() => setSkinOn(true)}>
          Skin
        </button>
        <button type="button" className={!skinOn ? 'on' : ''} onClick={() => setSkinOn(false)}>
          Chat
        </button>
      </div>
      {skinOn ? null : permission ? (
        <div className="skin-perm">
          <p className="skin-perm-title">{permission.title || 'Allow this?'}</p>
          {permission.path ? <p className="tiny">{permission.path}</p> : null}
          <div className="skin-perm-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                void window.brain.skin.decide(id, 'allowOnce')
                setPermission(null)
              }}
            >
              Allow
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                void window.brain.skin.decide(id, 'skip')
                setPermission(null)
              }}
            >
              Skip
            </button>
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
        queue={queue}
        permission={permission}
        threadRef={thread}
        onScroll={onThreadScroll}
        onPeel={setPeel}
        onFiles={mergeSkinFiles}
        onAction={(actionId, spec) => {
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
            if (name) void sendTextRef.current('/' + name)
          }
        }}
      />
      {!skinOn ? (
      <div className="thread" ref={thread} onScroll={onThreadScroll}>
        {messages.map((m, i) =>
          m.who === 'plan' && m.steps?.length ? (
            <ol className="skin-plan" key={i}>
              {m.steps.map((s, j) => (
                <li key={j}>
                  {s.title} {s.status ? <span className="tiny">{s.status}</span> : null}
                </li>
              ))}
            </ol>
          ) : m.who === 'err' && m.text ? (
            <SkinCard
              key={i}
              spec={specFromStreamEvent({ kind: 'error', data: m.text }) || { id: 'err-' + i, component: 'ErrorNotice', props: { text: m.text }, actions: [], source: 'error' }}
              onAction={(id) => {
                if (id === 'login') void window.brain.ai.login(kind)
              }}
            />
          ) : m.text || m.who === 'me' ? (
            <div
              className={`bubble ${m.who === 'me' ? 'me' : ''} ${m.who === 'think' ? 'think' : ''} ${m.who === 'brain' ? 'md' : ''}`}
              key={i}
            >
              {m.who === 'think' && (
                <div className={`think-label ${busy && messages[messages.length - 1] === m ? 'live' : ''}`}>
                  Thinking
                  {busy && messages[messages.length - 1] === m ? <span className="dots" /> : null}
                </div>
              )}
              {m.who === 'sys' && <div className="think-label">Command</div>}
              {m.who === 'brain' ? (
                <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(m.text) }} />
              ) : (
                <Rich text={m.text} />
              )}
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
                onClick={() => applyPick(c)}
              >
                <strong>{c.insert.startsWith('/') ? c.insert : '/' + c.name}</strong>
                <span>{c.description}</span>
              </button>
            ))}
          </div>
        )}
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
          rows={1}
          value={say}
          onChange={(e) => {
            setSay(e.target.value)
            setHi(0)
          }}
          onPaste={(e) => {
            const files = collectFiles(e.clipboardData)
            if (!files.length) return
            takeFiles(files)
            if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
          }}
          onKeyDown={(e) => {
            if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setHi((h) => (e.key === 'ArrowDown' ? Math.min(matches.length - 1, h + 1) : Math.max(0, h - 1)))
              return
            }
            if (e.key === 'Escape' && slashOn) {
              setSay('')
              return
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
              : 'Message, drop a file, or / for commands'
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
  showInvite,
  setShowInvite,
  railOpen,
  setRailOpen
}: {
  session: Session
  showInvite: boolean
  setShowInvite: (v: boolean) => void
  railOpen: boolean
  setRailOpen: (v: boolean) => void
}) {
  const setupKind = (s.ai || 'grok') as AiKind
  const [cwd, setCwd] = useState(s.brainPath || '')
  const [pick, setPick] = useState<null | 'model' | 'effort' | 'folder' | 'agentMode'>(null)
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
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
      effort: undefined,
      agentMode: setupKind === 'cursor' ? 'agent' : undefined
    }
  }
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [filesByTab, setFilesByTab] = useState<Record<string, FileHit[]>>({})
  const [filesOpen, setFilesOpen] = useState(true)
  const [picker, setPicker] = useState(false)

  const [detected, setDetected] = useState<Partial<Record<AiKind, boolean>>>({})
  const [kids, setKids] = useState<Record<string, FileNode[]>>({})
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const refsList = useRef<HTMLUListElement>(null)
  const [lastChatId, setLastChatId] = useState('')
  const [transcripts, setTranscripts] = useState<Record<string, Msg[]>>({})
  const [contextByTab, setContextByTab] = useState<Record<string, { used?: number; total?: number; percent?: number }>>({})
  const [hydrated, setHydrated] = useState(false)
  const [hydratedCwd, setHydratedCwd] = useState('')
  const saveRef = useRef({ cwd: '', active: '', tabs: [] as Tab[], transcripts: {} as Record<string, Msg[]> })

  const tab = tabs.find((t) => t.id === active) || tabs[0]
  const chatId = tab?.type === 'chat' ? tab.id : lastChatId
  const chatTab = tabs.find((t) => t.id === chatId)
  const hits = filesByTab[chatId] || []
  const folderName = cwd.split('/').filter(Boolean).pop() || 'Agency Brain'
  const modelChoices =
    chatTab?.models && chatTab.models.length
      ? chatTab.models
      : chatTab?.kind === 'gpt' || chatTab?.kind === 'cursor'
        ? []
        : models.length
          ? models
          : [{ id: 'grok-4.6', label: 'Grok 4.6' }]

  useEffect(() => {
    if (!cwd && s.brainPath) setCwd(s.brainPath)
  }, [s.brainPath, cwd])

  useEffect(() => {
    if (!cwd) return
    let live = true
    const wanted = cwd
    setHydrated(false)
    setHydratedCwd('')
    void window.brain.chat
      .loadState(wanted)
      .then((raw) => {
        if (!live) return
        const saved = raw as {
          cwd?: string
          active?: string
          tabs?: Tab[]
          messages?: Record<string, Msg[]>
        } | null
        if (saved?.cwd === wanted && Array.isArray(saved.tabs) && saved.tabs.length) {
          setTabs(
            saved.tabs.map((t) => ({
              ...t,
              effort: t.kind === 'cursor' || t.effort === 'high' ? undefined : t.effort
            }))
          )
          setActive(saved.active || saved.tabs[0].id)
          setLastChatId(saved.tabs.find((t) => t.type === 'chat')?.id || saved.tabs[0].id)
          if (saved.messages) setTranscripts(saved.messages)
        } else {
          const t = freshTab()
          setTabs([t])
          setActive(t.id)
          setLastChatId(t.id)
        }
      })
      .catch(() => {
        if (!live) return
        const t = freshTab()
        setTabs([t])
        setActive(t.id)
        setLastChatId(t.id)
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
          tabs: s.tabs.map((x) => ({
            id: x.id,
            type: x.type,
            title: x.title,
            kind: x.kind,
            mode: x.mode,
            model: x.model,
            effort: x.effort,
            agentMode: x.agentMode,
            cliSessionId: x.cliSessionId,
            path: x.path
          })),
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
      tabs: tabs.map((x) => ({
        id: x.id,
        type: x.type,
        title: x.title,
        kind: x.kind,
        mode: x.mode,
        model: x.model,
        effort: x.effort,
        agentMode: x.agentMode,
        cliSessionId: x.cliSessionId,
        path: x.path
      })),
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
          tabs: s.tabs.map((x) => ({
            id: x.id,
            type: x.type,
            title: x.title,
            kind: x.kind,
            mode: x.mode,
            model: x.model,
            effort: x.effort,
            agentMode: x.agentMode,
            cliSessionId: x.cliSessionId,
            path: x.path
          })),
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
    const kind = chatTab?.kind || 'grok'
    if (!cwd) return
    window.brain.slash
      .list(cwd, kind)
      .then((r) => setModels(r.models))
      .catch(() => {})
  }, [cwd, chatTab?.kind])

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
      let html = ''
      let url = ''
      if (r.kind === 'html') url = await window.brain.files.fileUrl(cwd, abs)
      else {
        const esc = r.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
        html = r.kind === 'md' ? mdToHtml(r.text) : `<pre>${esc}</pre>`
      }
      setTabs((t) => [...t, { id, type: 'file', title: r.name, path: abs, fileKind: r.kind, html, url }])
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

  function addTerm() {
    const id = nid()
    const n = tabs.filter((t) => t.type === 'term').length + 1
    setTabs((t) => [...t, { id, type: 'term', title: n === 1 ? 'Terminal' : `Terminal ${n}` }])
    setActive(id)
    setPicker(false)
  }

  function addTab(kind: AiKind, copied?: Msg[], resumeId?: string) {
    const id = nid()
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
        effort: undefined,
        agentMode: kind === 'cursor' ? 'agent' : undefined
      }
    ])
    if (copied?.length) setTranscripts((m) => ({ ...m, [id]: copied }))
    setActive(id)
    setPicker(false)
  }

  function closeTab(id: string) {
    if (tabs.length === 1) return
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (active === id) setActive(next[next.length - 1].id)
    void window.brain.pty.kill(id)
    void window.brain.chat.close(id)
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
              {tabs.length > 1 && (
                <button type="button" className="tabx" onClick={() => closeTab(t.id)} aria-label="Close tab">
                  ×
                </button>
              )}
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
          <span className="tiny">New chat, or a terminal in this window. Terminal is a shell, not the AI.</span>
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
        </div>
      )}
      <div className="chatrow">
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
          {s.path !== 'join' && (
            <div className="invite-dock">
              <button className="primary rail-btn" type="button" onClick={() => setShowInvite(true)}>
                Settings
              </button>
            </div>
          )}
        </aside>
        <div className="stage">
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
                  agentMode={t.agentMode}
                  alwaysApprove={t.alwaysApprove}
                  active={t.id === active}
                  greeting={`You're in ${folderName}. Type / for commands.`}
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
                              model: c.model || x.model,
                              effort:
                                c.efforts && c.efforts.length === 0
                                  ? undefined
                                  : normalizeEffort(c.effort) || (c.efforts?.length ? x.effort : undefined),
                              agentMode: c.agentMode || x.agentMode,
                              cliSessionId: c.sessionId || x.cliSessionId,
                              models: c.models ?? x.models,
                              efforts: c.efforts,
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
            .filter((t) => t.type === 'file' && t.id === active)
            .map((t) => (
              <div key={t.id} className="filetab">
                <div className="filetab-head">{t.title}</div>
                {t.fileKind === 'html' && t.url ? (
                  <webview className="fileweb" src={t.url} />
                ) : (
                  <div className="mdview" dangerouslySetInnerHTML={{ __html: t.html || '' }} />
                )}
              </div>
            ))}
        </div>
        <aside className="refs">
          <h2>In use</h2>
          <ul className="looking looking-log" ref={refsList}>
            {hits.length === 0 && <li className="tiny">Nothing for this chat yet.</li>}
            {hits.map((h) => (
              <li key={h.path} className={h.live ? 'live' : ''}>
                <button type="button" className="flink" onClick={() => void openFile(h.path)}>
                  {rel(cwd, h.path)}
                </button>
              </li>
            ))}
          </ul>
          <div className="runmeta" onMouseDown={(e) => e.stopPropagation()}>
            {pick && (
              <div className="runpick">
                {pick === 'model' &&
                  (modelChoices.length === 0 ? (
                    <div className="tiny" style={{ padding: '0.4rem 0.55rem' }}>
                      {chatTab?.models ? 'No models for this CLI.' : 'Loading models…'}
                    </div>
                  ) : (
                    modelChoices.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        className={m.id === chatTab?.model || m.label === chatTab?.model ? 'on' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setChatModel(m.id)}
                      >
                        {m.label}
                      </button>
                    ))
                  ))}
                {pick === 'effort' &&
                  (chatTab?.efforts?.length ? chatTab.efforts : fallbackEfforts(chatTab?.kind)).map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      className={normalizeEffort(e.id) === normalizeEffort(chatTab?.effort) ? 'on' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setChatEffort(e.id)}
                    >
                      {e.label}
                    </button>
                  ))}
                {pick === 'agentMode' &&
                  (chatTab?.agentModes || []).map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={m.id === chatTab?.agentMode ? 'on' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setChatAgentMode(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                {pick === 'folder' && (
                  <>
                    {recents.map((r) => (
                      <button
                        type="button"
                        key={r.path}
                        className={r.path === cwd ? 'on' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void useFolder(r.path)}
                      >
                        {r.name}
                        {r.watching ? ' · watching' : ''}
                      </button>
                    ))}
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void pickFolder()}>
                      Choose folder…
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="runmeta-k">Model</div>
            <button type="button" className="runmeta-v" onClick={() => setPick((p) => (p === 'model' ? null : 'model'))}>
              {prettyModel(chatTab?.model, chatTab?.kind, chatTab?.models)}
            </button>
            {(chatTab?.efforts?.length || (chatTab?.kind && chatTab.kind !== 'cursor' && fallbackEfforts(chatTab.kind).length)) ? (
              <>
                <div className="runmeta-k">Effort</div>
                <button type="button" className="runmeta-v" onClick={() => setPick((p) => (p === 'effort' ? null : 'effort'))}>
                  {prettyEffort(chatTab?.effort)}
                </button>
              </>
            ) : null}
            {chatTab?.agentModes?.length ? (
              <>
                <div className="runmeta-k">Mode</div>
                <button type="button" className="runmeta-v" onClick={() => setPick((p) => (p === 'agentMode' ? null : 'agentMode'))}>
                  {chatTab.agentModes.find((m) => m.id === chatTab.agentMode)?.label || chatTab.agentMode || 'Agent'}
                </button>
              </>
            ) : null}
            {contextByTab[chatId || ''] && (contextByTab[chatId || ''].percent != null || contextByTab[chatId || ''].used) ? (
              <>
                <div className="runmeta-k">Context</div>
                <div className="runmeta-v">
                  {contextByTab[chatId || ''].percent != null
                    ? `${contextByTab[chatId || ''].percent}%`
                    : `${Math.round((contextByTab[chatId || ''].used || 0) / 1000)}k tokens`}
                </div>
              </>
            ) : null}
            <div className="runmeta-k">Folder</div>
            <button
              type="button"
              className="runmeta-v"
              title={cwd}
              onClick={() => setPick((p) => (p === 'folder' ? null : 'folder'))}
            >
              {folderName}
            </button>
            <WorldClocks />
          </div>
        </aside>
      </div>

    </div>
  )
}
