import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AiKind, Session } from '@shared/contracts'
import { mdToHtml, tidy, type FileHit } from './ptyChat'

type Mode = 'chat' | 'term'
type Msg = { who: 'me' | 'brain' | 'think' | 'sys'; text: string }
type FileNode = { name: string; path: string; dir: boolean; kids?: FileNode[] }
type Cap = { id: string; label: string }
type Tab = {
  id: string
  type: 'chat' | 'file'
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

function prettyEffort(id?: string): string {
  if (!id) return 'Default'
  const map: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max'
  }
  return map[id.toLowerCase()] || id
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

function TermPane({
  id,
  kind,
  cwd,
  sessionId,
  active
}: {
  id: string
  kind: AiKind
  cwd: string
  sessionId: string
  active: boolean
}) {
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
    void window.brain.pty.create({ id, kind, cwd, cols: term.cols, rows: term.rows, sessionId })
    const offData = window.brain.pty.onData((ev) => {
      if (live && ev.id === id) {
        term.write(ev.data)
        if (active) term.scrollToBottom()
      }
    })
    const offExit = window.brain.pty.onExit((ev) => {
      if (live && ev.id === id) term.write(`\r\n[session ended ${ev.exitCode}]\r\n`)
    })
    const onEcho = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail
      if (!live || d.id !== id) return
      term.write(`\r\n\x1b[38;5;208mYou:\x1b[0m ${d.text}\r\n`)
    }
    window.addEventListener('brain-echo', onEcho)
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
      window.removeEventListener('brain-echo', onEcho)
      sub.dispose()
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      void window.brain.pty.kill(id)
      term.dispose()
      termRef.current = null
    }
  }, [id, kind, cwd, sessionId])

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
  onApprove
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
}) {
  const [messages, setMessages] = useState<Msg[]>(
    initialMessages && initialMessages.length ? initialMessages : [{ who: 'brain', text: greeting }]
  )
  const [say, setSay] = useState('')
  const [busy, setBusy] = useState(false)
  const [cmds, setCmds] = useState<{ name: string; kind: 'builtin' | 'skill'; description: string }[]>([])
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [hi, setHi] = useState(0)
  const [panel, setPanel] = useState<{ title: string; body: string } | null>(null)
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  const thread = useRef<HTMLDivElement>(null)
  const filesRef = useRef<FileHit[]>([])
  const turn = useRef({ think: false, answer: false })

  useEffect(() => {
    const off = window.brain.chat.onEvent((ev) => {
      if (ev.tabId !== id) return
      if (ev.kind === 'thought' && ev.data) {
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
      if (ev.kind === 'context') {
        onContext(id, { used: ev.used, total: ev.total, percent: ev.percent })
      }
      if (ev.kind === 'status' && ev.data === 'compacting') {
        compactingRef.current = true
        setCompacting(true)
      }
      if (ev.kind === 'status' && ev.data === 'compacted') {
        compactingRef.current = false
        setCompacting(false)
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
      if (ev.kind === 'file' && ev.path) {
        const hit = { path: ev.path, tool: ev.tool, live: true }
        if (!filesRef.current.some((f) => f.path === hit.path)) {
          filesRef.current = [...filesRef.current, hit]
          onFiles(id, filesRef.current)
        }
      }
      if (ev.kind === 'done' || ev.kind === 'error') {
        setBusy(false)
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
          setMessages((m) => [...m, { who: 'brain', text: ev.data || '' }])
        }
      }
    })
    return () => {
      off()
    }
  }, [id, greeting, onFiles])

  useEffect(() => {
    thread.current?.scrollTo(0, thread.current.scrollHeight)
  }, [messages, busy])

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
    void window.brain.chat
      .warm({ tabId: id, kind, cwd, model, effort, agentMode, resumeId })
      .then((r) => {
        if (r?.models?.length) setModels(r.models)
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
      .catch(() => {})
  }, [id, kind, cwd, model, effort, agentMode, resumeId])

  useEffect(() => {
    return () => {
      void window.brain.chat.close(id)
    }
  }, [id, cwd])

  const EFFORTS =
    kind === 'gpt' ? ['low', 'medium', 'high'] : kind === 'cursor' ? [] : ['low', 'medium', 'high', 'xhigh']
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
    matches = cmds
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
        insert: ['model', 'effort', 'imagine', 'imagine-video', 'compact', 'rename', 'remember', 'loop', 'goal', 'deep-research', 'btw', 'feedback', 'copy', 'export', 'rewind', 'workflow', 'plan', 'title'].includes(c.name)
            ? `/${c.name} `
            : `/${c.name}`
      }))
  }

  function note(text: string) {
    setMessages((m) => [...m, { who: 'sys', text }])
  }

  function popup(title: string, body: string) {
    setPanel({ title, body })
  }

  function runSlash(raw: string): boolean {
    const t = raw.trim()
    if (!t.startsWith('/')) return false
    const [cmd, ...rest] = t.slice(1).split(/\s+/)
    const name = (cmd || '').toLowerCase()
    const arg = rest.join(' ')
    if (name === 'new') {
      onNew()
      return true
    }
    if (name === 'clear') {
      setMessages([{ who: 'brain', text: greeting }])
      filesRef.current = []
      onFiles(id, [])
      void window.brain.chat.reset({ tabId: id, kind, cwd, model, effort }).catch(() => {})
      return true
    }
    if (name === 'help') {
      popup('Commands', cmds.map((c) => `/${c.name}  ${c.description}`).join('\n'))
      return true
    }
    if (name === 'usage') {
      void window.brain.slash.usage(cwd, kind).then((body) => popup('Usage', body))
      return true
    }
    if (name === 'model' || name === 'm') {
      if (!arg) {
        setSay('/model ')
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
      if (!arg) {
        setSay('/effort ')
        return true
      }
      onEffort(arg.toLowerCase())
      note(`Effort is ${arg.toLowerCase()}.`)
      return true
    }
    if (name === 'always-approve' || name === 'auto') {
      const next = !alwaysApprove
      onApprove(next)
      note(next ? 'Always-approve is on for this chat.' : 'Always-approve is off.')
      return true
    }
    if (name === 'compact') {
      compactingRef.current = true
      setCompacting(true)
      void sendQuiet(arg ? `/compact ${arg}` : '/compact')
      return true
    }
    if (name === 'context') {
      void window.brain.slash.context(cwd).then((body) => popup('Context', body))
      return true
    }
    if (name === 'session-info' || name === 'status' || name === 'info') {
      popup(
        'Session',
        [
          `CLI: ${kind}`,
          `Model: ${model || 'default'}`,
          `Effort: ${effort || 'default'}`,
          `Always-approve: ${alwaysApprove ? 'on' : 'off'}`,
          `Folder: ${cwd}`
        ].join('\n')
      )
      return true
    }
    if (name === 'fork') {
      onNew()
      return true
    }
    if (name === 'rewind' || name === 'undo') {
      setMessages((m) => {
        const next = [...m]
        while (next.length && next[next.length - 1].who !== 'me') next.pop()
        next.pop()
        return next.length ? next : [{ who: 'brain', text: greeting }]
      })
      note('Undid the last turn.')
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
      const path = `${cwd}/chat-export.md`
      void navigator.clipboard.writeText(body)
      note(`Chat copied. Save it as ${arg || path} if you want a file.`)
      return true
    }
    if (name === 'quit' || name === 'exit') {
      void window.brain.quit()
      return true
    }
    if (name === 'home' || name === 'welcome') {
      setMessages([{ who: 'brain', text: greeting }])
      return true
    }
    if (name === 'delete') {
      setMessages([{ who: 'brain', text: greeting }])
      note('This chat was cleared.')
      return true
    }
    if (name === 'rename' || name === 'title') {
      if (!arg) {
        setSay('/rename ')
        return true
      }
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
    if (name === 'skills') {
      popup('Skills', cmds.filter((c) => c.kind === 'skill').map((c) => `/${c.name}  ${c.description}`).join('\n') || '(none)')
      return true
    }
    if (name === 'mcps' || name === 'hooks' || name === 'plugins' || name === 'marketplace' || name === 'workflows') {
      void window.brain.slash.cli([name === 'mcps' ? 'mcp' : name === 'hooks' ? 'mcp' : name === 'plugins' ? 'plugin' : name], cwd).then((body) =>
        popup(name, body)
      )
      return true
    }
    if (name === 'doctor' || name === 'terminal-setup' || name === 'terminal-check') {
      void window.brain.slash.cli(['doctor'], cwd).then((body) => popup('Doctor', body))
      return true
    }
    if (name === 'login') {
      void window.brain.slash.cli(['login'], cwd).then((body) => popup('Login', body))
      return true
    }
    if (name === 'logout') {
      void window.brain.slash.cli(['logout'], cwd).then((body) => popup('Logout', body))
      return true
    }
    if (name === 'docs' || name === 'howto' || name === 'guides') {
      popup('Docs', 'Grok Build docs: ~/.grok/docs/user-guide/\nOnline: https://docs.x.ai/')
      return true
    }
    if (name === 'release-notes' || name === 'changelog') {
      void window.brain.slash.cli(['version'], cwd).then((body) => popup('Release', body))
      return true
    }
    if (name === 'memory' || name === 'mem') {
      void window.brain.slash.cli(['memory', 'list'], cwd).then((body) => popup('Memory', body))
      return true
    }
    if (name === 'privacy' || name === 'settings' || name === 'config' || name === 'preferences') {
      popup(
        'Settings',
        `Model ${model || 'default'}\nEffort ${effort || 'default'}\nAlways-approve ${alwaysApprove ? 'on' : 'off'}\nFolder ${cwd}`
      )
      return true
    }
    if (name === 'tutorial') {
      popup('Tutorial', 'Type / for commands. Pick a model with /model. Skills like /accounts run against this brain folder. Stop cancels a run.')
      return true
    }
    if (name === 'theme' || name === 'vim-mode' || name === 'minimal' || name === 'fullscreen' || name === 'dashboard' || name === 'timestamps' || name === 'multiline' || name === 'compact-mode') {
      popup(name, 'This chat is the product UI. That command is a Grok TUI chrome setting, so it has no separate screen here.')
      return true
    }
    if (name === 'resume') {
      void window.brain.slash.cli(['sessions', 'list'], cwd).then((body) => popup('Sessions', body))
      return true
    }
    if (
      ['imagine', 'imagine-video', 'plan', 'view-plan', 'deep-research', 'btw', 'remember', 'dream', 'flush', 'goal', 'loop', 'workflow', 'feedback', 'personas', 'config-agents', 'import-claude'].includes(name)
    ) {
      if (!arg && ['imagine', 'imagine-video', 'remember', 'btw', 'deep-research', 'goal', 'loop', 'plan', 'feedback'].includes(name)) {
        setSay(`/${name} `)
        return true
      }
      return false
    }
    return false
  }

  function applyPick(pick: Pick) {
    if (pick.kind === 'arg') {
      setSay('')
      runSlash(pick.insert)
      return
    }
    if (pick.kind === 'skill') {
      setSay('')
      void sendText('/' + pick.name)
      return
    }
    if (pick.insert.endsWith(' ')) {
      setSay(pick.insert)
      setHi(0)
      return
    }
    if (pick.kind === 'builtin') {
      setSay('')
      runSlash('/' + pick.name)
      return
    }
    setSay('')
    void sendText('/' + pick.name)
  }

  async function stop() {
    await window.brain.chat.stop(id)
    setBusy(false)
  }

  async function send() {
    const t = say.trim()
    if (!t) return
    const onlyCmd = slashOn && !/\s/.test(t.trim())
    if (onlyCmd && matches.length && matches[hi]) {
      applyPick(matches[hi])
      return
    }
    setSay('')
    const skillName = t.slice(1).split(/\s/)[0].toLowerCase()
    const isSkill = cmds.some((c) => c.kind === 'skill' && c.name.toLowerCase() === skillName)
    if (runSlash(t) && !isSkill) return
    await sendText(t)
  }

  async function sendQuiet(t: string) {
    if (busy) await stop()
    setBusy(true)
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
          'You are the brain on this computer. Answer in plain English. You may read files. Do not edit or write files. Do not dump tool names or keyboard shortcuts.'
      })
    } catch (e) {
      setBusy(false)
      setCompacting(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
  }

  async function sendText(t: string) {
    if (busy) await stop()
    filesRef.current = []
    onFiles(id, [])
    setBusy(true)
    turn.current = { think: false, answer: false }
    setMessages((m) => [...m, { who: 'me', text: t }])
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
          'You are the brain on this computer. Answer in plain English. You may read files. Do not edit or write files. Do not dump tool names or keyboard shortcuts.'
      })
    } catch (e) {
      setBusy(false)
      setMessages((m) => [...m, { who: 'brain', text: String((e as Error).message || e) }])
    }
  }

  return (
    <div className={`chatpane ${active ? 'on' : ''}`}>
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
      <div className="thread" ref={thread}>
        {messages.map((m, i) =>
          m.text || m.who === 'me' ? (
            <div
              className={`bubble ${m.who === 'me' ? 'me' : ''} ${m.who === 'think' ? 'think' : ''} ${m.who === 'brain' ? 'md' : ''}`}
              key={i}
            >
              {m.who === 'think' && <div className="think-label">Thinking</div>}
              {m.who === 'sys' && <div className="think-label">Command</div>}
              {m.who === 'brain' ? (
                <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(m.text) }} />
              ) : (
                <Rich text={m.text} />
              )}
            </div>
          ) : null
        )}
      </div>
      {compacting && (
        <div className="worknote" aria-live="polite">
          <span className="wheel" aria-hidden="true" />
          <span>
            Compacting
            <span className="dots" />
          </span>
        </div>
      )}
      <div className="composer">
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
        <input
          value={say}
          onChange={(e) => {
            setSay(e.target.value)
            setHi(0)
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
            if (e.key === 'Enter') void send()
          }}
          placeholder={busy ? 'Working — type to interrupt, or Stop' : 'Message, or / for commands'}
        />
        {busy ? (
          <button className="ghost" type="button" onClick={() => void stop()}>
            Stop
          </button>
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
  function freshTab(): Tab {
    return {
      id: nid(),
      type: 'chat',
      kind: setupKind,
      mode: 'chat',
      title: label(setupKind),
      sessionId: crypto.randomUUID(),
      effort: setupKind === 'cursor' ? undefined : 'high'
    }
  }
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [filesByTab, setFilesByTab] = useState<Record<string, FileHit[]>>({})
  const [filesOpen, setFilesOpen] = useState(true)
  const [picker, setPicker] = useState(false)
  const [people, setPeople] = useState<{ n: string; e: string; r: string }[]>([])
  const [invite, setInvite] = useState({ n: '', e: '', r: 'Teammate' })
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
          setTabs(saved.tabs)
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
    }
  }, [cwd])

  useEffect(() => {
    saveRef.current = { cwd, active, tabs, transcripts }
    if (!hydrated || !cwd || hydratedCwd !== cwd) return
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
      if (!s.cwd || !s.tabs.length) return
      void window.brain.chat.saveState({
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

  function addTab(kind: AiKind) {
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
        effort: kind === 'cursor' ? undefined : 'high'
      }
    ])
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

  function renderTree(dir: string, depth = 0): ReactNode {
    return (kids[dir] || []).map((n) => {
      const open = Boolean(n.dir && openDirs[n.path])
      return (
        <div key={n.path} className="fnode" style={{ paddingLeft: 8 + depth * 10 }}>
          {n.dir ? (
            <button type="button" className="flink" onClick={() => void toggleDir(n.path)}>
              {open ? '▾' : '▸'} {n.name}
            </button>
          ) : (
            <button type="button" className="flink" onClick={() => void openFile(n.path)}>
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
            <div key={t.id} className={`tab ${t.id === active ? 'on' : ''}`}>
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
        <button type="button" className="edgebtn" onClick={() => setFilesOpen(!filesOpen)} title={filesOpen ? 'Hide used files' : 'Show used files'}>
          {filesOpen ? '›' : '‹'}
        </button>
      </div>
      {picker && (
        <div className="picker">
          <span className="tiny">New chat. Pick who runs it, or keep typing / in the box.</span>
          {KINDS.map((k) => (
            <div key={k.id} className="picker-row">
              <button type="button" className="ghost" disabled={detected[k.id] === false} onClick={() => addTab(k.id)}>
                {k.name}
              </button>
              {detected[k.id] === false && <span className="tiny">not installed</span>}
            </div>
          ))}
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
                Invite
              </button>
            </div>
          )}
        </aside>
        <div className="stage">
          {hydrated &&
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
                              effort: c.efforts && c.efforts.length === 0 ? undefined : c.effort ?? x.effort,
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
                />
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
                  (chatTab?.models?.length
                    ? chatTab.models
                    : chatTab?.kind === 'gpt' || chatTab?.kind === 'cursor'
                      ? []
                      : models.length
                        ? models
                        : [{ id: 'grok-4.6', label: 'Grok 4.6' }]
                  ).map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={m.id === chatTab?.model || m.label === chatTab?.model ? 'on' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setChatModel(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                {pick === 'effort' &&
                  (chatTab?.efforts?.length ? chatTab.efforts : fallbackEfforts(chatTab?.kind)).map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      className={e.id === chatTab?.effort ? 'on' : ''}
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
          </div>
        </aside>
      </div>
      {showInvite && s.path !== 'join' && (
        <div className="invitebox">
          <div className="invitehead">
            <strong>Invite someone</strong>
            <button type="button" className="tabx" onClick={() => setShowInvite(false)} aria-label="Close invite">
              ×
            </button>
          </div>
          {people.map((p) => (
            <p className="tiny" key={p.e}>
              {p.n} · {p.e} · {p.r}
            </p>
          ))}
          <div className="inviterow">
            <input placeholder="Name" value={invite.n} onChange={(e) => setInvite({ ...invite, n: e.target.value })} />
            <input placeholder="Email" value={invite.e} onChange={(e) => setInvite({ ...invite, e: e.target.value })} />
            <select value={invite.r} onChange={(e) => setInvite({ ...invite, r: e.target.value })}>
              <option>Teammate</option>
              <option>Scout</option>
              <option>Owner</option>
            </select>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                if (!invite.n || !invite.e) return
                setPeople([...people, invite])
                setInvite({ n: '', e: '', r: 'Teammate' })
              }}
            >
              Invite
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
