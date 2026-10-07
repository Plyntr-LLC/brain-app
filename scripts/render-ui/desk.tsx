import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { BotState, DeskBot, DeskCli, DeskMessage, DeskWelcome } from '../../src/shared/desk'
import { DeskPane } from '../../src/renderer/src/DeskPane'
import { DeskCard } from '../../src/renderer/src/DeskCard'

// Desk render page (slice-8). Mounts the real DeskPane and DeskCard with a fake bridge and fixture
// messages, not a live brain. node --experimental-strip-types scripts/render-ui.ts desk

type Cap = { id: string; label: string }
type Call = { fn: string; args: unknown[] }
type Fixture = {
  brain: string
  bots: DeskBot[]
  states: BotState[]
  removedNames: Record<string, string>
  welcome: DeskWelcome
  messages: DeskMessage[]
}

const calls: Call[] = []
const fixtures = new Map<string, Fixture>()
const listeners: ((snap: unknown) => void)[] = []
let detectNow: Record<DeskCli, boolean> = { grok: true, claude: true, gpt: false, cursor: false }

const fx = (tab: string): Fixture => {
  const f = fixtures.get(tab)
  if (!f) throw new Error(`no fixture for ${tab}`)
  return f
}
const rec = (fn: string, ...args: unknown[]) => {
  calls.push({ fn, args })
  return Promise.resolve(null)
}

const brain = {
  desk: {
    attach: (tab: string) => Promise.resolve({ brain: fx(tab).brain }),
    closeCheck: () => Promise.resolve({ last: true, busyNames: [] as string[] }),
    detach: () => Promise.resolve(),
    welcome: (tab: string, thread?: string | null) => {
      const f = fx(tab)
      const bot = thread ? f.bots.find((b) => b.id === thread) : null
      return Promise.resolve(bot ? { ...f.welcome, composerPlaceholder: `Message ${bot.name}` } : f.welcome)
    },
    list: (tab: string) => Promise.resolve({ bots: fx(tab).bots, states: fx(tab).states, removedNames: fx(tab).removedNames }),
    save: (tab: string, bot: unknown) => rec('save', tab, bot),
    remove: (tab: string, id: string) => rec('remove', tab, id),
    say: (tab: string, text: string, to?: string) => rec('say', tab, text, to),
    answerHold: (tab: string, id: string, answer: string) => rec('answerHold', tab, id, answer),
    answerEmail: (tab: string, id: string, answer: string) => rec('answerEmail', tab, id, answer),
    answerText: (tab: string, id: string, answer: string) => rec('answerText', tab, id, answer),
    stop: (tab: string, botId: string) => rec('stop', tab, botId),
    keepWaiting: (tab: string, botId: string) => rec('keepWaiting', tab, botId),
    continueJob: (tab: string, job: string) => rec('continueJob', tab, job),
    stopJob: (tab: string, job: string) => rec('stopJob', tab, job),
    retry: (tab: string, msgId: string) => rec('retry', tab, msgId),
    status: (tab: string) => rec('status', tab),
    focus: (tab: string) => rec('focus', tab),
    showWindow: (tab: string) => rec('showWindow', tab),
    picture: (tab: string) => {
      calls.push({ fn: 'picture', args: [tab] })
      // A one-pixel jpeg so the corner picture has an image to size. Other tabs stay empty.
      return Promise.resolve(tab === 'tab-pip' ? PIP_JPEG : null)
    },
    view: (tab: string, botId: string | null) => {
      calls.push({ fn: 'view', args: [tab, botId] })
      const all = fx(tab).messages
      return Promise.resolve(botId ? all.filter((m) => m.from === botId || m.to === botId) : all)
    },
    onEvent: (cb: (snap: unknown) => void) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    }
  },
  ai: { detect: () => Promise.resolve(detectNow) },
  slash: { list: () => Promise.resolve({ models: [] as Cap[] }) }
}
;(window as unknown as { brain: typeof brain }).brain = brain

const layout = document.createElement('style')
layout.textContent =
  '.stage{margin:14px 0}.stage-title{font:600 12px sans-serif;margin:0 0 4px 14px}' +
  '.stage-row{display:grid;grid-template-columns:780px 300px;height:560px;margin-left:14px;border:1px solid #ccc}' +
  '.stage-pane{position:relative;overflow:hidden}.stage-rail{display:flex;flex-direction:column;border-left:1px solid #ddd;background:var(--paper)}' +
  '.card-grid{display:grid;grid-template-columns:repeat(3,340px);gap:10px;margin-left:14px}'
document.head.appendChild(layout)

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: detail.slice(0, 300) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await tick(20)
}
const noop = () => undefined
const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
const since = (n: number) => calls.slice(n)
const same = (got: Call[], fn: string, ...args: unknown[]) =>
  got.length === 1 && got[0].fn === fn && JSON.stringify(got[0].args) === JSON.stringify(args)
const show = (got: Call[]) => JSON.stringify(got)

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// ---------- fixtures ----------

const at = (h: number, m: number) => new Date(2026, 9, 7, h, m).toISOString()

function team(brainPath: string, clis: Record<string, DeskCli>): DeskBot[] {
  const rows: [string, string, string][] = [
    ['conductor', 'Conductor', "I'm the one you talk to."],
    ['researcher', 'Researcher', 'I find what the brain already knows and quote it with the file path.'],
    ['writer', 'Writer', 'I draft emails, reports, and posts in the house voice.'],
    ['checker', 'Checker', 'I read a draft against the files it came from.'],
    ['drafts', 'Drafts', 'I put an email or a text into the chat as the exact message that would go out.']
  ]
  return rows.map(([id, name, description]) => ({
    id,
    name,
    cli: clis[id],
    model: clis[id] === 'claude' ? 'claude-opus-5-5' : 'default',
    effort: id === 'conductor' || id === 'researcher' ? 'high' : 'low',
    description,
    file: `${brainPath}/desk/bots/${id}.md`
  }))
}

const MIXED: Record<string, DeskCli> = { conductor: 'grok', researcher: 'grok', writer: 'claude', checker: 'grok', drafts: 'claude' }
const ALL_GROK: Record<string, DeskCli> = { conductor: 'grok', researcher: 'grok', writer: 'grok', checker: 'grok', drafts: 'grok' }
const idle = (bots: DeskBot[]): BotState[] => bots.map((b) => ({ id: b.id, state: 'idle' as const }))

const GREETING =
  "Hi Joe. I'm Conductor. You talk to me, and I hand the work to Researcher, Writer, Checker, and Drafts. " +
  'They work in the background, so you can keep talking to me while they do. ' +
  'An email or a text shows up as the message itself, and you send it from there. Try one of these:'
const STARTERS = ['Catch me up on Summit', "Draft a reply to Summit's last note", 'What can the team do?']
const EVERYONE = 'Everyone is on Grok for now. You can give anyone a different model on the right.'
const READY_LINE = "Writer uses Claude, which isn't on this Mac yet."

function welcome(patch: Partial<DeskWelcome> = {}): DeskWelcome {
  return {
    greetingName: 'Joe',
    greeting: GREETING,
    starters: STARTERS.map((s) => ({ label: s, fill: s })),
    readiness: [],
    composerDisabled: false,
    composerPlaceholder: 'Message Conductor',
    everyoneLine: null,
    ...patch
  }
}

const TASK = 'Find the newest note under clients/summit/ and have Writer draft three bullets from it, then have Checker look it over.'
const PACK_TASK = 'Find the newest Summit note and pull out the three main points. Hand them to Writer when you have them.'
const NOTE = 'clients/summit/notes/2026-10-01.md'
const HANDOFF =
  `Here are the three points from ${NOTE}: leads are up 12 percent, cost per lead is down, and the budget question is still open. Keep it short.`
const HOLD_TEXT = 'Raise the Summit daily budget to $40. Approving records your yes. It does not spend money or change the ads account.'
const ACCOUNT_LINE = 'It does not spend money or change the ads account.'
const REPORT = 'Three bullets for Summit:\n- Leads up 12%\n- Cost per lead down\n- Budget question still open'
const STATUS = 'Conductor · idle\nResearcher · waiting on you\nWriter · idle\nChecker · reading the draft · 1m\nDrafts · waiting on you'
const EMAIL = {
  replyTo: '',
  to: 'Brent Hale <brent@example.com>',
  cc: '',
  subject: 'September numbers',
  body: 'Hi Brent,\nSeptember numbers are in the note.\nJoe',
  from: 'joe@example.com',
  sendable: true
}
const DRY = 'Dry run. Nothing left this Mac.'

const cardsMail: DeskMessage[] = [
  { id: 'm_01', ts: at(9, 10), from: 'me', to: 'conductor', kind: 'task', text: TASK },
  { id: 'm_02', ts: at(9, 11), from: 'conductor', to: 'me', kind: 'reply', text: 'Researcher is on it. I will tell you when Writer has a draft.' },
  {
    id: 'm_03',
    ts: at(9, 11),
    from: 'conductor',
    to: 'researcher',
    kind: 'pack',
    job: 'j_1',
    text: PACK_TASK,
    pack: {
      why: 'Joe wants three bullets from the newest Summit note.',
      files: [
        { path: NOTE, excerpt: 'Leads up 12 percent.' },
        { path: 'clients/summit/context.md', excerpt: 'Summit sells steel buildings.' }
      ],
      dropped: ['clients/summit/old-notes.md']
    }
  },
  { id: 'm_04', ts: at(9, 12), from: 'researcher', to: 'writer', kind: 'send', job: 'j_1', text: HANDOFF },
  { id: 'm_05', ts: at(9, 13), from: 'drafts', to: 'me', kind: 'email', job: 'j_2', text: EMAIL.subject, email: { ...EMAIL } },
  { id: 'm_06', ts: at(9, 13), from: 'researcher', to: 'me', kind: 'hold', job: 'j_3', text: HOLD_TEXT, hold: { need: 'spend' } },
  { id: 'm_07', ts: at(9, 16), from: 'writer', to: 'me', kind: 'report', job: 'j_1', text: REPORT, report: { seconds: 185 } },
  { id: 'm_08', ts: at(9, 17), from: 'me', to: 'me', kind: 'status', text: STATUS },
  {
    id: 'm_09',
    ts: at(9, 18),
    from: 'writer',
    to: 'me',
    kind: 'error',
    text: 'Writer stopped with an error.',
    detail: 'The model returned an error.',
    failure: 'exited',
    lastTry: { cli: 'claude', model: 'default' },
    inputs: ['m_01']
  },
  { id: 'm_10', ts: at(9, 19), from: 'designer', to: 'me', kind: 'reply', text: 'Headline ideas are in the thread.' },
  { id: 'm_11', ts: at(9, 19), from: 'ghost-bot', to: 'me', kind: 'reply', text: 'An old line from a teammate nobody can name.' }
]

function addFixture(tab: string, brainPath: string, clis: Record<string, DeskCli>, w: DeskWelcome, messages: DeskMessage[] = [], removedNames: Record<string, string> = {}) {
  const bots = team(brainPath, clis)
  fixtures.set(tab, { brain: brainPath, bots, states: idle(bots), removedNames, welcome: w, messages })
}

addFixture('tab-welcome', '/fx/welcome', MIXED, welcome())
addFixture('tab-ready', '/fx/ready', MIXED, welcome({ readiness: [{ botId: 'writer', text: READY_LINE, cli: 'grok', model: 'default' }] }))
addFixture('tab-everyone', '/fx/everyone', ALL_GROK, welcome({ everyoneLine: EVERYONE }))
addFixture('tab-cards', '/fx/cards', MIXED, welcome(), cardsMail, { designer: 'Designer' })
addFixture('tab-form', '/fx/form', MIXED, welcome())

// Smallest jpeg the corner picture can show. The harness never launches Chrome.
const PIP_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAA//2Q=='

// ---------- mounting ----------

function modelsFor(_cli: DeskCli, list?: Cap[]): Cap[] {
  return list && list.length ? list : [{ id: 'default', label: 'Default' }]
}
function effortsFor(cli: DeskCli): Cap[] {
  return cli === 'grok' || cli === 'claude' ? [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] : []
}

type Pane = { pane: HTMLElement; rail: HTMLElement }

async function mountPane(tab: string, title: string, height = 560): Promise<Pane> {
  const wrap = document.createElement('section')
  wrap.className = 'stage'
  wrap.innerHTML = `<p class="stage-title">${title}</p><div class="stage-row" style="height:${height}px"><div class="stage-pane"></div><aside class="refs stage-rail"></aside></div>`
  document.getElementById('root')!.appendChild(wrap)
  const pane = wrap.querySelector('.stage-pane') as HTMLElement
  const rail = wrap.querySelector('.stage-rail') as HTMLElement
  createRoot(pane).render(
    <DeskPane
      id={tab}
      cwd={fx(tab).brain}
      active
      rail={rail}
      closing={false}
      onClosed={noop}
      onKeep={noop}
      onOpenFile={(p) => calls.push({ fn: 'openFile', args: [tab, p] })}
      modelsFor={modelsFor}
      effortsFor={effortsFor}
    />
  )
  await until(() => rail.querySelectorAll('.desk-row').length === fx(tab).bots.length && !!pane.querySelector('.composer textarea'))
  await tick(60)
  return { pane, rail }
}

async function emit(tab: string) {
  const f = fx(tab)
  flushSync(() => listeners.forEach((l) => l({ brain: f.brain, messages: f.messages, states: f.states, removedNames: f.removedNames })))
  await tick(60)
}

function replace(tab: string, oldId: string, next: DeskMessage) {
  const f = fx(tab)
  f.messages = f.messages.map((m) => (m.id === oldId ? next : m))
}

const buttons = (scope: Element | null | undefined) => [...(scope?.querySelectorAll<HTMLButtonElement>('button') || [])]
const button = (scope: Element | null | undefined, label: string) => buttons(scope).find((b) => text(b) === label)
const cards = (scope: Element) => [...scope.querySelectorAll<HTMLElement>('.thread .fcard')]
const title = (card: Element) => text(card.querySelector(':scope > .fcard-title'))
const cardTitled = (scope: Element, t: string) => cards(scope).filter((c) => title(c) === t)
const bodyLines = (card: Element) => [...(card.querySelector(':scope > .fcard-body')?.querySelectorAll<HTMLElement>(':scope > div') || [])].map((d) => text(d))

// ---------- stages ----------

async function welcomeStage() {
  detectNow = { grok: true, claude: true, gpt: false, cursor: false }
  const { pane, rail } = await mountPane('tab-welcome', '1. first open: welcome, starters, five-bot roster')
  const card = pane.querySelector('.thread .bubble.md')
  check('1 welcome card shows with no messages', !!card)
  check('1 greeting is the welcome payload', text(card?.querySelector('p')) === GREETING, text(card?.querySelector('p')))
  const starters = buttons(card).map(text)
  check('1 three starters in order', JSON.stringify(starters) === JSON.stringify(STARTERS), JSON.stringify(starters))
  const box = pane.querySelector<HTMLTextAreaElement>('.composer textarea')!
  check('1 composer placeholder', box.placeholder === 'Message Conductor', box.placeholder)
  const before = calls.length
  button(card, STARTERS[0])?.click()
  await tick()
  check('1 a starter fills the composer', box.value === STARTERS[0], box.value)
  check('1 a starter does not send', !since(before).some((c) => c.fn === 'say'), show(since(before)))
  const rows = [...rail.querySelectorAll('.desk-row')]
  const names = rows.map((r) => text(r.querySelector('.flink')))
  check('1 roster has five bots in seed order', JSON.stringify(names) === JSON.stringify(['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts']), JSON.stringify(names))
  check('1 each roster row has Edit', rows.every((r) => !!button(r, 'Edit')))
  check('1 roster rows read Idle', rows.every((r) => [...r.querySelectorAll('.tiny')].some((t) => text(t) === 'Idle')))
  check('1 Add a teammate under the roster', !!button(rail, 'Add a teammate'))
  check('1 no readiness button', !buttons(pane.querySelector('.composer')).some((b) => text(b).startsWith('Use ')))
  check('1 no everyone line', !text(pane.querySelector('.composer')).includes('Everyone is on'))
}

async function readinessStage() {
  detectNow = { grok: true, claude: false, gpt: false, cursor: false }
  const { pane } = await mountPane('tab-ready', '2. readiness: Writer says Claude, only Grok is on this Mac')
  const composer = pane.querySelector('.composer')
  const lines = [...(composer?.querySelectorAll('p.tiny') || [])].map(text)
  check('2 readiness line for Writer', JSON.stringify(lines) === JSON.stringify([READY_LINE]), JSON.stringify(lines))
  const use = buttons(composer).filter((b) => text(b).startsWith('Use '))
  check('2 one button, Use Grok for Writer', use.length === 1 && text(use[0]) === 'Use Grok for Writer', use.map(text).join(' | '))
  const before = calls.length
  use[0]?.click()
  await tick()
  const got = since(before).filter((c) => c.fn === 'save')
  const saved = got[0]?.args[1] as Partial<DeskBot> | undefined
  check(
    '2 the button writes cli grok and model default for Writer',
    got.length === 1 && got[0].args[0] === 'tab-ready' && saved?.id === 'writer' && saved?.cli === 'grok' && saved?.model === 'default',
    show(since(before))
  )
  check('2 no everyone line', !text(composer).includes('Everyone is on'))
}

async function everyoneStage() {
  detectNow = { grok: true, claude: false, gpt: false, cursor: false }
  const { pane } = await mountPane('tab-everyone', '3. everyone on Grok, only Grok installed')
  const composer = pane.querySelector('.composer')
  const lines = [...(composer?.querySelectorAll('p.tiny') || [])].map(text)
  check('3 the everyone line shows', JSON.stringify(lines) === JSON.stringify([EVERYONE]), JSON.stringify(lines))
  check('3 no readiness line or button', !buttons(composer).some((b) => text(b).startsWith('Use ')) && !lines.some((l) => l.includes("isn't on this Mac")))
}

async function threadStage() {
  detectNow = { grok: true, claude: true, gpt: false, cursor: false }
  const tab = 'tab-cards'
  const { pane } = await mountPane(tab, '4. the team thread from fixture messages', 1500)
  await until(() => cards(pane).length >= cardsMail.length)
  check('4 one card per message', cards(pane).length === cardsMail.length, `cards=${cards(pane).length}`)
  check('4 no welcome card once the thread has messages', !pane.querySelector('.thread .bubble.md'))

  // You and the conductor's reply.
  check('4 the task reads You', cardTitled(pane, 'You').length === 1 && text(cardTitled(pane, 'You')[0]).includes(TASK))
  const reply = cardTitled(pane, 'Conductor')[0]
  check('4 reply header is the speaker, no Done', !!reply && !title(reply).includes('Done'))
  check('4 reply has no buttons', !!reply && buttons(reply).length === 0, buttons(reply).map(text).join(' | '))

  // Briefing.
  const brief = cardTitled(pane, 'Conductor → Researcher · Briefing')[0]
  check('4 Briefing header', !!brief, cards(pane).map(title).join(' | '))
  const lines = brief ? bodyLines(brief) : []
  check('4 Briefing starts with the first sentence of the task', lines[0] === 'Find the newest Summit note and pull out the three main points.', lines[0])
  check('4 Briefing why line', lines[1] === 'Why: Joe wants three bullets from the newest Summit note.', lines[1])
  check('4 Briefing reading line', lines[2] === 'Reading 2 files', lines[2])
  const paths = buttons(brief).map(text)
  check('4 each file is a link', JSON.stringify(paths) === JSON.stringify([NOTE, 'clients/summit/context.md']), JSON.stringify(paths))
  const dropped = brief?.querySelector('.tiny')
  check("4 Couldn't find line is muted", text(dropped) === "Couldn't find: clients/summit/old-notes.md", text(dropped))
  let before = calls.length
  button(brief, NOTE)?.click()
  await tick()
  check('4 a Briefing path opens the file', same(since(before), 'openFile', tab, NOTE), show(since(before)))

  // Handoff line.
  const hand = pane.querySelector<HTMLDetailsElement>('.thread details.fcard')
  const summary = text(hand?.querySelector('summary'))
  const flat = HANDOFF.replace(/\s+/g, ' ')
  check('4 handoff is one line: names and the first 80 characters', summary === `Researcher → Writer: ${flat.slice(0, 80)}…`, summary)
  check('4 handoff is folded until opened', !!hand && !hand.open)
  if (hand) hand.open = true
  await tick()
  const handBody = hand?.querySelector('.fcard-body')
  check('4 handoff opens to the full text', text(handBody) === HANDOFF, text(handBody))
  check('4 the named path in the handoff is a link', JSON.stringify(buttons(handBody).map(text)) === JSON.stringify([NOTE]), buttons(handBody).map(text).join(' | '))
  before = calls.length
  button(handBody, NOTE)?.click()
  await tick()
  check('4 the handoff path opens the file', same(since(before), 'openFile', tab, NOTE), show(since(before)))

  // Email tile: Send and Not now, then a folded replacement that reads Not sent, then Sent.
  let mail = cardTitled(pane, 'Drafts')
  const shown = mail[0] ? bodyLines(mail[0]) : []
  check(
    '4 email preview: From, To, Subject, body',
    JSON.stringify(shown) === JSON.stringify(['From: joe@example.com', 'To: Brent Hale <brent@example.com>', 'Subject: September numbers', EMAIL.body]),
    JSON.stringify(shown)
  )
  check('4 email has no Cc line when cc is empty, and no Reply', !shown.some((l) => l.startsWith('Cc:')) && !shown.includes('Reply'))
  check('4 email tile is a preview, not a form', !!mail[0] && !mail[0].querySelector('input, textarea, select'))
  check('4 email tile has Send and Not now', !!button(mail[0], 'Send') && !button(mail[0], 'Send')!.disabled && !!button(mail[0], 'Not now'))
  before = calls.length
  button(mail[0], 'Not now')?.click()
  await tick()
  check('4 Not now answers no on that tile', same(since(before), 'answerEmail', tab, 'm_05', 'no'), show(since(before)))
  replace(tab, 'm_05', { ...cardsMail[4], id: 'm_05b', ts: at(9, 14), replaces: 'm_05', email: { ...EMAIL, sent: 'no' } })
  await emit(tab)
  mail = cardTitled(pane, 'Drafts')
  check('4 the folded replacement is the only email card', mail.length === 1, `drafts cards=${mail.length}`)
  check('4 after Not now it reads Not sent', [...(mail[0]?.querySelectorAll('.tiny') || [])].some((t) => text(t) === 'Not sent'))
  check('4 after Not now Send stays and Not now is gone', !!button(mail[0], 'Send') && !button(mail[0], 'Send')!.disabled && !button(mail[0], 'Not now'))
  before = calls.length
  button(mail[0], 'Send')?.click()
  await tick()
  check('4 Send answers yes on the replacement', same(since(before), 'answerEmail', tab, 'm_05b', 'yes'), show(since(before)))
  replace(tab, 'm_05b', { ...cardsMail[4], id: 'm_05c', ts: at(9, 14), replaces: 'm_05b', actedAt: at(9, 14), email: { ...EMAIL, sent: 'yes', note: DRY } })
  await emit(tab)
  mail = cardTitled(pane, 'Drafts')
  const tinies = [...(mail[0]?.querySelectorAll('.tiny') || [])].map(text)
  check('4 still one email card after Send', mail.length === 1, `drafts cards=${mail.length}`)
  check('4 the tile reads Sent · 9:14', tinies.includes('Sent · 9:14'), JSON.stringify(tinies))
  check('4 Sent has no Send and no Not now', !!mail[0] && !button(mail[0], 'Send') && !button(mail[0], 'Not now'), buttons(mail[0]).map(text).join(' | '))
  check('4 the dry-run note shows under the body', tinies.includes(DRY), JSON.stringify(tinies))

  // Spend hold.
  let hold = cardTitled(pane, 'Researcher')[0]
  check('4 hold body is the stored text', text(hold?.querySelector('.fcard-body')) === HOLD_TEXT, text(hold?.querySelector('.fcard-body')))
  check('4 spend hold says it does not change the account', text(hold).includes(ACCOUNT_LINE))
  check('4 hold has Approve and Not now', !!button(hold, 'Approve') && !!button(hold, 'Not now'))
  before = calls.length
  button(hold, 'Approve')?.click()
  await tick()
  check('4 Approve answers yes on the hold', same(since(before), 'answerHold', tab, 'm_06', 'yes'), show(since(before)))
  replace(tab, 'm_06', { ...cardsMail[5], id: 'm_06b', replaces: 'm_06', actedAt: at(9, 15), hold: { need: 'spend', answer: 'yes' } })
  await emit(tab)
  hold = cardTitled(pane, 'Researcher')[0]
  check('4 after Approve it reads Approved · 9:15 and the buttons are gone', text(hold?.querySelector('.tiny')) === 'Approved · 9:15' && buttons(hold).length === 0, text(hold))

  // Report.
  const report = cardTitled(pane, 'Writer · Done · 3m')[0]
  check('4 report header with minutes', !!report, cards(pane).map(title).join(' | '))
  check('4 report keeps its line breaks', (report?.querySelector('.fcard-body')?.textContent || '') === REPORT, report?.querySelector('.fcard-body')?.textContent || '')
  check('4 report has Open the log and Talk to Writer', JSON.stringify(buttons(report).map(text)) === JSON.stringify(['Open the log', 'Talk to Writer']), buttons(report).map(text).join(' | '))
  before = calls.length
  button(report, 'Open the log')?.click()
  await tick()
  check('4 Open the log opens the mail file', same(since(before), 'openFile', tab, '/fx/cards/desk/mail/desk.md'), show(since(before)))

  // Status, error, and names.
  const status = cardTitled(pane, 'Where things stand')[0]
  check('4 status is one line per bot', JSON.stringify(status ? bodyLines(status) : []) === JSON.stringify(STATUS.split('\n')), JSON.stringify(status ? bodyLines(status) : []))
  check('4 status has no buttons', !!status && buttons(status).length === 0)
  const err = cardTitled(pane, "Writer couldn't finish")[0]
  check('4 error shows the stored sentence', !!err && bodyLines(err)[0] === 'Writer stopped with an error.', err ? bodyLines(err).join(' | ') : 'no card')
  const disclosure = err?.querySelector<HTMLDetailsElement>('details')
  check('4 error detail sits behind Details', text(disclosure?.querySelector('summary')) === 'Details' && !disclosure?.open)
  check('4 error has Try again and no Use button', !!button(err, 'Try again') && !buttons(err).some((b) => text(b).startsWith('Use')))
  before = calls.length
  button(err, 'Try again')?.click()
  await tick()
  check('4 Try again reruns that message', same(since(before), 'retry', tab, 'm_09'), show(since(before)))
  check('4 a removed bot keeps its name', cardTitled(pane, 'Designer').length === 1)
  check('4 an unknown id reads Someone', cardTitled(pane, 'Someone').length === 1)

  // Talk to Writer opens Writer's thread.
  before = calls.length
  button(report, 'Talk to Writer')?.click()
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Writer')
  check("4 Talk to Writer opens Writer's thread", text(pane.querySelector('.filetab-head span')) === 'Writer' && !!button(pane.querySelector('.filetab-head'), 'Team'))
  check("4 Writer's thread loads Writer's view", since(before).some((c) => c.fn === 'view' && c.args[0] === tab && c.args[1] === 'writer'), show(since(before)))
  await until(() => pane.querySelector<HTMLTextAreaElement>('.composer textarea')?.placeholder === 'Message Writer')
  check('4 the composer talks to Writer there', pane.querySelector<HTMLTextAreaElement>('.composer textarea')?.placeholder === 'Message Writer')
}

async function formStage() {
  detectNow = { grok: true, claude: true, gpt: false, cursor: false }
  const tab = 'tab-form'
  const { rail } = await mountPane(tab, '5. add a teammate: the 800-character error')
  button(rail, 'Add a teammate')?.click()
  await until(() => !!rail.querySelector('.desk-form'))
  const form = rail.querySelector<HTMLFormElement>('.desk-form')
  check('5 Add a teammate opens the form', !!form)
  const name = form?.querySelector<HTMLInputElement>('input')
  const about = form?.querySelector<HTMLTextAreaElement>('textarea')
  check('5 the form asks what they do and will not do', text(form).includes("What do they do, and what won't they do?"))
  const long = 'Writes headlines and nothing else. Never sends anything. '.repeat(20).slice(0, 911) + '.'
  if (name) typeInto(name, 'Designer')
  if (about) typeInto(about, long)
  await tick()
  check('5 the live count reads 912/800', [...(form?.querySelectorAll('.tiny') || [])].some((t) => text(t) === '912/800'))
  let before = calls.length
  button(form, 'Save')?.click()
  await tick()
  check('5 Save shows the 800 error', [...(form?.querySelectorAll('.tiny') || [])].some((t) => text(t) === 'Keep it under 800 characters (now 912).'))
  check('5 nothing is saved over 800', !since(before).some((c) => c.fn === 'save'), show(since(before)))
  if (name) typeInto(name, 'writer')
  if (about) typeInto(about, 'Writes headlines only.')
  await tick()
  before = calls.length
  button(form, 'Save')?.click()
  await tick()
  check('5 a taken name shows That name is taken.', [...(form?.querySelectorAll('.tiny') || [])].some((t) => text(t) === 'That name is taken.'))
  check('5 nothing is saved for a taken name', !since(before).some((c) => c.fn === 'save'), show(since(before)))
}

// Rows the thread fixture does not reach, on DeskCard alone.
function cardStage() {
  const wrap = document.createElement('section')
  wrap.className = 'stage'
  wrap.innerHTML = '<p class="stage-title">6. card rows on their own</p><div class="card-grid"></div>'
  document.getElementById('root')!.appendChild(wrap)
  const grid = wrap.querySelector('.card-grid') as HTMLElement
  const names = { me: 'You', conductor: 'Conductor', researcher: 'Researcher', writer: 'Writer', checker: 'Checker', drafts: 'Drafts' }
  function mount(msg: DeskMessage, busy = false) {
    const el = document.createElement('div')
    el.className = 'thread'
    grid.appendChild(el)
    const got: Call[] = []
    const on = (fn: string) => (...args: unknown[]) => got.push({ fn, args })
    flushSync(() =>
      createRoot(el).render(
        <DeskCard
          msg={msg}
          names={names}
          busy={busy}
          onOpenFile={on('openFile')}
          onHoldAnswer={on('holdAnswer')}
          onSend={on('send')}
          onRetry={on('retry')}
          onKeepWaiting={on('keepWaiting')}
          onStop={on('stop')}
          onContinueJob={on('continueJob')}
          onStopJob={on('stopJob')}
          onTalk={on('talk')}
          onOpenLog={on('openLog')}
          onOpenMemory={on('openMemory')}
          onOpenBrowser={on('openBrowser')}
          onRemoveHire={on('removeHire')}
        />
      )
    )
    return { el, got }
  }
  const base = { ts: at(9, 20), to: 'me', text: '' }

  const wa = mount({ ...base, id: 'c_wa', from: 'drafts', kind: 'text', text: 'Brent', textMsg: { to: 'Brent', via: 'WhatsApp', body: 'The September note is ready.', sendable: false, note: "WhatsApp send from Desk isn't set up. This stays a draft." } })
  check('6 WhatsApp tile names the app', bodyLines(wa.el.querySelector('.fcard')!).includes('Via: WhatsApp'))
  check('6 WhatsApp Send is disabled', button(wa.el, 'Send')?.disabled === true)
  const im = mount({ ...base, id: 'c_im', from: 'drafts', kind: 'text', text: 'Brent', textMsg: { to: 'Brent', via: 'iMessage', body: 'The September note is ready.', sendable: true, chatGuid: 'g1', chatLabel: 'Brent Hale · +1 555 0100' } })
  check('6 iMessage tile shows who it is to', bodyLines(im.el.querySelector('.fcard')!)[0] === 'To: Brent Hale · +1 555 0100')
  button(im.el, 'Send')?.click()
  check('6 iMessage Send calls onSend yes', same(im.got, 'send', 'c_im', 'yes'), show(im.got))

  const no = mount({ ...base, id: 'c_no', from: 'writer', kind: 'hold', text: HOLD_TEXT, hold: { need: 'spend', answer: 'no' } })
  check('6 a declined hold reads Not approved with no time and no buttons', text(no.el.querySelector('.tiny')) === 'Not approved' && buttons(no.el).length === 0)

  const errNone = mount({ ...base, id: 'c_e0', from: 'writer', kind: 'error', text: 'Writer stopped with an error.', inputs: [] })
  check('6 an error with empty inputs has no Try again', !button(errNone.el, 'Try again'))
  const stopNone = mount({ ...base, id: 'c_s0', from: 'writer', kind: 'stopped', text: 'Stopped. Checker and Writer were each waiting on the other.', inputs: [] })
  check('6 a stopped card with empty inputs has no Run again', text(stopNone.el.querySelector('.fcard-title')) === 'Writer stopped' && !button(stopNone.el, 'Run again'))
  const stopRun = mount({ ...base, id: 'c_s1', from: 'writer', kind: 'stopped', text: 'You stopped Writer.', inputs: ['m_01'] })
  button(stopRun.el, 'Run again')?.click()
  check('6 Run again calls onRetry', same(stopRun.got, 'retry', 'c_s1'), show(stopRun.got))

  const slow = mount({ ...base, id: 'c_slow', from: 'writer', kind: 'system', system: 'slow', text: 'Writer has been on this for 10 minutes.' })
  button(slow.el, 'Keep waiting')?.click()
  button(slow.el, 'Stop')?.click()
  check('6 slow: Keep waiting and Stop use the bot', JSON.stringify(slow.got) === JSON.stringify([{ fn: 'keepWaiting', args: ['writer'] }, { fn: 'stop', args: ['writer'] }]), show(slow.got))
  check('6 a system line has no header', !slow.el.querySelector('.fcard-title'))
  const loop = mount({ ...base, id: 'c_loop', from: 'writer', job: 'j_7', kind: 'system', system: 'loop', text: 'Researcher and Writer have passed this back and forth 10 times.' })
  button(loop.el, 'Let them continue')?.click()
  button(loop.el, 'Stop them')?.click()
  check('6 loop: Let them continue and Stop them use the line', JSON.stringify(loop.got) === JSON.stringify([{ fn: 'continueJob', args: ['j_7'] }, { fn: 'stopJob', args: ['j_7'] }]), show(loop.got))
  const late = mount({ ...base, id: 'c_late', from: 'me', kind: 'system', system: 'late', text: 'That handoff arrived after the work was already done.' })
  check('6 other system lines have no buttons', buttons(late.el).length === 0)

  const steps = mount({
    ...base,
    id: 'c_br',
    from: 'writer',
    kind: 'browse',
    text: 'Clicked Pricing',
    browse: {
      steps: [
        { action: 'url', detail: 'https://example.com', url: 'https://example.com/' },
        { action: 'click', detail: 'Pricing', url: 'https://example.com/pricing' },
        { action: 'type', detail: 'Search | summit', url: 'https://example.com/pricing' },
        { action: 'click', detail: "Couldn't find Plans.", url: 'https://example.com/pricing' },
        { action: 'scroll', detail: 'down', url: 'https://example.com/pricing' },
        { action: 'press', detail: 'Enter', url: 'https://example.com/pricing' }
      ],
      title: 'Pricing · Example',
      windowOpen: false
    }
  })
  check(
    '6 browse: one line per step, then the title',
    JSON.stringify(bodyLines(steps.el.querySelector('.fcard')!)) ===
      JSON.stringify(['Opened https://example.com/', 'Clicked Pricing', 'Typed into Search', "Couldn't find Plans.", 'Scrolled', 'Pressed Enter', 'Pricing · Example']),
    JSON.stringify(bodyLines(steps.el.querySelector('.fcard')!))
  )
  check('6 no Open browser when the window is closed', !button(steps.el, 'Open browser'))
  const signIn = mount({ ...base, id: 'c_si', from: 'writer', kind: 'browse', text: 'Writer needs you to sign in, in the desk browser.', browse: { steps: [{ action: 'url', detail: 'https://example.com', url: 'https://example.com/login' }], signIn: true, windowOpen: true } })
  check('6 sign-in card is only its sentence', text(signIn.el.querySelector('.fcard-body')) === 'Writer needs you to sign in, in the desk browser.')
  button(signIn.el, 'Open browser')?.click()
  check('6 sign-in card with the window open has Open browser', same(signIn.got, 'openBrowser', { signIn: true }), show(signIn.got))

  const hireMsg: DeskMessage = { ...base, id: 'c_hire', from: 'conductor', kind: 'hire', text: 'Writes headlines only.', hire: { id: 'designer', name: 'Designer', cli: 'claude', model: 'default', description: 'Writes headlines only.', hasWorked: false } }
  const hireBusy = mount(hireMsg, true)
  check('6 hire header and body', text(hireBusy.el.querySelector('.fcard-title')) === 'Conductor added Designer' && JSON.stringify(bodyLines(hireBusy.el.querySelector('.fcard')!)) === JSON.stringify(['Writes headlines only.', 'App: Claude', 'Model: Default']))
  check('6 hire Remove is disabled while busy', button(hireBusy.el, 'Remove')?.disabled === true)
  const hireIdle = mount(hireMsg, false)
  button(hireIdle.el, 'Remove')?.click()
  check('6 hire Remove calls onRemoveHire with the message', same(hireIdle.got, 'removeHire', 'c_hire'), show(hireIdle.got))

  const note = mount({ ...base, id: 'c_note', from: 'writer', kind: 'note', text: 'Joe wants bullets, not a long email.', noteLines: ['Joe wants bullets, not a long email.'] })
  button(note.el, 'Open memory')?.click()
  check('6 note: header, lines, Open memory', text(note.el.querySelector('.fcard-title')) === 'Writer saved a note' && same(note.got, 'openMemory', 'writer'), show(note.got))
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
}

async function pipStage() {
  const tab = 'tab-pip'
  const msg: DeskMessage = {
    id: 'm_pip',
    ts: at(9, 20),
    from: 'writer',
    to: 'me',
    kind: 'browse',
    text: 'Opened the example page.',
    browse: {
      steps: [{ action: 'url', detail: 'https://example.com', url: 'https://example.com/' }],
      title: 'Example',
      windowOpen: true
    }
  }
  addFixture(tab, '/fx/pip', MIXED, welcome(), [msg])
  const { pane, rail } = await mountPane(tab, '8. the corner picture', 640)
  await until(() => !!pane.querySelector('.desk-pip img'))
  const pip = pane.querySelector('.desk-pip')
  const thread = pane.querySelector('.thread')
  const composer = pane.querySelector('.composer')
  const img = pip?.querySelector('img')
  const pipBox = pip?.getBoundingClientRect()
  const threadBox = thread?.getBoundingClientRect()
  const composerBox = composer?.getBoundingClientRect()
  const railBox = rail.getBoundingClientRect()
  const imgBox = img?.getBoundingClientRect()
  check(
    '8 the picture sits outside the thread, the rail, and the composer',
    !!pip && !!thread && !!composer && !!pipBox && !!threadBox && !!composerBox &&
      !thread.contains(pip) && !composer.contains(pip) && !rail.contains(pip) &&
      !overlaps(pipBox, threadBox) && !overlaps(pipBox, composerBox) && !overlaps(pipBox, railBox),
    pipBox && threadBox && composerBox ? `pip ${Math.round(pipBox.top)}-${Math.round(pipBox.bottom)} thread ${Math.round(threadBox.bottom)} composer ${Math.round(composerBox.top)}` : 'missing'
  )
  check(
    '8 the picture is the small corner size',
    !!imgBox && Math.round(imgBox.width) === 240 && Math.round(imgBox.height) === 150,
    imgBox ? `${Math.round(imgBox.width)}x${Math.round(imgBox.height)}` : 'no image'
  )
  check('8 the open picture has Hide', !!button(pip, 'Hide'))
  const before = calls.length
  button(pane, 'Open browser')?.click()
  await tick()
  check(
    '8 Open browser on a step card does not bring Chrome forward',
    !since(before).some((c) => c.fn === 'showWindow' || c.fn === 'focus'),
    show(since(before).filter((c) => c.fn !== 'picture'))
  )
  button(pip, 'Hide')?.click()
  await tick()
  const chip = pane.querySelector('.desk-pip')
  const chipBox = chip?.getBoundingClientRect()
  const threadNow = pane.querySelector('.thread')?.getBoundingClientRect()
  check(
    '8 Hide leaves a desk browser chip outside the thread',
    text(button(chip, 'Desk browser')) === 'Desk browser' && !button(chip, 'Hide') && !chip?.querySelector('img') &&
      !!chip && !!threadNow && !!chipBox && !pane.querySelector('.thread')!.contains(chip) && !overlaps(chipBox, threadNow),
    text(chip)
  )
  button(chip, 'Desk browser')?.click()
  await until(() => !!button(pane.querySelector('.desk-pip'), 'Hide'))
  check('8 the chip opens the picture again', !!button(pane.querySelector('.desk-pip'), 'Hide') && !!pane.querySelector('.desk-pip img'))
}

async function main() {
  await welcomeStage()
  await readinessStage()
  await everyoneStage()
  await threadStage()
  await formStage()
  cardStage()
  await pipStage()
  await tick()
  const all = document.getElementById('root')!.textContent || ''
  const banned = all.match(/\b(pack|assign|fence|job|bus)\b/gi) || []
  check('7 the screen never says pack, assign, fence, job, or bus', banned.length === 0, banned.join(', '))
  const ids = all.match(/\b(conductor|researcher|writer|checker|drafts|designer|ghost-bot)\b/g) || []
  check('7 no bot id shows on screen', ids.length === 0, ids.join(', '))
  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String(e && (e as Error).stack ? (e as Error).stack : e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
