import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CLI_LABEL, CONDUCTOR, returnText, type BotState, type DeskBot, type DeskCli, type DeskMessage, type DeskWelcome } from '@shared/desk'
import type { Paste } from '@shared/saved-msg'
import { DeskBotForm } from './DeskBotForm'
import { DeskCard } from './DeskCard'
import { isBigPaste, livePastes, nextPasteNumber, pasteLines, pasteParts, pasteSize, pasteToken } from './paste'
import { mdToHtml } from './ptyChat'

type Cap = { id: string; label: string }

const CLIS: DeskCli[] = ['grok', 'claude', 'gpt', 'cursor']

function mins(since: string): string {
  const t = Date.parse(since)
  if (!Number.isFinite(t)) return '0m'
  return `${Math.max(0, Math.floor((Date.now() - t) / 60000))}m`
}

function busyState(st: BotState | undefined): boolean {
  return !!st && st.state !== 'idle' && st.state !== 'not-set-up'
}

function modelLabel(id: string, list: Cap[]): string {
  return list.find((m) => m.id === id)?.label || (id === 'default' ? 'Default' : id)
}

function stateLine(st: BotState | undefined, names: Record<string, string>, models: Cap[]): string {
  if (!st || st.state === 'idle') return 'Idle'
  if (st.state === 'not-set-up') return 'Not set up'
  if (st.state === 'waiting-you') return 'Waiting on you'
  if (st.state === 'waiting-bot') return `Waiting for ${names[st.on] || 'a teammate'}`
  const task = st.trying ? 'Trying another model' : (st.task || '').split('\n')[0]
  const parts = [`Working · ${mins(st.since)}`, task].filter(Boolean)
  if (st.queued && st.queued > 0) parts.push(`Queued (${st.queued})`)
  if (st.nextModel) parts.push(`Switches to ${modelLabel(st.nextModel, models)} after this step.`)
  return parts.join(' · ')
}

/** Your line, with each long paste folded. Show opens that paste in place. */
function PastedLine({ text, pastes }: { text: string; pastes: Paste[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {pasteParts(text, pastes).map((part, i) =>
        'paste' in part ? (
          <span key={i} className="paste-fold">
            <button
              type="button"
              className="paste-label"
              aria-expanded={open[part.paste.token] === true}
              onClick={() => setOpen((o) => ({ ...o, [part.paste.token]: !o[part.paste.token] }))}
            >
              {part.paste.token} · {open[part.paste.token] ? 'hide' : 'show'}
            </button>
            {open[part.paste.token] ? <pre className="paste-body">{part.paste.text}</pre> : null}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  )
}

function withCurrent(list: Cap[], current: string): Cap[] {
  const rows = list.length ? list : [{ id: 'default', label: 'Default' }]
  if (current && !rows.some((m) => m.id === current)) return [...rows, { id: current, label: current }]
  return rows
}

const FACE_SHAPES = ['pebble', 'blob', 'drop', 'squircle'] as const

function faceShape(name: string): (typeof FACE_SHAPES)[number] {
  let n = 0
  for (const c of name) n += c.charCodeAt(0)
  return FACE_SHAPES[n % FACE_SHAPES.length]
}

function DeskFace({ name }: { name: string }) {
  const shape = faceShape(name)
  const delay = `${(name.length % 5) * 0.35}s`
  return (
    <svg className="desk-face" data-shape={shape} viewBox="0 0 40 40" aria-hidden="true" style={{ ['--desk-delay' as string]: delay }}>
      {shape === 'pebble' ? <ellipse className="desk-body" cx="20" cy="21" rx="14" ry="15" /> : null}
      {shape === 'blob' ? <path className="desk-body" d="M20 5c7 0 14 5 14 13 0 8-4 16-14 16S6 28 6 18 13 5 20 5z" /> : null}
      {shape === 'drop' ? <path className="desk-body" d="M20 4c8 6 12 12 12 18a12 12 0 1 1-24 0c0-6 4-12 12-18z" /> : null}
      {shape === 'squircle' ? <rect className="desk-body" x="6" y="6" width="28" height="28" rx="12" /> : null}
      <rect className="eye" x="13" y="15" width="4.2" height="8" rx="2.1" />
      <rect className="eye" x="22.8" y="15" width="4.2" height="8" rx="2.1" />
    </svg>
  )
}

const CHAT_KIND = new Set(['task', 'reply', 'pack', 'send'])

function messageBack(msg: DeskMessage, whoName: string, onOpen: (id: string) => void) {
  const line = returnText(msg)
  return [
    <div className="bubble sys desk-pill" key={`${msg.id}-from`} title={`Double-click to open ${whoName}.`} onDoubleClick={() => onOpen(msg.from)}>
      {`Message from ${whoName}.`}
    </div>,
    line ? (
      <div className="bubble md" key={`${msg.id}-back`}>
        <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(line) }} />
      </div>
    ) : null
  ]
}

function chatShape(msg: DeskMessage, speaker: string): 'me' | 'prose' | 'sent' | 'from' | 'card' {
  if (!CHAT_KIND.has(msg.kind)) return 'card'
  if (msg.from === 'me') return 'me'
  const toSomeoneElse = msg.to !== speaker && msg.to !== 'me'
  if (msg.from === speaker && toSomeoneElse) return 'sent'
  if (msg.from !== speaker && toSomeoneElse) return 'sent'
  if (msg.from !== speaker && msg.to === 'me') return 'from'
  return 'prose'
}

export function DeskPane({
  id,
  cwd,
  active,
  rail,
  closing,
  onClosed,
  onKeep,
  onOpenFile,
  modelsFor,
  effortsFor
}: {
  id: string
  cwd: string
  active: boolean
  rail: HTMLElement | null
  closing: boolean
  onClosed: () => void
  onKeep: () => void
  onOpenFile: (path: string) => void
  modelsFor: (cli: DeskCli, list?: Cap[]) => Cap[]
  effortsFor: (cli: DeskCli) => Cap[]
}) {
  const [bots, setBots] = useState<DeskBot[]>([])
  const [states, setStates] = useState<BotState[]>([])
  const [removed, setRemoved] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<DeskMessage[]>([])
  const [welcome, setWelcome] = useState<DeskWelcome | null>(null)
  const [openBotId, setOpenBotId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pastes, setPastes] = useState<Paste[]>([])
  const pastesRef = useRef<Paste[]>([])
  const [form, setForm] = useState<DeskBot | null | undefined>(undefined)
  const [note, setNote] = useState('')
  const [removeAsk, setRemoveAsk] = useState<{ id: string; name: string } | null>(null)
  const [closeNames, setCloseNames] = useState<string[] | null>(null)
  const [models, setModels] = useState<Record<DeskCli, Cap[]>>({ grok: [], claude: [], gpt: [], cursor: [] })
  const [installed, setInstalled] = useState<DeskCli[]>([])
  const [tick, setTick] = useState(0)
  const [browserView, setBrowserView] = useState<'small' | 'wide' | 'note'>('small')
  const [shot, setShot] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  const brainRef = useRef('')
  const asked = useRef(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [hiddenOpen, setHiddenOpen] = useState(false)
  openRef.current = openBotId

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(`desk-hidden:${cwd}`) || '[]')
      setHiddenIds(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id !== CONDUCTOR) : [])
    } catch {
      setHiddenIds([])
    }
    setHiddenOpen(false)
  }, [cwd])

  function names(): Record<string, string> {
    const map: Record<string, string> = { me: 'You' }
    for (const bot of bots) map[bot.id] = bot.name
    for (const [bid, name] of Object.entries(removed)) if (!map[bid]) map[bid] = name
    return map
  }

  async function loadThread(thread: string | null) {
    const [list, card, view] = await Promise.all([
      window.brain.desk.list(id),
      window.brain.desk.welcome(id, thread),
      window.brain.desk.view(id, thread)
    ])
    setBots(list.bots)
    setStates(list.states)
    setRemoved(list.removedNames)
    setWelcome(card)
    setMessages(view)
  }

  useEffect(() => {
    let dead = false
    void window.brain.desk.attach(id, cwd).then((res) => {
      if (dead) return
      brainRef.current = res.brain
      return loadThread(openRef.current)
    }).catch(() => undefined)
    const off = window.brain.desk.onEvent((snap) => {
      if (dead || (brainRef.current && snap.brain !== brainRef.current)) return
      setStates(snap.states)
      setRemoved(snap.removedNames)
      const thread = openRef.current
      if (!thread) setMessages(snap.messages)
      else void window.brain.desk.view(id, thread).then((rows) => { if (!dead) setMessages(rows) })
      void window.brain.desk.list(id).then((list) => { if (!dead) setBots(list.bots) })
    })
    return () => {
      dead = true
      off()
      void window.brain.desk.detach(id, { stop: false })
    }
  }, [id, cwd])

  useEffect(() => {
    void loadThread(openBotId).catch(() => undefined)
  }, [openBotId])

  useEffect(() => {
    let dead = false
    void window.brain.ai.detect().then((found) => {
      if (dead) return
      const have = CLIS.filter((c) => found[c])
      setInstalled(have)
      return Promise.all(CLIS.map((cli) => window.brain.slash.list(cwd, cli).then((r) => [cli, modelsFor(cli, r.models)] as const)))
    }).then((rows) => {
      if (dead || !rows) return
      const next = { grok: [], claude: [], gpt: [], cursor: [] } as Record<DeskCli, Cap[]>
      for (const [cli, list] of rows) next[cli] = list.length ? list : [{ id: 'default', label: 'Default' }]
      setModels(next)
    }).catch(() => undefined)
    return () => { dead = true }
  }, [cwd, modelsFor])

  useEffect(() => {
    if (!states.some((s) => s.state === 'working')) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 15000)
    return () => window.clearInterval(timer)
  }, [states])

  useEffect(() => {
    if (!closing) {
      asked.current = false
      setCloseNames(null)
      return
    }
    if (asked.current) return
    asked.current = true
    void window.brain.desk.closeCheck(id).then((check) => {
      if (check.last && check.busyNames.length) setCloseNames(check.busyNames)
      else void window.brain.desk.detach(id, { stop: true }).then(onClosed)
    }).catch(() => onKeep())
  }, [closing, id, onClosed, onKeep])

  const pictureMsg = [...messages].reverse().find((m) => m.kind === 'browse' && m.browse?.windowOpen && !m.browse.signIn)
  const pictureKey = pictureMsg?.id ?? ''
  useEffect(() => {
    setBrowserView('small')
    setShot(null)
  }, [pictureKey])
  useEffect(() => {
    if (!active || !pictureKey || browserView === 'note') return
    let dead = false
    let busy = false
    const tickShot = () => {
      if (busy || dead) return
      busy = true
      void window.brain.desk.picture(id).then((b64) => {
        if (!dead && b64) setShot(b64)
      }).finally(() => {
        busy = false
      })
    }
    tickShot()
    const timer = window.setInterval(tickShot, 1500)
    return () => {
      dead = true
      window.clearInterval(timer)
    }
  }, [active, pictureKey, browserView, id])

  function openThread(botId: string | null) {
    stick.current = true
    setForm(undefined)
    setOpenBotId(botId)
  }

  function openOther(botId: string) {
    if (botId !== CONDUCTOR && !bots.some((b) => b.id === botId)) return
    openThread(botId === CONDUCTOR ? null : botId)
  }

  function onThreadScroll() {
    const el = threadRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stick.current = near
    setAtBottom(near)
  }

  useLayoutEffect(() => {
    const el = threadRef.current
    if (!active || !el || !stick.current) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [messages, welcome, openBotId, active])

  async function saveBot(bot: Omit<DeskBot, 'file'>) {
    const err = await window.brain.desk.save(id, bot)
    setNote(err || '')
    if (!err) await loadThread(openRef.current)
    return err
  }

  async function removeBot(botId: string) {
    const err = await window.brain.desk.remove(id, botId)
    setNote(err || '')
    setRemoveAsk(null)
    if (!err && openRef.current === botId) {
      stick.current = true
      setOpenBotId(null)
    }
    await loadThread(openRef.current === botId ? null : openRef.current)
  }

  function keepPastes(next: Paste[]) {
    pastesRef.current = next
    setPastes(next)
  }

  /** Types at the caret through the browser, so one undo takes the token back out. */
  function insertAtCaret(box: HTMLTextAreaElement, text: string) {
    box.focus()
    if (document.execCommand('insertText', false, text)) return
    const at = box.selectionStart
    const next = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd)
    setDraft(next)
    requestAnimationFrame(() => box.setSelectionRange(at + text.length, at + text.length))
  }

  function expandPaste(p: Paste) {
    setDraft((s) => s.replace(p.token, () => p.text))
    keepPastes(pastesRef.current.filter((x) => x !== p))
  }

  function dropPaste(p: Paste) {
    setDraft((s) => s.split(p.token).join(''))
    keepPastes(pastesRef.current.filter((x) => x !== p))
  }

  function send() {
    const text = draft.trim()
    if (!text || welcome?.composerDisabled) return
    const held = livePastes(text, pastesRef.current)
    setDraft('')
    keepPastes([])
    void window.brain.desk.say(id, text, openBotId || CONDUCTOR, held.length ? held : undefined)
  }

  const who = names()
  const openBot = bots.find((b) => b.id === openBotId) || null
  const header = openBot?.name || who[CONDUCTOR] || 'Conductor'
  const conductor = states.find((s) => s.id === CONDUCTOR)
  const efforts = {
    grok: effortsFor('grok'),
    claude: effortsFor('claude'),
    gpt: effortsFor('gpt'),
    cursor: effortsFor('cursor')
  }
  void tick

  const speaker = openBotId || CONDUCTOR
  const nameOf = (botId: string) => who[botId] || (botId === 'me' ? 'You' : 'Someone')
  const hiddenSet = new Set(hiddenIds)
  const shownBots = bots.filter((bot) => bot.id === CONDUCTOR || !hiddenSet.has(bot.id))
  const hiddenBots = bots.filter((bot) => bot.id !== CONDUCTOR && hiddenSet.has(bot.id))
  function hideBot(botId: string) {
    if (botId === CONDUCTOR) return
    const next = hiddenSet.has(botId) ? hiddenIds.filter((id) => id !== botId) : [...hiddenIds, botId]
    setHiddenIds(next)
    if (!hiddenSet.has(botId)) setHiddenOpen(true)
    try { localStorage.setItem(`desk-hidden:${cwd}`, JSON.stringify(next)) } catch { /* the rail still updates */ }
    setForm(undefined)
  }
  function botButton(bot: DeskBot) {
    const st = states.find((s) => s.id === bot.id)
    const choices = withCurrent(models[bot.cli] || [], bot.model)
    const open = bot.id === speaker
    const live = st?.state === 'working'
    return (
      <button
        type="button"
        key={bot.id}
        className={`desk-bot${open ? ' on' : ''}${live ? ' live' : ''}`}
        aria-label={bot.name}
        title={`${bot.name}. ${stateLine(st, who, choices)}`}
        onClick={() => openThread(bot.id === CONDUCTOR ? null : bot.id)}
      >
        <span className="desk-logo">
          <DeskFace name={bot.name} />
          {live ? <span className="desk-dot" aria-hidden="true" /> : null}
        </span>
        <span className="desk-name">{bot.name}</span>
      </button>
    )
  }
  const roster = (
    <div className="desk-roster">
      <div className="desk-bots">
        {shownBots.map(botButton)}
        <button type="button" className="desk-mark" aria-label="Add a teammate" title="Add a teammate" onClick={() => { setForm(null); setNote('') }}>
          +
        </button>
      </div>
      {hiddenBots.length ? (
        <div className="desk-hidden">
          <button type="button" className="desk-hidden-toggle" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((open) => !open)}>
            Hidden
          </button>
          {hiddenOpen ? <div className="desk-bots desk-hidden-list">{hiddenBots.map(botButton)}</div> : null}
        </div>
      ) : null}
      {note ? <p className="tiny">{note}</p> : null}
      {form !== undefined ? (
        <>
          <button type="button" className="ghost" onClick={() => setForm(undefined)}>Back</button>
          <DeskBotForm
            bot={form || undefined}
            bots={bots}
            installed={installed}
            models={models}
            efforts={efforts}
            busy={busyState(states.find((s) => s.id === form?.id))}
            onSave={saveBot}
            onRemove={form && form.id !== CONDUCTOR ? () => {
              const st = states.find((s) => s.id === form.id)
              if (busyState(st)) return
              void removeBot(form.id)
            } : undefined}
            onOpenFile={form ? () => onOpenFile(form.file) : undefined}
            onHide={form && form.id !== CONDUCTOR ? () => hideBot(form.id) : undefined}
            hidden={!!form && hiddenSet.has(form.id)}
            onCancel={() => setForm(undefined)}
          />
        </>
      ) : null}
    </div>
  )

  return (
    <div className={`chatpane ${active ? 'on' : ''}`}>
      <div className="filetab-head">
        <span>{header}</span>
        <span className="filetab-actions">
          <button
            type="button"
            onClick={() => {
              const bot = bots.find((b) => b.id === speaker)
              if (!bot) return
              setForm(bot)
              setNote('')
            }}
          >
            Edit
          </button>
          {openBotId ? (
            <button type="button" onClick={() => openThread(null)}>Team</button>
          ) : null}
        </span>
      </div>
      <div className="thread desk-thread" ref={threadRef} onScroll={onThreadScroll}>
        {messages.length === 0 && welcome ? (
          <div className="bubble md">
            <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(welcome.greeting) }} />
            {welcome.starters.map((s) => (
              <button key={s.label} type="button" className="ghost" onClick={() => setDraft(s.fill)}>{s.label}</button>
            ))}
          </div>
        ) : null}
        {messages.map((msg) => {
          const shape = chatShape(msg, speaker)
          const queued = msg.kind === 'task' && msg.from === 'me' && msg.to === CONDUCTOR && !openBotId && conductor?.state === 'working' && conductor.task.split('\n')[0] !== msg.text.split('\n')[0]
          if (shape === 'me') {
            return (
              <div className="bubble me" key={msg.id}>
                {msg.pastes?.length ? <PastedLine text={msg.text} pastes={msg.pastes} /> : msg.text}
                {queued ? <p className="tiny">Conductor will read this next.</p> : null}
              </div>
            )
          }
          if (shape === 'prose') {
            return (
              <div className="bubble md" key={msg.id}>
                <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(msg.text) }} />
              </div>
            )
          }
          if (shape === 'sent' || shape === 'from') {
            const other = shape === 'sent' ? msg.to : msg.from
            const whoName = nameOf(other)
            if (shape === 'from') return messageBack(msg, whoName, openOther)
            return (
              <div className="bubble sys desk-pill" key={msg.id} title={`Double-click to open ${whoName}.`} onDoubleClick={() => openOther(other)}>
                {`Message sent to ${whoName}.`}
              </div>
            )
          }
          if (msg.kind === 'report') {
            if (msg.from === speaker) {
              return (
                <div className="bubble md" key={msg.id}>
                  <div className="mdbody" dangerouslySetInnerHTML={{ __html: mdToHtml(msg.text) }} />
                </div>
              )
            }
            return messageBack(msg, nameOf(msg.from), openOther)
          }
          const botId = msg.hire?.id || msg.from
          const st = states.find((s) => s.id === botId)
          return (
            <DeskCard
              key={msg.id}
              msg={msg}
              names={who}
              busy={busyState(st)}
              onOpenFile={onOpenFile}
              onHoldAnswer={(msgId, answer) => void window.brain.desk.answerHold(id, msgId, answer)}
              onSend={(msgId, sent) => {
                const kind = messages.find((m) => m.id === msgId)?.kind
                const answer = sent === 'no' ? 'no' : 'yes'
                if (kind === 'text') void window.brain.desk.answerText(id, msgId, answer)
                else void window.brain.desk.answerEmail(id, msgId, answer)
              }}
              onRetry={(msgId) => void window.brain.desk.retry(id, msgId)}
              onKeepWaiting={(botId) => void window.brain.desk.keepWaiting(id, botId)}
              onStop={(botId) => void window.brain.desk.stop(id, botId)}
              onContinueJob={(job) => void window.brain.desk.continueJob(id, job)}
              onStopJob={(job) => void window.brain.desk.stopJob(id, job)}
              onTalk={(botId) => openThread(botId)}
              onOpenLog={() => onOpenFile(`${cwd}/desk/mail/desk.md`)}
              onOpenMemory={(botId) => onOpenFile(`${cwd}/desk/memory/${botId}.md`)}
              picture={msg.id === pictureMsg?.id ? { mode: browserView, src: shot } : undefined}
              onPictureToggle={() => setBrowserView((v) => (v === 'small' ? 'wide' : v))}
              onPictureHide={() => setBrowserView('note')}
              onPictureShow={() => setBrowserView('small')}
              onOpenBrowser={(opts) => {
                if (opts?.signIn) {
                  void window.brain.desk.showWindow(id)
                  return
                }
                setBrowserView((v) => (v === 'note' ? 'small' : 'wide'))
              }}
              onRemoveHire={(msgId) => {
                const hire = messages.find((m) => m.id === msgId)?.hire
                if (!hire) return
                const stHire = states.find((s) => s.id === hire.id)
                if (busyState(stHire)) return
                if (hire.hasWorked) setRemoveAsk({ id: hire.id, name: hire.name })
                else void removeBot(hire.id)
              }}
            />
          )
        })}
      </div>
      {!atBottom ? (
        <button type="button" className="jump-latest" onClick={() => {
          const el = threadRef.current
          stick.current = true
          if (el) el.scrollTop = el.scrollHeight
          setAtBottom(true)
        }}>
          Latest
        </button>
      ) : null}
      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={welcome?.composerPlaceholder || 'Message Conductor'}
          disabled={!!welcome?.composerDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            if (welcome?.composerDisabled) return
            const text = e.clipboardData?.getData('text/plain') || ''
            if (!isBigPaste(text)) return
            e.preventDefault()
            const token = pasteToken(nextPasteNumber(pastesRef.current), pasteLines(text))
            keepPastes([...pastesRef.current, { token, text }])
            insertAtCaret(e.currentTarget, token)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="primary" type="button" disabled={!!welcome?.composerDisabled} onClick={send}>Send</button>
        {livePastes(draft, pastes).length > 0 ? (
          <div className="attachrow pasterow">
            {livePastes(draft, pastes).map((p) => {
              const lines = pasteLines(p.text)
              return (
                <span className="chip paste-chip" key={p.token} title={p.token}>
                  <span className="paste-chip-label">
                    Pasted text {/#\d+/.exec(p.token)?.[0]} · {pasteSize(p.text)} · {lines} {lines === 1 ? 'line' : 'lines'}
                  </span>
                  <button type="button" className="linkish" onClick={() => expandPaste(p)}>Expand</button>
                  <button type="button" className="tabx" onClick={() => dropPaste(p)} aria-label="Remove paste">×</button>
                </span>
              )
            })}
          </div>
        ) : null}
        {welcome?.readiness.map((entry) => {
          const bot = bots.find((b) => b.id === entry.botId)
          return (
            <div key={entry.botId}>
              <p className="tiny">{entry.text}</p>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (!bot) return
                  void saveBot({ id: bot.id, name: bot.name, cli: entry.cli, model: entry.model, effort: bot.effort, description: bot.description })
                }}
              >
                {`Use ${CLI_LABEL[entry.cli]} for ${bot?.name || entry.botId}`}
              </button>
            </div>
          )
        })}
        {welcome?.everyoneLine ? <p className="tiny">{welcome.everyoneLine}</p> : null}
      </div>
      {rail ? createPortal(roster, rail) : null}
      {closeNames ? (
        <div className="tab-close">
          <div className="tab-close-card" role="alertdialog" aria-labelledby="desk-close-title">
            <h3 id="desk-close-title">Close Desk?</h3>
            <p>{closeNames.join(' and ')} {closeNames.length > 1 ? 'are' : 'is'} still working.</p>
            <div className="actions">
              <button className="primary" type="button" onClick={() => void window.brain.desk.detach(id, { stop: true }).then(onClosed)}>Close</button>
              <button className="ghost" type="button" onClick={onKeep}>Keep it</button>
            </div>
          </div>
        </div>
      ) : null}
      {removeAsk ? (
        <div className="tab-close">
          <div className="tab-close-card" role="alertdialog">
            <h3>Remove {removeAsk.name}?</h3>
            <div className="actions">
              <button className="primary" type="button" onClick={() => void removeBot(removeAsk.id)}>Remove</button>
              <button className="ghost" type="button" onClick={() => setRemoveAsk(null)}>Keep it</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
