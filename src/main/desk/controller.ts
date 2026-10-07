import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSE_MAX_STEPS,
  CLI_LABEL,
  CONDUCTOR,
  ME,
  MEMORY_WEEK_CHARS,
  SLOW_TURN_MS,
  botHire,
  botIdFromName,
  botSlug,
  isoWeek
} from '../../shared/desk.ts'
import type { BotState, DeskBot, DeskCli, DeskMessage, DeskSendResult, DeskSystem } from '../../shared/desk.ts'
import type { BrowseStepResult } from '../../shared/desk.ts'
import { createDeskBus, jobIsOpen } from './bus.ts'
import type { DeskBus, JobView, Turn } from './bus.ts'
import { parseFences } from './fences.ts'
import type { BrowseBlock, ParsedTurn } from './fences.ts'
import { memoryFile } from './paths.ts'
import { packPaths } from './pack.ts'
import {
  compactPrompt,
  conductorPrompt,
  refusalLine,
  signInLine,
  workerPrompt
} from './runner.ts'
import type { BrowseRefusal, DeskRunner, DeskWake, PageView, RunResult } from './runner.ts'
import type { EmailTile, TextLookup } from './senders.ts'
import { createDeskStore, foldMessages, mergeStanding } from './store.ts'
import type { DeskStore, NewDeskMessage, Role } from './store.ts'

/**
 * One desk on one brain folder. The bus owns delivery and the close rule.
 * This file owns turns: prompts, fences, tiles, the browser session, and memory tidy.
 */

const GMAIL_OUT = "Gmail isn't signed in on this Mac."
const GMAIL_MISSING = "That email isn't in Gmail, so this stays a draft."
const SPEND_NOTE = 'Approving records your yes. It does not spend money or change the ads account.'
const WHATSAPP_NOTE = "WhatsApp send from Desk isn't set up. This stays a draft."
const NO_CHROME = 'The desk browser needs Google Chrome on this Mac.'
const PAGE_CHANGED = 'The page changed, so that click was not made.'
const NO_SUBMIT = "Couldn't find a submit button."
const PAY_REFUSE = 'That button stays unclicked. Send it from a tile instead.'
const ALREADY_SENT = 'That message already went.'
const REVISION_KIND = 'That change was left out. An email stays an email, and a text stays a text.'
const NO_MODEL = 'No model app is installed on this Mac.'
const QUIT_TEXT = 'Stopped when Brain quit.'
const CLOSED_TEXT = 'Stopped when you closed Desk.'
const BODY_MAX = 2000

export type DeskSenders = {
  gmailFrom: (brain: string) => Promise<string | null>
  check: (brain: string, messageId: string) => Promise<'ok' | 'missing' | 'no-token'>
  sendEmail: (brain: string, tile: EmailTile) => Promise<DeskSendResult>
  lookupText: (brain: string, to: string) => Promise<TextLookup>
  sendText: (brain: string, guid: string, body: string) => Promise<DeskSendResult>
  sendWhatsApp: () => DeskSendResult
}

type SendBack = DeskSendResult & { error?: string }

export type ControllerOpts = {
  brain: string
  role?: Role
  runner: Pick<DeskRunner, 'run' | 'stop' | 'stopAll' | 'keepWaiting'>
  browser: {
    open: (browseId: string) => Promise<void | { noChrome: true }>
    cancel: (browseId: string) => void
    release: (browseId: string) => void
    focus: () => void
    windowOpen: () => boolean
    clickApproved: (name: string, pageUrl: string) => Promise<BrowseStepResult>
    runStep: (browseId: string, step: { action: string; detail?: string; url?: string }) => Promise<BrowseStepResult>
  }
  senders: DeskSenders
  detect: () => Record<DeskCli, boolean>
  now?: () => Date
  tokenReady?: (brain: string) => boolean
  isOpen?: typeof jobIsOpen
}

type Session = {
  browseId: string
  steps: number
  done: boolean
  page?: PageView
  refusal?: BrowseRefusal
}

type Slow = { keep: () => void; clear: () => void }

function cutBody(body: string): string {
  if (body.length <= BODY_MAX) return body
  const cut = body.slice(0, BODY_MAX)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl) : cut
}

function daysOld(date: string, now: Date): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, (m || 1) - 1, d || 1)) / 86_400_000)
}

function sectionText(file: string, title: string): string {
  let lines: string[] = []
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return ''
  }
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.slice(2).trim().toLowerCase() === title.toLowerCase())
  if (start < 0) return ''
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n').trim()
}

function defaultTokenReady(brain: string): boolean {
  const account = process.env.GOOGLE_ACCOUNT || process.env.GMAIL_ACCOUNT || 'plyntr'
  const name = `token-${account}.json`
  return existsSync(join(homedir(), '.brain-secrets', 'google', name)) || existsSync(join(brain, 'auth', 'google', name))
}

function sendOk(r: SendBack): boolean {
  if (r.ok) return true
  return String(r.error || '').includes('no matching chat.db row')
}

export function createDeskController(opts: ControllerOpts) {
  const now = opts.now || (() => new Date())
  const tokenReady = opts.tokenReady || defaultTokenReady
  const isOpen = opts.isOpen || jobIsOpen
  const store: DeskStore = createDeskStore({ brain: opts.brain, role: opts.role })
  const { runner, browser, senders } = opts

  const sessions = new Map<string, Session>()
  const wakes = new Map<string, DeskWake>()
  const tidying = new Set<string>()
  const browserWaiting = new Set<string>()
  const trying = new Set<string>()
  const dead = new Set<number>()
  const startedModel = new Map<string, string>()
  const taskText = new Map<string, string>()
  const since = new Map<string, string>()
  const slows = new Map<string, Slow>()
  let pending = 0
  const waiters: Array<() => void> = []
  const inflight = new Map<string, Promise<void>>()

  let bus: DeskBus

  function poke() {
    if (pending !== 0) return
    const left = waiters.splice(0)
    for (const w of left) w()
  }

  function whenIdle(): Promise<void> {
    if (pending === 0) return Promise.resolve()
    return new Promise((resolve) => waiters.push(resolve))
  }

  function halted(turn: Turn): boolean {
    return dead.has(turn.id) || bus.turnOf(turn.botId)?.id !== turn.id
  }

  function post(input: NewDeskMessage) {
    return bus.post(input)
  }

  function postSystem(from: string, system: DeskSystem, text: string) {
    return post({ from, to: ME, kind: 'system', system, text })
  }

  function armSlow(bot: DeskBot) {
    slows.get(bot.id)?.clear()
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        postSystem(bot.id, 'slow', `${bot.name} is still working.`)
        arm()
      }, SLOW_TURN_MS)
    }
    arm()
    const handle: Slow = {
      keep: arm,
      clear: () => {
        clearTimeout(timer)
        if (slows.get(bot.id) === handle) slows.delete(bot.id)
      }
    }
    slows.set(bot.id, handle)
    return handle
  }

  function names(): Record<string, string> {
    return { ...store.names(), ...removedNames() }
  }

  function removedNames(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of store.readMail()) if (m.system === 'removed' && m.name) out[m.from] = m.name
    return out
  }

  function taken() {
    const ids = store.readBots().map((b) => b.id)
    const nameList = store.readBots().map((b) => b.name)
    for (const m of store.readMail()) {
      if (m.system !== 'removed' || !m.name) continue
      ids.push(m.from)
      nameList.push(m.name)
    }
    return { ids, names: nameList }
  }

  function visible(id: string): DeskMessage | undefined {
    const mail = store.readMail()
    const chain = new Set<string>([id])
    for (const m of mail) if (m.replaces && chain.has(m.replaces)) chain.add(m.id)
    return foldMessages(mail).find((m) => chain.has(m.id))
  }

  function openTile(botId: string, job?: string): DeskMessage | undefined {
    return foldMessages(store.readMail()).find((m) => {
      if (m.from !== botId) return false
      if (job && m.job !== job) return false
      if (m.kind === 'email' || m.kind === 'text') return !m.actedAt
      if (m.kind === 'hold') return !m.hold?.answer
      return false
    })
  }

  function jobView(): JobView {
    const bots = store.readBots()
    return {
      running: bus.running().map((t) => ({ botId: t.botId, job: t.job })),
      queued: bots.flatMap((b) => bus.queued(b.id).map((m) => ({ job: m.job }))),
      mail: store.readMail(),
      live: bots.map((b) => b.id)
    }
  }

  function settle(job?: string) {
    if (!job) return
    const open = isOpen(job, jobView())
    if (open || bus.isClosed(job)) return
    bus.checkJob(job)
  }

  function stateOf(bot: DeskBot): BotState {
    const model = startedModel.get(bot.id) || bot.model
    const fileModel = store.readBot(bot.id)?.model
    const nextModel = fileModel && startedModel.has(bot.id) && fileModel !== model ? fileModel : undefined
    if (tidying.has(bot.id) || browserWaiting.has(bot.id)) {
      return {
        id: bot.id,
        state: 'working',
        since: since.get(bot.id) || now().toISOString(),
        task: tidying.has(bot.id) ? 'Tidying memory' : 'Waiting for the desk browser',
        model,
        ...(nextModel ? { nextModel } : {}),
        ...(trying.has(bot.id) ? { trying: true } : {})
      }
    }
    const live = bus.state(bot.id)
    if (live.state === 'working') {
      const queued = bus.queued(bot.id).length
      return {
        id: bot.id,
        state: 'working',
        since: since.get(bot.id) || now().toISOString(),
        task: taskText.get(bot.id) || 'Working',
        model,
        ...(nextModel ? { nextModel } : {}),
        ...(trying.has(bot.id) ? { trying: true } : {}),
        ...(queued > 0 ? { queued } : {})
      }
    }
    if (live.state === 'waiting-you') return { id: bot.id, state: 'waiting-you' }
    if (live.state === 'waiting-bot') return { id: bot.id, state: 'waiting-bot', on: live.on }
    if (!Object.values(opts.detect()).some(Boolean)) return { id: bot.id, state: 'not-set-up', cli: bot.cli }
    return { id: bot.id, state: 'idle' }
  }

  function states(): BotState[] {
    return store.readBots().map(stateOf)
  }

  function endSession(botId: string) {
    const session = sessions.get(botId)
    if (!session) return
    browser.release(session.browseId)
    sessions.delete(botId)
  }

  async function model(bot: DeskBot, prompt: string, allowFallback: boolean): Promise<RunResult> {
    const slow = armSlow(bot)
    const result = await runner.run({
      bot,
      prompt,
      brain: opts.brain,
      onTry: (_pair, index) => {
        if (index > 0) trying.add(bot.id)
      }
    })
    slow.clear()
    trying.delete(bot.id)
    if (allowFallback && result.status === 'ok' && result.used) {
      postSystem(bot.id, 'fallback', `${bot.name}'s model didn't answer. Used ${CLI_LABEL[result.used.cli]}.`)
    }
    return result
  }

  function postError(bot: DeskBot, turn: Turn, result: Extract<RunResult, { status: 'failed' }>) {
    const none = !Object.values(opts.detect()).some(Boolean)
    const text =
      result.failure === 'not-installed' && none
        ? NO_MODEL
        : result.failure === 'not-signed-in'
          ? `${CLI_LABEL[result.lastTry.cli]} isn't signed in. Open a Chat tab with ${CLI_LABEL[result.lastTry.cli]}, sign in there, then Try again.`
          : result.failure === 'empty'
            ? `${bot.name} finished without saying anything.`
            : `${bot.name} stopped with an error.`
    const tile = openTile(bot.id, turn.job)
    post({
      from: bot.id,
      to: ME,
      kind: 'error',
      text,
      failure: result.failure,
      ...(result.detail ? { detail: result.detail } : {}),
      lastTry: result.lastTry,
      inputs: tile ? [] : turn.batch.map((m) => m.id)
    })
  }

  function postProse(bot: DeskBot, prose: string, kind: 'reply' | 'report', result: Extract<RunResult, { status: 'ok' }>, started: number) {
    const text = prose.trim()
    if (!text) return
    post({
      from: bot.id,
      to: ME,
      kind,
      text,
      ...(result.used ? { used: result.used } : {}),
      ...(kind === 'report' ? { report: { seconds: Math.max(0, Math.round((now().getTime() - started) / 1000)) } } : {})
    })
  }

  function remember(bot: DeskBot, lines: string[]) {
    if (!lines.length) return
    const { added } = store.appendMemory(bot.id, lines, now())
    if (!added.length) return
    post({ from: bot.id, to: ME, kind: 'note', text: added.join('\n'), noteLines: added })
  }

  function deliverWork(bot: DeskBot, parsed: ParsedTurn) {
    for (const a of parsed.assigns) {
      post({ from: bot.id, to: a.bot, kind: 'pack', text: a.task, pack: packPaths(opts.brain, a.files, a.why) })
    }
    for (const s of parsed.sends) {
      const pack = s.files.length ? packPaths(opts.brain, s.files, '') : undefined
      post({ from: bot.id, to: s.to, kind: 'send', text: s.text, ...(pack ? { pack } : {}) })
    }
    remember(bot, parsed.remember)
  }

  function hire(block: ParsedTurn['hire']) {
    if (!block) return
    const have = taken()
    const id = botIdFromName(block.name, have)
    const named = botHire(block.name, have)
    const bot: Omit<DeskBot, 'file'> = {
      id,
      name: named.name,
      cli: block.cli,
      model: block.model || 'default',
      effort: block.effort || 'default',
      description: block.description
    }
    store.saveBot(bot)
    store.createMemory(id)
    post({
      from: CONDUCTOR,
      to: ME,
      kind: 'hire',
      text: block.description,
      hire: { id, name: named.name, cli: block.cli, model: bot.model, description: block.description, hasWorked: false }
    })
  }

  async function storeEmail(bot: DeskBot, block: NonNullable<ParsedTurn['email']>, replaces?: string) {
    const body = cutBody(block.body)
    let from = await senders.gmailFrom(opts.brain)
    let sendable = Boolean(from)
    let note: string | undefined
    if (!from) {
      from = GMAIL_OUT
      note = GMAIL_OUT
      sendable = false
    } else if (block.replyTo) {
      if (!tokenReady(opts.brain)) {
        sendable = false
        note = GMAIL_OUT
      } else {
        const checked = await senders.check(opts.brain, block.replyTo)
        if (checked === 'missing') {
          sendable = false
          note = GMAIL_MISSING
        } else if (checked !== 'ok') {
          sendable = false
          note = GMAIL_OUT
        }
      }
    }
    post({
      from: bot.id,
      to: ME,
      kind: 'email',
      text: block.subject,
      ...(replaces ? { replaces } : {}),
      email: { replyTo: block.replyTo, to: block.to, cc: block.cc, subject: block.subject, body, from, sendable, ...(note ? { note } : {}) }
    })
  }

  async function storeSms(bot: DeskBot, block: NonNullable<ParsedTurn['sms']>, replaces?: string) {
    const body = cutBody(block.body)
    if (block.via === 'WhatsApp') {
      post({
        from: bot.id,
        to: ME,
        kind: 'text',
        text: block.to,
        ...(replaces ? { replaces } : {}),
        textMsg: { to: block.to, via: 'WhatsApp', body, sendable: false, note: WHATSAPP_NOTE }
      })
      return
    }
    const found = await senders.lookupText(opts.brain, block.to)
    post({
      from: bot.id,
      to: ME,
      kind: 'text',
      text: found.label || block.to,
      ...(replaces ? { replaces } : {}),
      textMsg: {
        to: block.to,
        via: 'iMessage',
        body,
        sendable: found.sendable,
        ...(found.note ? { note: found.note } : {}),
        ...(found.guid ? { chatGuid: found.guid } : {}),
        ...(found.label ? { chatLabel: found.label } : {})
      }
    })
  }

  function storeHold(bot: DeskBot, block: NonNullable<ParsedTurn['hold']>) {
    post({
      from: bot.id,
      to: ME,
      kind: 'hold',
      text: `${block.text} ${SPEND_NOTE}`,
      hold: { need: block.need }
    })
  }

  async function storeFreshTiles(bot: DeskBot, parsed: ParsedTurn) {
    if (parsed.email) await storeEmail(bot, parsed.email)
    if (parsed.sms) await storeSms(bot, parsed.sms)
    if (parsed.hold) storeHold(bot, parsed.hold)
  }

  async function storeRevision(bot: DeskBot, parsed: ParsedTurn, waiting: DeskMessage) {
    const still = `${bot.name} is still waiting on your answer, so that was left out.`
    if (waiting.kind === 'hold') {
      if (parsed.hold || parsed.email || parsed.sms) postSystem(bot.id, 'extra-tile', still)
      return
    }
    if (parsed.hold) postSystem(bot.id, 'extra-tile', still)
    const want = waiting.kind === 'email' ? 'email' : 'text'
    if (parsed.email && want !== 'email') postSystem(bot.id, 'revision-kind', REVISION_KIND)
    if (parsed.sms && want !== 'text') postSystem(bot.id, 'revision-kind', REVISION_KIND)
    const next = parsed.email && want === 'email' ? 'email' : parsed.sms && want === 'text' ? 'text' : null
    if (!next) return
    const copy = visible(waiting.id)
    if (!copy || copy.actedAt) {
      postSystem(bot.id, 'already-sent', ALREADY_SENT)
      return
    }
    if (next === 'email' && parsed.email) await storeEmail(bot, parsed.email, copy.id)
    if (next === 'text' && parsed.sms) await storeSms(bot, parsed.sms, copy.id)
  }

  function browseLine(block: BrowseBlock, result: BrowseStepResult): { text: string; refusal?: BrowseRefusal } {
    if ('ok' in result && result.ok) {
      if (block.action === 'url') return { text: `Opened ${result.url}` }
      if (block.action === 'click') return { text: `Clicked ${block.detail}` }
      if (block.action === 'type') return { text: `Typed into ${block.field || block.detail}` }
      if (block.action === 'scroll') return { text: 'Scrolled' }
      return { text: 'Pressed Enter' }
    }
    if ('signIn' in result) return { text: '' }
    if ('noChrome' in result) return { text: NO_CHROME }
    if ('hold' in result) return { text: '' }
    if (!('refused' in result)) return { text: '' }
    const name = 'name' in result ? result.name : undefined
    const refusal: BrowseRefusal = { refused: result.refused, ...(name ? { name } : {}) }
    return { text: refusalLine(refusal, []), refusal }
  }

  function postBrowse(bot: DeskBot, session: Session, text: string, step: { action: string; detail: string; url: string }, extra: { signIn?: boolean; noChrome?: boolean; title?: string } = {}) {
    post({
      from: bot.id,
      to: ME,
      kind: 'browse',
      text,
      browseId: session.browseId,
      browse: {
        steps: [step],
        ...(extra.title ? { title: extra.title } : {}),
        ...(extra.signIn ? { signIn: true } : {}),
        ...(extra.noChrome ? { noChrome: true } : {})
      }
    })
  }

  async function doBrowse(bot: DeskBot, turn: Turn, block: BrowseBlock): Promise<'again' | 'signin' | 'wait' | 'stop'> {
    let session = sessions.get(bot.id)
    if (block.action !== 'url' && !session?.page) {
      postSystem(bot.id, 'no-page', 'Open a page first.')
      return 'stop'
    }
    if (!session) {
      session = { browseId: store.newId('b'), steps: 0, done: false }
      sessions.set(bot.id, session)
    }
    if (block.action === 'url') {
      browserWaiting.add(bot.id)
      const slow = armSlow(bot)
      const opened = await browser.open(session.browseId)
      slow.clear()
      browserWaiting.delete(bot.id)
      if (halted(turn)) {
        browser.cancel(session.browseId)
        return 'stop'
      }
      if (opened && 'noChrome' in opened) {
        postBrowse(bot, session, NO_CHROME, { action: 'url', detail: block.detail, url: block.url || '' }, { noChrome: true })
        endSession(bot.id)
        return 'stop'
      }
    }
    const result = await browser.runStep(session.browseId, { action: block.action, detail: block.detail, url: 'url' in block ? block.url : undefined })
    if ('hold' in result) {
      post({
        from: bot.id,
        to: ME,
        kind: 'hold',
        text: `Approving clicks ${result.name} in the desk browser. Other browsing waits until you answer.`,
        browseId: session.browseId,
        hold: { need: 'spend', browseClick: result.name, pageUrl: result.url, browseId: session.browseId }
      })
      return 'wait'
    }
    if ('signIn' in result) {
      postBrowse(bot, session, signInLine(bot.name), { action: block.action, detail: block.detail, url: result.url }, { signIn: true, title: result.title })
      endSession(bot.id)
      return 'signin'
    }
    if ('noChrome' in result) {
      postBrowse(bot, session, NO_CHROME, { action: block.action, detail: block.detail, url: '' }, { noChrome: true })
      endSession(bot.id)
      return 'stop'
    }
    const pageControls = session.page?.controls || []
    if ('refused' in result) {
      const name = 'name' in result ? result.name : undefined
      const refusal: BrowseRefusal = { refused: result.refused, ...(name ? { name } : {}) }
      const line = refusalLine(refusal, pageControls)
      session.refusal = refusal
      session.steps += 1
      if (session.steps >= BROWSE_MAX_STEPS) session.done = true
      postBrowse(bot, session, line, { action: block.action, detail: line, url: result.url })
      if (result.refused === 'pay') postSystem(bot.id, 'bad-hold', PAY_REFUSE)
      if (result.refused === 'no-submit') postSystem(bot.id, 'no-submit', NO_SUBMIT)
      if (result.refused === 'page-changed') postSystem(bot.id, 'page-changed', PAGE_CHANGED)
      return 'again'
    }
    session.page = { url: result.url, title: result.title, text: result.text, controls: result.controls }
    session.refusal = undefined
    session.steps += 1
    if (session.steps >= BROWSE_MAX_STEPS) session.done = true
    const line = browseLine(block, result).text
    postBrowse(bot, session, line, { action: block.action, detail: block.detail, url: result.url }, { title: result.title })
    return 'again'
  }

  async function runConductor(bot: DeskBot, turn: Turn, started: number) {
    await weekly(bot)
    const stillQueued = new Set(bus.queued(bot.id).map((m) => m.id))
    const prompt = conductorPrompt({
      bot,
      bots: store.readBots(),
      states: states(),
      memory: store.readMemory(bot.id, now()),
      mail: store.readMail().filter((m) => !stillQueued.has(m.id)),
      batch: turn.batch,
      holds: foldMessages(store.readMail()).filter((m) => m.kind === 'hold' && !m.hold?.answer),
      names: names()
    })
    const result = await model(bot, prompt, true)
    if (halted(turn) || result.status === 'stopped') return
    if (result.status === 'failed') {
      postError(bot, turn, result)
      return
    }
    const parsed = parseFences(result.text, { from: bot.id, bots: store.readBots() })
    for (const f of parsed.flags) postSystem(bot.id, f.system, f.text)
    if (parsed.flags.some((f) => f.system === 'parse-failed')) return
    hire(parsed.hire)
    deliverWork(bot, parsed)
    postProse(bot, parsed.prose, 'reply', result, started)
  }

  async function runWorker(bot: DeskBot, turn: Turn, started: number) {
    let wake = wakes.get(bot.id)
    wakes.delete(bot.id)
    let signInFollow = false
    for (let n = 0; n < BROWSE_MAX_STEPS + 2; n++) {
      if (halted(turn)) return
      await weekly(bot)
      const waiting = turn.job ? openTile(bot.id, turn.job) : undefined
      const session = sessions.get(bot.id)
      const showPage = session?.page && wake !== 'no' && wake !== 'sign-in' && !signInFollow
      const prompt = workerPrompt({
        bot,
        bots: store.readBots(),
        memory: store.readMemory(bot.id, now()),
        mail: store.readMail(),
        job: turn.job || '',
        batch: n === 0 ? turn.batch : [],
        ...(waiting ? { tile: waiting } : {}),
        ...(showPage && session?.page ? { page: session.page } : {}),
        ...(showPage && session?.refusal ? { refusal: session.refusal } : {}),
        ...(session ? { steps: session.steps } : {}),
        ...(wake ? { wake } : {}),
        names: names()
      })
      const result = await model(bot, prompt, true)
      if (halted(turn) || result.status === 'stopped') return
      if (result.status === 'failed') {
        postError(bot, turn, result)
        if (session && !(waiting?.kind === 'hold' && waiting.hold?.browseClick)) endSession(bot.id)
        return
      }
      const parsed = parseFences(result.text, { from: bot.id, bots: store.readBots() })
      for (const f of parsed.flags) postSystem(bot.id, f.system, f.text)
      if (parsed.flags.some((f) => f.system === 'parse-failed')) return
      const live = sessions.get(bot.id)
      if (live?.done && parsed.browse) {
        postSystem(bot.id, 'browse-limit', `${bot.name} stopped after 8 browser steps.`)
        postProse(bot, parsed.prose, 'reply', result, started)
        endSession(bot.id)
        return
      }
      const blocked = Boolean(waiting)
      if (parsed.browse && blocked) postSystem(bot.id, 'extra-tile', `${bot.name} is still waiting on your answer, so that was left out.`)
      if (parsed.browse && !blocked && !signInFollow) {
        const action = await doBrowse(bot, turn, parsed.browse)
        if (parsed.prose.trim()) postProse(bot, parsed.prose, 'reply', result, started)
        if (halted(turn)) return
        if (action === 'again') {
          wake = undefined
          continue
        }
        if (action === 'signin') {
          wake = 'sign-in'
          signInFollow = true
          continue
        }
        return
      }
      deliverWork(bot, parsed)
      if (waiting && (waiting.kind === 'email' || waiting.kind === 'text' || waiting.kind === 'hold')) await storeRevision(bot, parsed, waiting)
      else await storeFreshTiles(bot, parsed)
      const tileNow = turn.job ? openTile(bot.id, turn.job) : undefined
      const finished = !parsed.sends.length && !parsed.hold && !parsed.email && !parsed.sms && !parsed.browse && !tileNow
      if (live && !parsed.browse && !(waiting?.kind === 'hold' && waiting.hold?.browseClick)) endSession(bot.id)
      postProse(bot, parsed.prose, finished ? 'report' : 'reply', result, started)
      return
    }
  }

  async function runTurn(turn: Turn) {
    const bot = store.readBot(turn.botId)
    if (!bot) return
    since.set(bot.id, now().toISOString())
    startedModel.set(bot.id, bot.model)
    taskText.set(bot.id, (turn.batch[0]?.text || 'Working').split('\n')[0])
    const started = now().getTime()
    if (bot.id === CONDUCTOR) await runConductor(bot, turn, started)
    else await runWorker(bot, turn, started)
    startedModel.delete(bot.id)
  }

  function weekRows(id: string) {
    return store.memoryWeek(id)
  }

  function weekSize(rows: { date: string; line: string }[]): number {
    if (!rows.length) return 0
    let n = '## This week\n'.length
    let last = ''
    for (const r of rows) {
      if (r.date !== last) {
        n += `### ${r.date}\n`.length
        last = r.date
      }
      n += `${r.line}\n`.length
    }
    return n
  }

  async function tidy(bot: DeskBot, lines: { date: string; line: string }[], weeklyPass: boolean) {
    if (!lines.length) {
      if (weeklyPass) store.writeWeekMarker(bot.id, isoWeek(now()))
      return
    }
    tidying.add(bot.id)
    bus.pause(bot.id)
    const standing = sectionText(memoryFile(opts.brain, bot.id), 'Standing')
    const prompt = compactPrompt(standing, lines)
    const effort = bot.cli === 'grok' || bot.cli === 'claude' ? 'low' : bot.effort
    let merged: string[] | null = null
    try {
      const result = await model({ ...bot, effort }, prompt, false)
      if (result.status === 'ok') merged = mergeStanding(result.text)
    } finally {
      store.foldMemory(bot.id, lines, merged)
      if (weeklyPass) store.writeWeekMarker(bot.id, isoWeek(now()))
      tidying.delete(bot.id)
      bus.resume(bot.id)
    }
  }

  async function weekly(bot: DeskBot) {
    const old = weekRows(bot.id).filter((r) => daysOld(r.date, now()) > 7)
    if (!old.length || store.readWeekMarker(bot.id) === isoWeek(now())) return
    await tidy(bot, old, true)
  }

  async function overflow(bot: DeskBot) {
    let rows = weekRows(bot.id)
    if (weekSize(rows) <= MEMORY_WEEK_CHARS) return
    const folding: { date: string; line: string }[] = []
    while (rows.length && weekSize(rows) > MEMORY_WEEK_CHARS) {
      folding.push(rows[0])
      rows = rows.slice(1)
    }
    await tidy(bot, folding, false)
  }

  async function onWake(turn: Turn) {
    pending++
    let bot = store.readBot(turn.botId)
    try {
      await runTurn(turn)
    } finally {
      if (bus.turnOf(turn.botId)?.id === turn.id) bus.endTurn(turn.botId, turn.id)
      settle(turn.job)
      bot = store.readBot(turn.botId)
      if (bot && !dead.has(turn.id)) await overflow(bot)
      pending--
      poke()
    }
  }

  bus = createDeskBus({
    store,
    wake: (turn) => {
      const p = onWake(turn)
      inflight.set(turn.botId, p)
      p.finally(() => {
        if (inflight.get(turn.botId) === p) inflight.delete(turn.botId)
      })
      p.catch(() => undefined)
      return p
    }
  })

  function busyIds(): string[] {
    return store.readBots().filter((b) => stateOf(b).state === 'working').map((b) => b.id)
  }

  function stopChildren(ids: string[]) {
    for (const id of ids) {
      const turn = bus.turnOf(id)
      if (turn) dead.add(turn.id)
      runner.stop(id)
      const session = sessions.get(id)
      if (session) browser.cancel(session.browseId)
      browserWaiting.delete(id)
      slows.get(id)?.clear()
      if (turn) {
        bus.endTurn(id, turn.id)
        bus.stopped(id)
      }
    }
  }

  async function say(text: string, to = CONDUCTOR) {
    const res = post({ from: ME, to, kind: 'task', text })
    await whenIdle()
    return res
  }

  async function answerHold(id: string, answer: 'yes' | 'no') {
    const tile = visible(id)
    if (!tile || tile.kind !== 'hold' || tile.hold?.answer) return
    const bot = store.readBot(tile.from)
    if (answer === 'yes' && tile.hold?.browseClick && tile.hold.pageUrl) {
      const result = await browser.clickApproved(tile.hold.browseClick, tile.hold.pageUrl)
      const session = sessions.get(tile.from)
      if (session) {
        session.steps += 1
        if (session.steps >= BROWSE_MAX_STEPS) session.done = true
        if ('refused' in result && result.refused === 'page-changed') {
          session.refusal = { refused: 'page-changed' }
          postSystem(tile.from, 'page-changed', PAGE_CHANGED)
        } else if ('ok' in result && result.ok) {
          session.page = { url: result.url, title: result.title, text: result.text, controls: result.controls }
          session.refusal = undefined
        }
      }
      if (!bot) return
      wakes.set(tile.from, 'approved')
    } else if (answer === 'no' && tile.hold?.browseClick) {
      endSession(tile.from)
      wakes.set(tile.from, 'no')
    } else if (answer === 'no') wakes.set(tile.from, 'no')
    else wakes.set(tile.from, 'approved')
    bus.answer({
      replaces: tile.id,
      from: tile.from,
      to: tile.to,
      kind: 'hold',
      text: tile.text,
      hold: { ...tile.hold, need: tile.hold?.need || 'spend', answer },
      ...(answer === 'yes' ? { actedAt: now().toISOString() } : {})
    })
    settle(tile.job)
    await whenIdle()
  }

  async function answerMail(id: string, answer: 'yes' | 'no', kind: 'email' | 'text') {
    const tile = visible(id)
    if (!tile || tile.kind !== kind || tile.actedAt) return
    const payload = kind === 'email' ? tile.email : tile.textMsg
    if (!payload?.sendable && answer === 'yes') return
    let result: SendBack | null = null
    if (answer === 'yes' && kind === 'email' && tile.email) {
      result = await senders.sendEmail(opts.brain, {
        to: tile.email.to,
        cc: tile.email.cc,
        subject: tile.email.subject,
        body: tile.email.body,
        ...(tile.email.replyTo ? { replyTo: tile.email.replyTo } : {})
      })
    }
    if (answer === 'yes' && kind === 'text' && tile.textMsg) {
      if (tile.textMsg.via === 'WhatsApp' || !tile.textMsg.chatGuid) return
      result = await senders.sendText(opts.brain, tile.textMsg.chatGuid, tile.textMsg.body)
    }
    if (answer === 'yes' && result) {
      const ok = sendOk(result)
      const note = result.note || result.error
      const sendable = typeof result.sendable === 'boolean' ? result.sendable : ok ? payload?.sendable : false
      bus.answer({
        replaces: tile.id,
        from: tile.from,
        to: tile.to,
        kind,
        text: tile.text,
        ...(kind === 'email' && tile.email
          ? { email: { ...tile.email, ...(ok ? { sent: 'yes' as const } : {}), ...(note ? { note } : {}), ...(typeof sendable === 'boolean' ? { sendable } : {}) } }
          : {}),
        ...(kind === 'text' && tile.textMsg
          ? { textMsg: { ...tile.textMsg, ...(ok ? { sent: 'yes' as const } : {}), ...(note ? { note } : {}), ...(typeof sendable === 'boolean' ? { sendable } : {}) } }
          : {}),
        ...(ok ? { actedAt: now().toISOString() } : {})
      })
      if (ok) wakes.set(tile.from, 'sent')
    }
    if (answer === 'no' && payload) {
      wakes.set(tile.from, 'no')
      bus.answer({
        replaces: tile.id,
        from: tile.from,
        to: tile.to,
        kind,
        text: tile.text,
        ...(kind === 'email' && tile.email ? { email: { ...tile.email, sent: 'no' } } : {}),
        ...(kind === 'text' && tile.textMsg ? { textMsg: { ...tile.textMsg, sent: 'no' } } : {})
      })
    }
    settle(tile.job)
    await whenIdle()
  }

  return {
    store,
    bus,
    say,
    open: async () => {
      for (const bot of store.readBots()) await weekly(bot)
    },
    answerHold,
    answerEmail: (id: string, answer: 'yes' | 'no') => answerMail(id, answer, 'email'),
    answerText: (id: string, answer: 'yes' | 'no') => answerMail(id, answer, 'text'),
    async stop(botId: string) {
      const bot = store.readBot(botId)
      const turn = bus.turnOf(botId)
      const tile = openTile(botId, turn?.job)
      const inputs = tile || tidying.has(botId) ? [] : turn?.batch.map((m) => m.id) || []
      const running = inflight.get(botId)
      stopChildren([botId])
      if (bot) post({ from: botId, to: ME, kind: 'stopped', text: `You stopped ${bot.name}.`, inputs, ...(turn?.job ? { job: turn.job } : {}) })
      settle(turn?.job)
      if (running) await running
    },
    keepWaiting(botId: string) {
      slows.get(botId)?.keep()
      runner.keepWaiting(botId)
    },
    async continueJob(job: string) {
      const msgs = bus.continueJob(job)
      await whenIdle()
      return msgs
    },
    async stopJob(job: string) {
      const res = bus.stopJob(job)
      stopChildren(res.bots)
      settle(job)
      await whenIdle()
      return res
    },
    async retry(msgId: string) {
      const msg = store.readMail().find((m) => m.id === msgId)
      if (!msg?.inputs?.length) return
      const inputs = store.readMail().filter((m) => msg.inputs?.includes(m.id))
      for (const input of inputs) {
        post({ from: input.from, to: input.to, kind: input.kind, text: input.text, ...(input.pack ? { pack: input.pack } : {}) })
      }
      await whenIdle()
    },
    status() {
      const lines = store.readBots().map((b) => {
        const s = stateOf(b)
        const who = names()[b.id] || b.name
        if (s.state === 'working') return `${who} · ${s.task} · 0m`
        if (s.state === 'waiting-bot') return `${who} · waiting for ${names()[s.on] || s.on}`
        if (s.state === 'waiting-you') return `${who} · waiting on you`
        if (s.state === 'not-set-up') return `${who} · not set up`
        return `${who} · idle`
      })
      return post({ from: ME, to: ME, kind: 'status', text: lines.join('\n') })
    },
    focus() {
      browser.focus()
    },
    removeBot(id: string): string | null {
      const bot = store.readBot(id)
      if (!bot) return null
      const st = stateOf(bot)
      if (st.state === 'working' || st.state === 'waiting-you' || st.state === 'waiting-bot') {
        return `${bot.name} is in the middle of something. Finish or stop that first.`
      }
      const jobs = bus.dropBot(id)
      for (const m of foldMessages(store.readMail())) {
        if (m.from !== id) continue
        if ((m.kind === 'email' || m.kind === 'text') && !m.actedAt) {
          bus.answer({
            replaces: m.id,
            from: id,
            to: m.to,
            kind: m.kind,
            text: m.text,
            ...(m.email ? { email: { ...m.email, sendable: false, note: `${bot.name} was removed, so this stays a draft.` } } : {}),
            ...(m.textMsg ? { textMsg: { ...m.textMsg, sendable: false, note: `${bot.name} was removed, so this stays a draft.` } } : {})
          })
        } else if (m.kind === 'hold' && !m.hold?.answer) {
          bus.answer({ replaces: m.id, from: id, to: m.to, kind: 'hold', text: m.text, hold: { ...m.hold, need: m.hold?.need || 'spend', answer: 'no' } })
        }
      }
      endSession(id)
      store.removeBotFiles(id)
      post({ from: id, to: ME, kind: 'system', system: 'removed', name: bot.name, text: `${bot.name} was removed.` })
      for (const job of jobs) settle(job)
      return null
    },
    saveBot(input: Omit<DeskBot, 'file'>): string | null {
      const name = String(input.name || '').trim()
      const slug = botSlug(name)
      const have = taken()
      const removedId = have.ids.includes(input.id) && !store.readBot(input.id)
      const removedName = have.names.some((n, i) => have.ids[i] !== input.id && n.trim().toLowerCase() === name.toLowerCase() && !store.readBots().some((b) => b.id === have.ids[i]))
      if (removedId || removedName) return 'That name is taken.'
      if (store.readBots().some((b) => b.id !== input.id && (b.name.trim().toLowerCase() === name.toLowerCase() || b.id === slug))) {
        return 'That name is taken.'
      }
      if (!store.readBot(input.id) && have.ids.includes(slug)) return 'That name is taken.'
      const err = store.saveBot({ ...input, name })
      if (err) return err
      if (!existsSync(memoryFile(opts.brain, input.id))) store.createMemory(input.id)
      return null
    },
    states,
    list() {
      return { bots: store.readBots(), states: states(), removedNames: removedNames() }
    },
    anyBusy() {
      return busyIds().map((id) => store.readBot(id)?.name || names()[id] || id)
    },
    view(botId: string | null, limit = 200) {
      const open = browser.windowOpen()
      return store.view(botId, limit).map((m) => (m.kind === 'browse' && m.browse ? { ...m, browse: { ...m.browse, windowOpen: open } } : m))
    },
    async quit() {
      const ids = [...new Set([...busyIds(), ...tidying, ...browserWaiting])]
      runner.stopAll()
      bus.dropQueues()
      stopChildren(ids)
      for (const id of ids) post({ from: id, to: ME, kind: 'stopped', text: QUIT_TEXT, inputs: [] })
      await whenIdle()
    },
    async closeDesk() {
      const ids = busyIds()
      runner.stopAll()
      bus.dropQueues()
      stopChildren(ids)
      for (const id of ids) post({ from: id, to: ME, kind: 'stopped', text: CLOSED_TEXT, inputs: [] })
      await whenIdle()
    },
    resolveBot(nameOrId: string) {
      const bots = store.readBots()
      const key = nameOrId.trim().toLowerCase()
      return bots.find((b) => b.id === key) || bots.find((b) => b.name.trim().toLowerCase() === key) || null
    }
  }
}

export type DeskController = ReturnType<typeof createDeskController>
