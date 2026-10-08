import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { forThread, type BotState, type DeskBot, type DeskCli, type DeskMessage, type DeskWelcome } from '../../src/shared/desk'
import { DeskPane } from '../../src/renderer/src/DeskPane'
import { DeskCard } from '../../src/renderer/src/DeskCard'
import { buildWelcome } from '../../src/main/desk/welcome.ts'

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
      if (!bot) return Promise.resolve(f.welcome)
      return Promise.resolve(buildWelcome({
        brain: f.brain,
        bots: f.bots,
        detect: () => detectNow,
        greetingName: f.welcome.greetingName,
        thread
      }))
    },
    list: (tab: string) => Promise.resolve({ bots: fx(tab).bots, states: fx(tab).states, removedNames: fx(tab).removedNames }),
    save: (tab: string, bot: unknown) => rec('save', tab, bot),
    remove: (tab: string, id: string) => rec('remove', tab, id),
    say: (tab: string, text: string, to?: string, pastes?: unknown) => rec('say', tab, text, to, pastes),
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
    picture: (tab: string, botId?: string) => {
      calls.push({ fn: 'picture', args: botId ? [tab, botId] : [tab] })
      // A one-pixel jpeg so the corner picture has an image to size. Other tabs stay empty.
      return Promise.resolve(tab === 'tab-pip' ? PIP_JPEG : null)
    },
    view: (tab: string, botId: string | null) => {
      calls.push({ fn: 'view', args: [tab, botId] })
      return Promise.resolve(forThread(botId, fx(tab).messages))
    },
    onEvent: (cb: (snap: unknown) => void) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    }
  },
  ai: { detect: () => Promise.resolve(detectNow) },
  slash: { list: () => Promise.resolve({ models: [] as Cap[] }) },
  browser: {
    face: (owner: string) => rec('face', owner),
    clickAt: (owner: string, x: number, y: number) => rec('clickAt', owner, x, y),
    typeText: (owner: string, text: string) => rec('typeText', owner, text),
    pressKey: (owner: string, key: string) => rec('pressKey', owner, key),
    wheel: (owner: string, deltaY: number) => rec('wheel', owner, deltaY),
    showWindow: () => rec('browserShow'),
    close: (owner: string) => rec('close', owner)
  }
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
const WRITER_SUMMARY = 'Drafted three Summit bullets. Leads are up, cost per lead is down, and the budget is still an open question.'
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
  { id: 'm_07', ts: at(9, 16), from: 'writer', to: 'me', kind: 'report', job: 'j_1', text: REPORT, summary: WRITER_SUMMARY, report: { seconds: 185 } },
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
  { id: 'm_11', ts: at(9, 19), from: 'ghost-bot', to: 'me', kind: 'reply', text: 'An old line from a teammate nobody can name.' },
  { id: 'm_12', ts: at(9, 20), from: 'me', to: 'writer', kind: 'task', text: 'Draft the three bullets.' },
  { id: 'm_13', ts: at(9, 21), from: 'writer', to: 'conductor', kind: 'send', text: 'The draft is ready for you.' },
  { id: 'm_14', ts: at(9, 22), from: 'writer', to: 'me', kind: 'system', system: 'slow', text: 'Writer has been on this for 10 minutes.' },
  {
    id: 'm_15',
    ts: at(9, 23),
    from: 'writer',
    to: 'me',
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
      ]
    }
  },
  { id: 'm_16', ts: at(9, 24), from: 'writer', to: 'me', kind: 'note', text: 'Saved.', noteLines: ['Joe wants bullets.'] }
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
addFixture('tab-paste', '/fx/paste', MIXED, welcome())
const markConductor = team('/fx/marks', MIXED)[0]
const markBots: DeskBot[] = [
  markConductor,
  { id: 'content', name: 'Content', cli: 'grok', model: 'default', effort: 'low', description: 'I write pages.', file: '/fx/marks/desk/bots/content.md' }
]
fixtures.set('tab-marks', { brain: '/fx/marks', bots: markBots, states: idle(markBots), removedNames: {}, welcome: welcome(), messages: [] })

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
  await until(() => rail.querySelectorAll('.desk-bot').length === fx(tab).bots.length && !!pane.querySelector('.composer textarea'))
  await tick(60)
  return { pane, rail }
}

async function emit(tab: string) {
  const f = fx(tab)
  flushSync(() => listeners.forEach((l) => l({ brain: f.brain, messages: forThread(null, f.messages), states: f.states, removedNames: f.removedNames })))
  await tick(60)
}

function replace(tab: string, oldId: string, next: DeskMessage) {
  const f = fx(tab)
  f.messages = f.messages.map((m) => (m.id === oldId ? next : m))
}

const buttons = (scope: Element | null | undefined) => [...(scope?.querySelectorAll<HTMLButtonElement>('button') || [])]
const button = (scope: Element | null | undefined, label: string) => buttons(scope).find((b) => text(b) === label)
const named = (scope: Element | null | undefined, label: string) => buttons(scope).find((b) => b.getAttribute('aria-label') === label)
const WRITER_HI = "Hi Joe. I'm Writer. I draft emails, reports, and posts in the house voice."
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
  check('1 the greeting sits in mdbody', !!card?.querySelector('.mdbody') && text(card.querySelector('.mdbody')) === GREETING)
  const starters = buttons(card).map(text)
  check('1 three starters in order', JSON.stringify(starters) === JSON.stringify(STARTERS), JSON.stringify(starters))
  const box = pane.querySelector<HTMLTextAreaElement>('.composer textarea')!
  check('1 composer placeholder', box.placeholder === 'Message Conductor', box.placeholder)
  const before = calls.length
  button(card, STARTERS[0])?.click()
  await tick()
  check('1 a starter fills the composer', box.value === STARTERS[0], box.value)
  check('1 a starter does not send', !since(before).some((c) => c.fn === 'say'), show(since(before)))
  const icons = [...rail.querySelectorAll<HTMLButtonElement>('.desk-bot')]
  check('1 roster has five bots in seed order', JSON.stringify(icons.map((b) => b.getAttribute('aria-label'))) === JSON.stringify(['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts']), icons.map((b) => b.getAttribute('aria-label')).join(','))
  check('1 roster shows each name', JSON.stringify(icons.map((b) => text(b.querySelector('.desk-name')))) === JSON.stringify(['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts']), icons.map((b) => text(b.querySelector('.desk-name'))).join(','))
  check('1 each bot has a face', icons.every((b) => !!b.querySelector('svg.desk-face')))
  check('1 no desk-row', rail.querySelectorAll('.desk-row').length === 0)
  const railWords = buttons(rail).map(text)
  check('1 rail has no Idle, Edit, Stop, Grok, or Claude', !railWords.some((w) => ['Idle', 'Edit', 'Stop', 'Grok', 'Claude'].includes(w)) && !text(rail).includes('Idle'), railWords.join(','))
  const plus = named(rail, 'Add a teammate')
  check('1 add is a plus', text(plus) === '+' && plus?.getAttribute('aria-label') === 'Add a teammate', text(plus))
  check('1 no readiness button', !buttons(pane.querySelector('.composer')).some((b) => text(b).startsWith('Use ')))
  check('1 no everyone line', !text(pane.querySelector('.composer')).includes('Everyone is on'))

  button(pane.querySelector('.filetab-head'), 'Edit')?.click()
  await until(() => !!rail.querySelector('.desk-form'))
  const edit = rail.querySelector<HTMLFormElement>('.desk-form')
  const editBox = edit?.getBoundingClientRect()
  const railBox = rail.getBoundingClientRect()
  const lastIcon = icons[icons.length - 1].getBoundingClientRect()
  check('1 team Edit opens Conductor', (edit?.querySelector('input')?.value || '') === 'Conductor')
  check('1 team Edit has a model select and no Remove or Hide', !!edit?.querySelector('select') && !button(edit, 'Remove') && !button(edit, 'Hide'))
  check('1 form sits under the icons and fills the rail', !!editBox && editBox.top > lastIcon.bottom && editBox.width > 200 && Math.abs(editBox.width - rail.clientWidth) <= 24, `form=${editBox?.width} rail=${rail.clientWidth}`)
  button(edit, 'Cancel')?.click()
  await until(() => !rail.querySelector('.desk-form'))

  document.documentElement.classList.add('glass')
  const working = (id: string, task: string) => ({ id, state: 'working' as const, since: new Date().toISOString(), task, model: 'default' })
  fx('tab-welcome').states = fx('tab-welcome').states.map((s) => s.id === 'writer' ? working('writer', 'Find the note') : s)
  await emit('tab-welcome')
  const writerIcon = named(rail, 'Writer')
  const conductorIcon = named(rail, 'Conductor')
  const researcherIcon = named(rail, 'Researcher')
  const paper = paint('background-color', 'var(--paper)')
  const ink = paint('color', 'var(--ink)')
  const inkFill = paint('fill', 'var(--ink)')
  const paperFill = paint('fill', 'var(--paper)')
  const orangeBg = paint('background-color', 'var(--orange)')
  const bar = '3px 0px 0px 0px inset'
  const noBar = (el: Element | null | undefined) => !!el && !getComputedStyle(el).boxShadow.includes(bar)
  const dotOk = (el: Element | null | undefined) => {
    const dot = el?.querySelector('.desk-dot')
    if (!dot) return false
    const box = dot.getBoundingClientRect()
    return getComputedStyle(dot).backgroundColor === orangeBg && Math.abs(box.width - 8) <= 1 && Math.abs(box.height - 8) <= 1
  }
  const anim = (el: Element | null | undefined, sel: string) => el ? getComputedStyle(el.querySelector(sel)!).animationName : ''
  const faceInk = (el: Element | null | undefined) => {
    const body = el?.querySelector('.desk-body')
    const eye = el?.querySelector('.eye')
    return !!body && !!eye && getComputedStyle(body).fill === inkFill && getComputedStyle(eye).fill === paperFill
  }
  check('1 open Conductor shows its name on an ink face with no bar', text(conductorIcon?.querySelector('.desk-name')) === 'Conductor' && conductorIcon?.classList.contains('on') === true && faceInk(conductorIcon) && noBar(conductorIcon) && anim(conductorIcon, '.desk-face') === 'desk-idle')
  check('1 idle Researcher shows its name and blinks', text(researcherIcon?.querySelector('.desk-name')) === 'Researcher' && !researcherIcon?.classList.contains('on') && faceInk(researcherIcon) && anim(researcherIcon, '.desk-face') === 'desk-idle' && anim(researcherIcon, '.eye') === 'desk-blink')
  check('1 working Writer shows its name, bobs, and keeps an orange dot', text(writerIcon?.querySelector('.desk-name')) === 'Writer' && writerIcon?.getAttribute('aria-label') === 'Writer' && anim(writerIcon, '.desk-face') === 'desk-bob' && anim(writerIcon, '.eye') === 'desk-glance' && dotOk(writerIcon) && noBar(writerIcon))
  check('1 a working bot has no background line', !(document.body.textContent || '').includes('In the background:'))
  check('1 working hover is the full sentence', writerIcon?.getAttribute('title') === 'Writer. Working · 0m · Find the note', writerIcon?.getAttribute('title') || '')
  fx('tab-welcome').states = fx('tab-welcome').states.map((s) => s.id === 'conductor' ? working('conductor', 'Hand it off') : s)
  await emit('tab-welcome')
  check('1 an open working Conductor keeps its name, bobs, and shows an orange dot', text(conductorIcon?.querySelector('.desk-name')) === 'Conductor' && conductorIcon?.classList.contains('on') === true && anim(conductorIcon, '.desk-face') === 'desk-bob' && noBar(conductorIcon) && dotOk(conductorIcon))
  const railMid = (rail.getBoundingClientRect().left + rail.getBoundingClientRect().right) / 2
  const markEls = [...rail.querySelectorAll<HTMLElement>('.desk-bot'), plus].filter((el): el is HTMLElement => !!el)
  const centered = markEls.length === 6 && markEls.every((el) => Math.abs((el.getBoundingClientRect().left + el.getBoundingClientRect().right) / 2 - railMid) <= 2)
  const plusBox = plus?.getBoundingClientRect()
  const plusRadius = plus ? getComputedStyle(plus).borderRadius : ''
  const plusRound = !!plusBox && plusBox.width >= 36 && plusBox.height >= 36 && (plusRadius === '50%' || Math.abs(parseFloat(plusRadius) - plusBox.width / 2) <= 1)
  const faces = [...rail.querySelectorAll<SVGElement>('.desk-bot .desk-face')]
  const facesSized = faces.length === 5 && faces.every((el) => el.getBoundingClientRect().width >= 36 && el.getBoundingClientRect().height >= 36)
  check('1 faces sit with their names, centered, and the plus stays round', centered && plusRound && facesSized, `n=${markEls.length} faces=${faces.length}`)
  check('1 the plus is paper with ink letters', text(plus) === '+' && plus?.getAttribute('aria-label') === 'Add a teammate' && !!plus && getComputedStyle(plus).backgroundColor === paper && getComputedStyle(plus).color === ink)

  named(rail, 'Writer')?.click()
  await until(() => text(pane.querySelector('.bubble.md p')) === WRITER_HI)
  document.documentElement.classList.add('glass')
  const hi = pane.querySelector('.bubble.md')
  check('1 Writer greets as Writer', text(hi?.querySelector('p')) === WRITER_HI, text(hi?.querySelector('p')))
  check('1 Writer greeting has no starters and does not mention Conductor', buttons(hi).length === 0 && !text(hi).includes("I'm Conductor") && !text(hi).includes('hand the work'))
  check('1 Writer greeting sits in mdbody', text(hi?.querySelector('.mdbody')) === WRITER_HI)
  const writerOpen = named(rail, 'Writer')
  check('1 open Writer shows its name on the bobbing face', writerOpen?.classList.contains('on') === true && text(writerOpen?.querySelector('.desk-name')) === 'Writer' && anim(writerOpen, '.desk-face') === 'desk-bob' && noBar(writerOpen))
  check('1 Conductor is no longer the open mark', named(rail, 'Conductor')?.classList.contains('on') !== true)
  button(pane.querySelector('.filetab-head'), 'Edit')?.click()
  await until(() => rail.querySelector('input')?.value === 'Writer')
  const writerForm = rail.querySelector('.desk-form')
  check('1 Writer Edit shows Writer, a model, and Remove', (writerForm?.querySelector('input')?.value || '') === 'Writer' && !!writerForm?.querySelector('select') && !!button(writerForm, 'Remove'))
}

function paint(prop: string, value: string): string {
  const probe = document.createElement('span')
  probe.style.setProperty(prop, value)
  document.body.appendChild(probe)
  const got = getComputedStyle(probe).getPropertyValue(prop)
  probe.remove()
  return got
}

async function marksStage() {
  const { rail } = await mountPane('tab-marks', '1b. Content does not share Conductor’s mark')
  const icons = [...rail.querySelectorAll<HTMLButtonElement>('.desk-bot')]
  check('1b names are Conductor and Content', JSON.stringify(icons.map((b) => text(b.querySelector('.desk-name')))) === JSON.stringify(['Conductor', 'Content']), icons.map((b) => text(b.querySelector('.desk-name'))).join(','))
  check('1b the two faces differ', icons.length === 2 && icons[0].querySelector('.desk-face')?.getAttribute('data-shape') !== icons[1].querySelector('.desk-face')?.getAttribute('data-shape'))
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
  const { pane, rail } = await mountPane(tab, '4. the team thread from fixture messages', 220)
  const thread = pane.querySelector('.thread') as HTMLElement
  await until(() => thread.scrollHeight > thread.clientHeight && thread.scrollTop > 0)
  const gap = thread.scrollHeight - thread.clientHeight - thread.scrollTop
  check('4 the thread scrolls and rests at the bottom', thread.scrollHeight > thread.clientHeight && getComputedStyle(thread).overflowY === 'auto' && Math.abs(gap) <= 2, `gap=${gap} overflow=${getComputedStyle(thread).overflowY}`)
  check('4 at the bottom there is no Latest', !pane.querySelector('button.jump-latest'))
  thread.scrollTop = 40
  thread.dispatchEvent(new Event('scroll'))
  await until(() => !!pane.querySelector('button.jump-latest'))
  const latest = pane.querySelector<HTMLButtonElement>('button.jump-latest')
  const paneBox = pane.getBoundingClientRect()
  const latestBox = latest?.getBoundingClientRect()
  const hitsPane = !!latestBox && latestBox.left < paneBox.right && latestBox.right > paneBox.left && latestBox.top < paneBox.bottom && latestBox.bottom > paneBox.top
  check('4 Latest sits outside the thread and on the pane', !!latest && text(latest) === 'Latest' && !latest.closest('.thread') && hitsPane)
  fx(tab).messages = [...fx(tab).messages, { id: 'm_later', ts: at(9, 30), from: 'conductor', to: 'me', kind: 'reply', text: 'A later line arrived.' }]
  await emit(tab)
  await until(() => text(thread).includes('A later line arrived.'))
  check('4 a line that arrives while reading stays put', text(thread).includes('A later line arrived.') && Math.abs(thread.scrollTop - 40) <= 2, `top=${thread.scrollTop}`)
  const readyText = '**Ready.**\n\n- one\n- two'
  fx(tab).messages = [
    ...fx(tab).messages,
    { id: 'm_ready', ts: at(9, 31), from: 'conductor', to: 'me', kind: 'reply', text: readyText },
    { id: 'm_stars', ts: at(9, 32), from: 'me', to: 'conductor', kind: 'task', text: 'keep the **stars**' }
  ]
  await emit(tab)
  await until(() => !!thread.querySelector('.bubble.md strong'))
  check('4 the Ready reply stays put and Latest stays', Math.abs(thread.scrollTop - 40) <= 2 && !!pane.querySelector('button.jump-latest'), `top=${thread.scrollTop}`)
  const ready = [...thread.querySelectorAll<HTMLElement>('.bubble.md')].find((el) => text(el.querySelector('strong')) === 'Ready.')
  const readyBody = ready?.querySelector<HTMLElement>('.mdbody')
  const serifProbe = document.createElement('span')
  serifProbe.style.fontFamily = 'var(--serif)'
  document.body.appendChild(serifProbe)
  const serif = getComputedStyle(serifProbe).fontFamily
  serifProbe.remove()
  const readyItems = [...(ready?.querySelectorAll('li') || [])].map((el) => text(el))
  check(
    '4 a bot reply renders as serif markdown',
    !!readyBody && getComputedStyle(readyBody).fontFamily === serif && getComputedStyle(readyBody).whiteSpace === 'normal' && JSON.stringify(readyItems) === JSON.stringify(['one', 'two']) && !text(ready).includes('**'),
    `font=${readyBody ? getComputedStyle(readyBody).fontFamily : ''} space=${readyBody ? getComputedStyle(readyBody).whiteSpace : ''} items=${readyItems.join(',')}`
  )
  const stars = [...thread.querySelectorAll<HTMLElement>('.bubble.me')].find((el) => text(el).includes('**'))
  check('4 your line keeps the asterisks', !!stars && !stars.querySelector('strong') && text(stars).includes('**stars**'))
  latest?.click()
  await until(() => !pane.querySelector('button.jump-latest'))
  const back = thread.scrollHeight - thread.clientHeight - thread.scrollTop
  check('4 Latest returns to the bottom and goes away', Math.abs(back) <= 2 && !pane.querySelector('button.jump-latest'), `gap=${back}`)
  check('4 no welcome card once the thread has messages', !text(pane.querySelector('.thread')).includes("I'm Conductor"))

  const mine = [...thread.querySelectorAll<HTMLElement>('.bubble.me')]
  const prose = [...thread.querySelectorAll<HTMLElement>('.bubble.md')]
  const hops = [...thread.querySelectorAll<HTMLElement>('.bubble.sys')]
  const hop = (label: string) => hops.find((el) => text(el) === label)
  const muted = paint('color', 'var(--muted)')
  const isMe = (el: HTMLElement | undefined) => !!el && el.classList.contains('bubble') && el.classList.contains('me') && !el.closest('.fcard') && getComputedStyle(el).alignSelf === 'flex-end'
  const isProse = (el: HTMLElement | undefined) => !!el && el.classList.contains('md') && !el.classList.contains('me') && !el.classList.contains('sys') && !el.closest('.fcard')
  const isHop = (el: HTMLElement | undefined) => !!el && el.classList.contains('sys') && !el.closest('.fcard') && getComputedStyle(el).color === muted
  check('4 your task is a right-hand bubble', isMe(mine.find((el) => text(el).includes(TASK))) && text(mine.find((el) => text(el).includes(TASK))!).includes(TASK))
  check('4 a message typed to Writer stays off this chat', !text(thread).includes('Draft the three bullets.'))
  check('4 Conductor replies in prose', isProse(prose.find((el) => text(el) === 'Researcher is on it. I will tell you when Writer has a draft.')))
  check('4 a send to Conductor stays prose', isProse(prose.find((el) => text(el) === 'The draft is ready for you.')))
  const lineColor = paint('border-top-color', 'var(--line)')
  const isPill = (el: HTMLElement | undefined, titleText: string) => {
    if (!el || !isHop(el)) return false
    const style = getComputedStyle(el)
    const pad = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    return el.classList.contains('bubble') && style.borderTopWidth !== '0px' && style.borderTopColor === lineColor && pad.every((p) => p !== '0px') && el.offsetWidth < thread.offsetWidth && el.getAttribute('title') === titleText
  }
  check('4 the briefing is a muted line', isHop(hop('Message sent to Researcher.')))
  check('4 the handoff is a pill', isPill(hop('Message sent to Writer.'), 'Double-click to open Writer.'))
  check('4 Designer is a pill', isPill(hop('Message from Designer.'), 'Double-click to open Designer.'))
  check('4 a short reply shows under the pill', [...thread.querySelectorAll('.bubble.md')].some((el) => text(el) === 'Headline ideas are in the thread.') && !text(thread).includes('Designer responded.'))
  check('4 an unknown id reads Someone', isHop(hop('Message from Someone.')))
  const teamText = text(thread)
  check(
    '4 the briefing body is not on the team thread',
    !teamText.includes(PACK_TASK) && !teamText.includes('Reading 2 files') && !teamText.includes('Why: Joe wants three bullets from the newest Summit note.') && !teamText.includes("Couldn't find: clients/summit/old-notes.md") && !buttons(thread).some((b) => text(b) === NOTE || text(b) === 'clients/summit/context.md'),
    teamText.slice(0, 180)
  )
  check('4 the handoff paragraph is not on the team thread', !teamText.includes('Here are the three points'))

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
  let before = calls.length
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

  // Another bot's finished answer is a communication bubble, then a short account of what they did.
  const fromWriter = hop('Message from Writer.')
  const answered = [...thread.querySelectorAll<HTMLElement>('.bubble.md')].find((el) => text(el) === WRITER_SUMMARY)
  check('4 a finished answer is a message-from bubble', !!fromWriter && fromWriter.getAttribute('title') === 'Double-click to open Writer.')
  check('4 the team thread shows what Writer did', !!answered && !answered.classList.contains('sys') && !text(thread).includes('responded'))
  check('4 the other bot’s answer is not a tile on this thread', !cards(pane).some((c) => title(c).includes('Done')) && !text(thread).includes('Three bullets for Summit') && !text(thread).includes('Leads up 12%'))

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

  const slowCard = [...pane.querySelectorAll('.fcard')].find((el) => text(el).includes('Writer has been on this for 10 minutes.'))
  check('4 the slow card has Keep waiting and Stop', !!button(slowCard, 'Keep waiting') && !!button(slowCard, 'Stop'))
  check('4 the pane has one Stop and the rail has none', buttons(pane).filter((b) => text(b) === 'Stop').length === 1 && !buttons(rail).some((b) => text(b) === 'Stop'))
  before = calls.length
  button(slowCard, 'Keep waiting')?.click()
  button(slowCard, 'Stop')?.click()
  await tick()
  const slowGot = since(before)
  check('4 Keep waiting and Stop call the bot', slowGot.some((c) => c.fn === 'keepWaiting' && JSON.stringify(c.args) === JSON.stringify([tab, 'writer'])) && slowGot.some((c) => c.fn === 'stop' && JSON.stringify(c.args) === JSON.stringify([tab, 'writer'])), show(slowGot))
  const browseCard = [...pane.querySelectorAll('.fcard')].find((el) => text(el).includes('Opened https://example.com/'))
  const browseLines = browseCard ? bodyLines(browseCard) : []
  check(
    '4 browse steps are the six sentences',
    ['Opened https://example.com/', 'Clicked Pricing', 'Typed into Search', "Couldn't find Plans.", 'Scrolled', 'Pressed Enter'].every((line) => browseLines.includes(line)),
    browseLines.join(' | ')
  )
  const noteCard = [...pane.querySelectorAll('.fcard')].find((el) => text(el).includes('Writer saved a note'))
  before = calls.length
  button(noteCard, 'Open memory')?.click()
  await tick()
  check('4 Open memory opens the memory file', same(since(before), 'openFile', tab, '/fx/cards/desk/memory/writer.md'), show(since(before)))
  check('4 the mail pane has no corner picture', !pane.querySelector('.desk-pip img'))

  const sent = [...pane.querySelectorAll('.bubble.sys')].find((el) => text(el) === 'Message sent to Writer.')
  hop('Message from Designer.')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  hop('Message from Someone.')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await tick()
  check('4 Designer and Someone do not open a thread', text(pane.querySelector('.filetab-head span')) === 'Conductor')
  sent?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await tick()
  check('4 one click leaves the team thread', text(pane.querySelector('.filetab-head span')) === 'Conductor' && !text(pane.querySelector('.thread')).includes('Here are the three points'))
  before = calls.length
  sent?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Writer')
  check('4 double-click opens Writer', text(pane.querySelector('.filetab-head span')) === 'Writer' && since(before).some((c) => c.fn === 'view' && c.args[0] === tab && c.args[1] === 'writer'), show(since(before)))
  const handoff = [...pane.querySelectorAll('.bubble.md')].find((el) => text(el) === HANDOFF)
  const writerThread = text(pane.querySelector('.thread'))
  check('4 Writer’s thread shows the handoff prose', !!handoff, writerThread.slice(0, 200))
  const typedThere = [...pane.querySelectorAll<HTMLElement>('.bubble.me')].find((el) => text(el) === 'Draft the three bullets.')
  check('4 the line you typed to Writer is on Writer’s thread', isMe(typedThere))
  check('4 Writer’s thread does not show the briefing', !writerThread.includes('Reading 2 files') && !writerThread.includes('Why: Joe wants three bullets from the newest Summit note.') && !buttons(pane.querySelector('.thread')).some((b) => text(b) === NOTE))
  button(pane.querySelector('.filetab-head'), 'Team')?.click()
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Conductor')

  // Opening Writer shows the answer as their own words, not the summary and not a tile.
  before = calls.length
  ;[...pane.querySelectorAll('.bubble.sys')].find((el) => text(el) === 'Message from Writer.')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Writer')
  const writerAnswer = text(pane.querySelector('.thread'))
  check("4 opening Writer shows the answer", text(pane.querySelector('.filetab-head span')) === 'Writer' && !!button(pane.querySelector('.filetab-head'), 'Team') && writerAnswer.includes('Three bullets for Summit') && writerAnswer.includes('Leads up 12%') && writerAnswer.includes('Budget question still open') && !writerAnswer.includes(WRITER_SUMMARY) && !writerAnswer.includes('responded') && !cards(pane).some((c) => title(c).includes('Done')))
  check("4 Writer's thread loads Writer's view", since(before).some((c) => c.fn === 'view' && c.args[0] === tab && c.args[1] === 'writer'), show(since(before)))
  await until(() => pane.querySelector<HTMLTextAreaElement>('.composer textarea')?.placeholder === 'Message Writer')
  check('4 the composer talks to Writer there', pane.querySelector<HTMLTextAreaElement>('.composer textarea')?.placeholder === 'Message Writer')
}

async function formStage() {
  detectNow = { grok: true, claude: true, gpt: false, cursor: false }
  const tab = 'tab-form'
  const { rail } = await mountPane(tab, '5. add a teammate: the 800-character error')
  named(rail, 'Add a teammate')?.click()
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
  function mount(msg: DeskMessage, busy = false, picture?: { mode: 'small' | 'wide' | 'note'; src: string | null }) {
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
          picture={picture}
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
  const signIn = mount(
    { ...base, id: 'c_si', from: 'writer', kind: 'browse', text: 'Writer needs you to sign in, in the desk browser.', browse: { steps: [{ action: 'url', detail: 'https://example.com', url: 'https://example.com/login' }], signIn: true, windowOpen: true } },
    false,
    { mode: 'small', src: PIP_JPEG }
  )
  const signImg = signIn.el.querySelector('img')
  check(
    '6 sign-in card keeps its sentence and shows the picture under it',
    text(signIn.el.querySelector('.fcard-body')) === 'Writer needs you to sign in, in the desk browser.' &&
      !!signImg && !signImg.closest('.fcard-body') && !!signIn.el.querySelector('.desk-browser-slot')?.contains(signImg),
    text(signIn.el.querySelector('.fcard-body'))
  )
  button(signIn.el, 'Open browser')?.click()
  check('6 sign-in Open browser does not ask to bring the window forward', signIn.got.length === 1 && signIn.got[0].fn === 'openBrowser' && signIn.got[0].args.length === 0, show(signIn.got))

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

function boxInside(inner: DOMRect, outer: DOMRect): boolean {
  return inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
}

function fullyVisible(el: Element): boolean {
  const box = el.getBoundingClientRect()
  let node = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    const clips = ['auto', 'hidden', 'scroll'].includes(style.overflowY) || ['auto', 'hidden', 'scroll'].includes(style.overflow)
    if (clips && !boxInside(box, node.getBoundingClientRect())) return false
    node = node.parentElement
  }
  return box.width > 0 && box.height > 0
}

async function pipStage() {
  const tab = 'tab-pip'
  const older: DeskMessage = {
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
  const signIn: DeskMessage = {
    id: 'm_pip_si',
    ts: at(9, 21),
    from: 'writer',
    to: 'me',
    kind: 'browse',
    text: 'Writer needs you to sign in, in the desk browser.',
    browse: {
      steps: [{ action: 'url', detail: 'https://example.com', url: 'https://example.com/login' }],
      signIn: true,
      windowOpen: true
    }
  }
  addFixture(tab, '/fx/pip', MIXED, welcome(), [older, signIn])
  const { pane } = await mountPane(tab, '8. the picture in the thread', 980)
  await until(() => pane.querySelectorAll('img').length === 1)
  const thread = pane.querySelector('.thread')
  const cards = () => [...pane.querySelectorAll('.fcard')]
  const olderCard = () => cards().find((el) => text(el).includes('Example'))
  const signCard = () => cards().find((el) => text(el).includes('needs you to sign in'))
  const img = () => pane.querySelector('img')
  const imgBox = () => img()?.getBoundingClientRect()
  const shotBox = imgBox()
  const olderBox = olderCard()?.getBoundingClientRect()
  const threadBox = thread?.getBoundingClientRect()
  const signBox = signCard()?.getBoundingClientRect()
  check(
    '8 one picture, on the sign-in card under the sentence, and no corner strip',
    pane.querySelectorAll('img').length === 1 && !pane.querySelector('.desk-pip') &&
      !!shotBox && !!signBox && !!threadBox && !!thread?.contains(img()!) &&
      !!signCard()?.contains(img()!) && boxInside(shotBox, signBox) && boxInside(shotBox, threadBox) &&
      Math.round(shotBox.width) === 240 && Math.round(shotBox.height) === 150 &&
      !img()?.closest('.fcard-body') &&
      text(signCard()?.querySelector('.fcard-body')) === 'Writer needs you to sign in, in the desk browser.' &&
      !olderCard()?.querySelector('img'),
    shotBox ? `${Math.round(shotBox.width)}x${Math.round(shotBox.height)} imgs ${pane.querySelectorAll('img').length}` : 'no image'
  )
  let before = calls.length
  img()?.click()
  await tick()
  img()?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const wide = img()?.getBoundingClientRect()
  const wideCard = signCard()?.getBoundingClientRect()
  check(
    '8 a click enlarges the sign-in picture inside the card and does not bring Chrome forward',
    !!wide && !!wideCard && !!img() && wide.width > 240 && wide.height > 150 && wide.height <= 420 &&
      boxInside(wide, wideCard) && signCard()?.contains(img()!) && !img()!.closest('.fcard-body') && fullyVisible(img()!) &&
      !since(before).some((c) => c.fn === 'showWindow' || c.fn === 'browserShow' || c.fn === 'focus'),
    wide ? `${Math.round(wide.width)}x${Math.round(wide.height)} ${show(since(before).filter((c) => c.fn !== 'picture'))}` : 'no image'
  )
  before = calls.length
  button(signCard(), 'Open browser')?.click()
  await tick()
  check(
    '8 sign-in Open browser stays wide and does not bring the window forward',
    !!img()?.classList.contains('wide') && (img()?.getBoundingClientRect().height || 0) > 150 &&
      !since(before).some((c) => c.fn === 'showWindow' || c.fn === 'browserShow' || c.fn === 'focus'),
    show(since(before).filter((c) => c.fn !== 'picture'))
  )
  button(signCard(), 'Hide')?.click()
  await tick()
  const noteEl = [...(signCard()?.querySelectorAll('button, p') || [])].find((el) => text(el) === 'There were browsers.')
  check(
    '8 Hide leaves the note and no picture',
    !signCard()?.querySelector('img') && text(noteEl) === 'There were browsers.' && !noteEl?.closest('.fcard-body'),
    text(signCard())
  )
  before = calls.length
  noteEl?.click()
  await until(() => {
    const box = signCard()?.querySelector('img')?.getBoundingClientRect()
    return !!box && Math.round(box.width) === 240 && Math.round(box.height) === 150
  })
  const restored = signCard()?.querySelector('img')?.getBoundingClientRect()
  check(
    '8 the note brings the small picture back and does not bring Chrome forward',
    !!restored && Math.round(restored.width) === 240 && Math.round(restored.height) === 150 &&
      !since(before).some((c) => c.fn === 'showWindow' || c.fn === 'browserShow' || c.fn === 'focus'),
    restored ? `${Math.round(restored.width)}x${Math.round(restored.height)}` : 'no image'
  )
  before = calls.length
  button(olderCard(), 'Open browser')?.click()
  await tick()
  img()?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const opened = img()?.getBoundingClientRect()
  const openedCard = signCard()?.getBoundingClientRect()
  check(
    '8 Open browser enlarges the picture and does not bring Chrome forward',
    !!opened && !!openedCard && !!img() && opened.width > 240 && opened.height > 150 && opened.height <= 420 &&
      boxInside(opened, openedCard) && signCard()?.contains(img()!) && !img()!.closest('.fcard-body') && fullyVisible(img()!) &&
      !since(before).some((c) => c.fn === 'showWindow' || c.fn === 'browserShow' || c.fn === 'focus'),
    opened ? `${Math.round(opened.width)}x${Math.round(opened.height)} ${show(since(before).filter((c) => c.fn !== 'picture'))}` : 'no image'
  )
  button(signCard(), 'Hide')?.click()
  await until(() => !!signCard()?.querySelector('.desk-browser-note') && !signCard()?.querySelector('img'))
  const pics = () => calls.filter((c) => c.fn === 'picture').length
  const held = pics()
  await tick(2000)
  check('8 the note does not keep refreshing', pics() === held, `${pics() - held}`)
  const newer: DeskMessage = {
    id: 'm_pip_2',
    ts: at(9, 22),
    from: 'writer',
    to: 'me',
    kind: 'browse',
    text: 'Opened the next page.',
    browse: {
      steps: [{ action: 'url', detail: 'https://example.com/next', url: 'https://example.com/next' }],
      title: 'Next',
      windowOpen: true
    }
  }
  fx(tab).messages.push(newer)
  await emit(tab)
  await until(() => pane.querySelectorAll('img').length === 1 && Math.round(pane.querySelector('img')!.getBoundingClientRect().height) === 150)
  const nextCard = () => cards().find((el) => text(el).includes('Next'))
  const back = img()?.getBoundingClientRect()
  const nextBox = nextCard()?.getBoundingClientRect()
  check(
    '8 a newer browse brings the small picture back with no click',
    pane.querySelectorAll('img').length === 1 && !pane.querySelector('.desk-pip') &&
      !!back && !!nextBox && Math.round(back.width) === 240 && Math.round(back.height) === 150 &&
      nextCard()?.contains(img()!) && boxInside(back, nextBox) && !signCard()?.querySelector('img'),
    back ? `${Math.round(back.width)}x${Math.round(back.height)}` : 'no image'
  )
}

async function pasteStage() {
  const { pane } = await mountPane('tab-paste', '10. a long paste folds')
  const box = pane.querySelector<HTMLTextAreaElement>('.composer textarea')!
  const big = 'x'.repeat(1001)
  const token = '[Pasted text #1 +1 line]'
  box.focus()
  const dt = new DataTransfer()
  dt.setData('text/plain', big)
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  flushSync(() => box.dispatchEvent(ev))
  await tick()
  const chip = pane.querySelector('.paste-chip')
  check('10 a long paste becomes a token', ev.defaultPrevented && box.value === token, JSON.stringify(box.value))
  check('10 the chip names the paste', !!chip && /Pasted text #1/.test(text(chip)) && /1KB/.test(text(chip)) && /1 line/.test(text(chip)), text(chip))
  button(pane.querySelector('.composer'), 'Expand')?.click()
  await until(() => box.value === big)
  check('10 Expand writes the paste back', box.value === big && !pane.querySelector('.paste-chip'), JSON.stringify(box.value.slice(0, 40)))
  flushSync(() => typeInto(box, ''))
  const again = new DataTransfer()
  again.setData('text/plain', big)
  const ev2 = new ClipboardEvent('paste', { clipboardData: again, bubbles: true, cancelable: true })
  flushSync(() => box.dispatchEvent(ev2))
  await until(() => box.value === token)
  const before = calls.length
  button(pane.querySelector('.composer'), 'Send')?.click()
  await tick()
  const say = since(before).find((c) => c.fn === 'say')
  const pastes = say?.args[3] as { token: string; text: string }[] | undefined
  check(
    '10 send keeps the token and the paste',
    say?.args[1] === token && say?.args[2] === 'conductor' && pastes?.[0]?.token === token && pastes?.[0]?.text === big,
    show(since(before))
  )
  fx('tab-paste').messages = [{ id: 'm_p', ts: at(9, 1), from: 'me', to: 'conductor', kind: 'task', text: `See ${token}`, pastes: [{ token, text: big }] }]
  await emit('tab-paste')
  await until(() => (pane.querySelector('.bubble.me')?.textContent || '').includes(token))
  const bubble = pane.querySelector('.bubble.me')
  check('10 the thread folds the paste', !!bubble?.querySelector('.paste-label') && !(bubble.textContent || '').includes(big.slice(0, 40)))
  bubble?.querySelector<HTMLButtonElement>('.paste-label')?.click()
  await tick()
  check('10 show opens the paste', pane.querySelector('.paste-body')?.textContent === big)
}

async function hiddenStage() {
  localStorage.removeItem('desk-hidden:/fx/welcome')
  const { pane, rail } = await mountPane('tab-welcome', '9. hidden teammates')
  const mainBots = () =>
    [...rail.querySelectorAll<HTMLButtonElement>('.desk-bots:not(.desk-hidden-list) .desk-bot')].map((b) => b.getAttribute('aria-label'))
  named(rail, 'Writer')?.click()
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Writer')
  button(pane.querySelector('.filetab-head'), 'Edit')?.click()
  await until(() => !!button(rail.querySelector('.desk-form'), 'Hide'))
  button(rail.querySelector('.desk-form'), 'Hide')?.click()
  await until(() => !mainBots().includes('Writer') && !!rail.querySelector('.desk-hidden-list'))
  check(
    '9 Hide takes Writer off the rail and keeps Conductor',
    !mainBots().includes('Writer') && mainBots().includes('Conductor') &&
      named(rail.querySelector('.desk-hidden-list'), 'Writer')?.getAttribute('aria-label') === 'Writer' &&
      localStorage.getItem('desk-hidden:/fx/welcome') === '["writer"]'
  )
  button(rail, 'Hidden')?.click()
  await until(() => !rail.querySelector('.desk-hidden-list'))
  check('9 Hidden closes', !rail.querySelector('.desk-hidden-list') && button(rail, 'Hidden')?.getAttribute('aria-expanded') === 'false')
  button(rail, 'Hidden')?.click()
  await until(() => !!rail.querySelector('.desk-hidden-list'))
  check('9 Hidden opens onto Writer', named(rail.querySelector('.desk-hidden-list'), 'Writer')?.getAttribute('aria-label') === 'Writer')
  named(rail.querySelector('.desk-hidden-list'), 'Writer')?.click()
  await until(() => text(pane.querySelector('.filetab-head span')) === 'Writer')
  button(pane.querySelector('.filetab-head'), 'Edit')?.click()
  await until(() => !!button(rail.querySelector('.desk-form'), 'Show'))
  button(rail.querySelector('.desk-form'), 'Show')?.click()
  await until(() => mainBots().includes('Writer') && !button(rail, 'Hidden'))
  check('9 Show puts Writer back and the Hidden section goes', mainBots().includes('Writer') && !rail.querySelector('.desk-hidden'))
}

async function main() {
  await welcomeStage()
  await marksStage()
  await readinessStage()
  await everyoneStage()
  await threadStage()
  await formStage()
  cardStage()
  await pipStage()
  await pasteStage()
  await hiddenStage()
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
