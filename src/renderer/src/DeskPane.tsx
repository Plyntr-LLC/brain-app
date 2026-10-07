import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CLI_LABEL, CONDUCTOR, type BotState, type DeskBot, type DeskCli, type DeskMessage, type DeskWelcome } from '@shared/desk'
import { DeskBotForm } from './DeskBotForm'
import { DeskCard } from './DeskCard'
import { visibleBgLine } from '../../shared/agent-label'

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

function withCurrent(list: Cap[], current: string): Cap[] {
  const rows = list.length ? list : [{ id: 'default', label: 'Default' }]
  if (current && !rows.some((m) => m.id === current)) return [...rows, { id: current, label: current }]
  return rows
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
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [form, setForm] = useState<DeskBot | null | undefined>(undefined)
  const [note, setNote] = useState('')
  const [removeAsk, setRemoveAsk] = useState<{ id: string; name: string } | null>(null)
  const [closeNames, setCloseNames] = useState<string[] | null>(null)
  const [models, setModels] = useState<Record<DeskCli, Cap[]>>({ grok: [], claude: [], gpt: [], cursor: [] })
  const [installed, setInstalled] = useState<DeskCli[]>([])
  const [tick, setTick] = useState(0)
  const openRef = useRef<string | null>(null)
  const brainRef = useRef('')
  const asked = useRef(false)
  openRef.current = openBotId

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

  function openThread(botId: string | null) {
    setPickerFor(null)
    setForm(undefined)
    setOpenBotId(botId)
  }

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
    if (!err && openRef.current === botId) setOpenBotId(null)
    await loadThread(openRef.current === botId ? null : openRef.current)
  }

  function send() {
    const text = draft.trim()
    if (!text || welcome?.composerDisabled) return
    setDraft('')
    void window.brain.desk.say(id, text, openBotId || CONDUCTOR)
  }

  const who = names()
  const openBot = bots.find((b) => b.id === openBotId) || null
  const header = openBot?.name || who[CONDUCTOR] || 'Conductor'
  const conductor = states.find((s) => s.id === CONDUCTOR)
  const working = states.filter((s): s is Extract<BotState, { state: 'working' }> => s.state === 'working')
  const bg = visibleBgLine(working.map((s) => {
    const name = who[s.id] || 'A teammate'
    const task = s.trying ? 'trying another model' : ((s.task || 'working').split('\n')[0] || 'working')
    return { label: `${name} is ${task}` }
  }))
  const efforts = {
    grok: effortsFor('grok'),
    claude: effortsFor('claude'),
    gpt: effortsFor('gpt'),
    cursor: effortsFor('cursor')
  }
  void tick

  const roster = (
    <div className="desk-roster">
      {bots.map((bot) => {
        const st = states.find((s) => s.id === bot.id)
        const choices = withCurrent(models[bot.cli] || [], bot.model)
        return (
          <div className="desk-row" key={bot.id}>
            <button type="button" className="flink" onClick={() => openThread(bot.id === CONDUCTOR ? null : bot.id)}>
              {bot.name}
            </button>
            <span className="tiny">{CLI_LABEL[bot.cli]}</span>
            <button type="button" className="ghost" onClick={() => setPickerFor(pickerFor === bot.id ? null : bot.id)}>
              {modelLabel(bot.model, choices)}
            </button>
            {pickerFor === bot.id ? (
              <div className="picker">
                {choices.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setPickerFor(null)
                      void saveBot({ id: bot.id, name: bot.name, cli: bot.cli, model: m.id, effort: bot.effort, description: bot.description })
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="tiny">{stateLine(st, who, choices)}</span>
            {st?.state === 'working' ? (
              <button type="button" className="ghost" onClick={() => void window.brain.desk.stop(id, bot.id)}>
                Stop
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={() => { setForm(bot); setNote('') }}>
              Edit
            </button>
          </div>
        )
      })}
      <button type="button" className="ghost" onClick={() => { setForm(null); setNote('') }}>
        Add a teammate
      </button>
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
        {openBotId ? (
          <button type="button" className="ghost" onClick={() => openThread(null)}>Team</button>
        ) : null}
      </div>
      <div className="thread">
        {messages.length === 0 && welcome ? (
          <div className="bubble md">
            <p>{welcome.greeting}</p>
            {welcome.starters.map((s) => (
              <button key={s.label} type="button" className="ghost" onClick={() => setDraft(s.fill)}>{s.label}</button>
            ))}
          </div>
        ) : null}
        {messages.map((msg) => {
          const botId = msg.hire?.id || msg.from
          const st = states.find((s) => s.id === botId)
          const queued = msg.kind === 'task' && msg.from === 'me' && msg.to === CONDUCTOR && !openBotId && conductor?.state === 'working' && conductor.task.split('\n')[0] !== msg.text.split('\n')[0]
          return (
            <div key={msg.id}>
              <DeskCard
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
                onOpenBrowser={() => void window.brain.desk.focus(id)}
                onRemoveHire={(msgId) => {
                  const hire = messages.find((m) => m.id === msgId)?.hire
                  if (!hire) return
                  const stHire = states.find((s) => s.id === hire.id)
                  if (busyState(stHire)) return
                  if (hire.hasWorked) setRemoveAsk({ id: hire.id, name: hire.name })
                  else void removeBot(hire.id)
                }}
              />
              {queued ? <p className="tiny">Conductor will read this next.</p> : null}
            </div>
          )
        })}
      </div>
      {bg ? (
        <button type="button" className="linkish" onClick={() => void window.brain.desk.status(id)}>{bg}</button>
      ) : null}
      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={welcome?.composerPlaceholder || 'Message Conductor'}
          disabled={!!welcome?.composerDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="primary" type="button" disabled={!!welcome?.composerDisabled} onClick={send}>Send</button>
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
