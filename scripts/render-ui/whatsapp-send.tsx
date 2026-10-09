import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { DeskCli, WhatsAppSendAnswer, WhatsAppSendAsk } from '../../src/shared/desk'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { DeskPane } from '../../src/renderer/src/DeskPane'

// The WhatsApp Send card in a chat and the WhatsApp tile on Desk, on the real panes.
// node --experimental-strip-types scripts/render-ui.ts whatsapp-send

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const askListeners: ((a: WhatsAppSendAsk) => void)[] = []
const openedListeners: ((owner: string) => void)[] = []
const answers = new Map<string, WhatsAppSendAnswer>()

function jpeg(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')!
  g.fillStyle = '#f4f1ea'
  g.fillRect(0, 0, 1100, 800)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}
const FACE = jpeg()

const tile = (id: string, body: string) => ({
  id,
  ts: '2026-10-09T09:20:00.000Z',
  from: 'drafts',
  to: 'me',
  kind: 'text' as const,
  text: 'Raj Patel',
  textMsg: { to: 'Raj Patel', via: 'WhatsApp' as const, body, sendable: true, account: 'india', note: "Sends from WhatsApp (india) in Brain's browser." }
})

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.') || name.startsWith('desk.answer')) calls.push({ name, args })
    if (name === 'browser.onSendAsk') {
      askListeners.push(args[0] as (a: WhatsAppSendAsk) => void)
      return () => undefined
    }
    if (name === 'browser.onOpened') {
      openedListeners.push(args[0] as (owner: string) => void)
      return () => undefined
    }
    if (name === 'browser.sendAnswer') {
      const answer = answers.get(String(args[1])) ?? { ok: true, chat: 'Raj Patel' }
      return new Promise((done) => setTimeout(() => done(answer), 300))
    }
    if (name === 'browser.face') return Promise.resolve({ src: FACE, signIn: false })
    if (name === 'desk.attach') return Promise.resolve({ brain: '/fx/desk' })
    if (name === 'desk.welcome')
      return Promise.resolve({ greetingName: 'Joe', greeting: 'Desk is here.', starters: [], readiness: [], composerDisabled: false, composerPlaceholder: 'Message Conductor', everyoneLine: null })
    if (name === 'desk.list')
      return Promise.resolve({
        bots: [{ id: 'drafts', name: 'Drafts', cli: 'grok', model: 'default', effort: 'low', description: 'Drafts.', file: '/fx/drafts.md' }],
        states: [{ id: 'drafts', state: 'idle' }],
        removedNames: {}
      })
    if (name === 'desk.view') return Promise.resolve([tile('t1', 'The September note is ready.'), tile('t2', 'Second draft.')])
    if (name === 'slash.list') return Promise.resolve({ commands: [], models: [] })
    if (name === 'ai.detect') return Promise.resolve({ grok: true, claude: false, gpt: false, cursor: false })
    if (name === 'chat.send') return Promise.resolve({ ok: true })
    if (/\.on[A-Z]/.test(name)) return () => undefined
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}
;(window as unknown as { brain: unknown }).brain = bridge([])

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) })
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const noop = () => undefined

function chat(id: string) {
  return (
    <div id={id} className="stage-pane" style={{ position: 'relative', height: 700 }}>
      <ChatPane
        id={id}
        kind="grok"
        cwd="/tmp/brain"
        sessionId={`s-${id}`}
        active
        greeting="Hi."
        onFiles={noop}
        onNew={noop}
        onModel={noop}
        onEffort={noop}
        onCaps={noop}
        onTranscript={noop}
        onContext={noop}
        onApprove={noop}
        onRename={noop}
        onResume={noop}
        onFork={noop}
        onAgentMode={noop}
        onDelete={noop}
        onOpenTerm={noop}
        onBusy={noop}
        onActivity={noop}
      />
    </div>
  )
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
async function until(fn: () => boolean, label: string, ms = 4000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(label)
    await tick(20)
  }
}
async function send(id: string, text: string) {
  const box = document.querySelector<HTMLTextAreaElement>(`#${id} .composer textarea`)!
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(200)
}
const askFor = (a: WhatsAppSendAsk) => flushSync(() => askListeners.forEach((l) => l(a)))
const cards = (id: string) => [...document.querySelectorAll(`#${id} .wa-send-card`)] as HTMLElement[]
const buttons = (el: Element | undefined) => [...(el?.querySelectorAll('button') || [])].map((b) => (b.textContent || '').trim())
const press = (el: Element, label: string) => ([...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement).click()
const answered = (id: string) => calls.filter((c) => c.name === 'browser.sendAnswer' && c.args[1] === id)
/** The user text of the turn that holds this element. */
function ownerTurnText(el: Element): string {
  const turn = el.closest('.skin-user-turn')
  return (turn?.firstElementChild?.textContent || '').trim()
}

async function main() {
  createRoot(document.getElementById('root')!).render(
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '540px 540px' }}>
        {chat('a')}
        {chat('b')}
      </div>
      <div id="desk" style={{ width: 900, height: 640, position: 'relative' }}>
        <DeskPane
          id="desk-1"
          cwd="/fx/desk"
          active
          rail={null}
          closing={false}
          onClosed={noop}
          onKeep={noop}
          onOpenFile={noop}
          modelsFor={(_cli: DeskCli, list?: { id: string; label: string }[]) => (list && list.length ? list : [{ id: 'default', label: 'Default' }])}
          effortsFor={() => []}
        />
      </div>
    </>
  )
  await until(() => !!document.querySelector('#a .composer textarea'), 'chat composer')

  await send('a', 'send it to Raj')
  flushSync(() => openedListeners.forEach((l) => l('chat:a')))
  await until(() => !!document.querySelector('#a .page-turn img'), 'page picture')
  askFor({ owner: 'chat:a', id: 'c1', account: 'india', to: 'Raj', text: 'Hello Raj\nSecond line' })
  await tick(80)
  const c1 = cards('a')[0]
  check('one card in chat a, none in chat b', cards('a').length === 1 && cards('b').length === 0, `${cards('a').length} ${cards('b').length}`)
  check('the card sits in the turn that asked', !!c1 && ownerTurnText(c1).includes('send it to Raj'), c1 ? ownerTurnText(c1) : 'none')
  check('the card shows the account, who, and the text with its line break', !!c1 && /WhatsApp \(india\) to Raj/.test(c1.textContent || '') && (c1.querySelector('.wa-send-text') as HTMLElement)?.innerText === 'Hello Raj\nSecond line', c1?.textContent || '')
  check('the buttons are Send and Don\'t send', buttons(c1).join(',') === "Send,Don't send", buttons(c1).join(','))
  const page = document.querySelector('#a .page-turn')!
  check('the card sits after the page picture in that turn', !!(page.compareDocumentPosition(c1) & Node.DOCUMENT_POSITION_FOLLOWING), '')

  press(c1, 'Send')
  await tick(40)
  check('Send calls sendAnswer yes once and shows Sending…', answered('c1').length === 1 && answered('c1')[0].args[0] === 'chat:a' && answered('c1')[0].args[2] === true && /Sending…/.test(cards('a')[0].textContent || '') && buttons(cards('a')[0]).length === 0, JSON.stringify(answered('c1').map((c) => c.args)))
  await until(() => /Sent to Raj Patel\./.test(cards('a')[0]?.textContent || ''), 'sent text')
  check('then it shows Sent to Raj Patel with no buttons', buttons(cards('a')[0]).length === 0)

  answers.set('c2', { ok: false, note: 'No WhatsApp chat named Nobody.' })
  askFor({ owner: 'chat:a', id: 'c2', account: 'main', to: 'Nobody', text: 'Hi' })
  await tick(80)
  press(cards('a')[1], 'Send')
  await until(() => /Not sent: No WhatsApp chat named Nobody\./.test(cards('a')[1]?.textContent || ''), 'failed text')
  check('a failed send shows Not sent and the note, no buttons', buttons(cards('a')[1]).length === 0 && answered('c2').length === 1)

  answers.set('c3', { ok: false, note: 'Not sent.' })
  askFor({ owner: 'chat:a', id: 'c3', account: 'main', to: 'Raj', text: 'Maybe not' })
  await tick(80)
  press(cards('a')[2], "Don't send")
  await until(() => /^.*Not sent\.$/.test((cards('a')[2]?.querySelector('.wa-send-outcome')?.textContent || '').trim()), 'declined text')
  check("Don't send calls sendAnswer no once and shows Not sent.", answered('c3').length === 1 && answered('c3')[0].args[2] === false && buttons(cards('a')[2]).length === 0 && cards('a')[2].querySelector('.wa-send-outcome')?.textContent === 'Not sent.', JSON.stringify(answered('c3').map((c) => c.args)))

  askFor({ owner: 'chat:a', id: 'c1', account: 'india', to: 'Raj', text: 'Hello Raj\nSecond line' })
  await tick(80)
  check('the same card asked again does not show twice', cards('a').length === 3, String(cards('a').length))

  await until(() => !!document.querySelector('#desk .fcard'), 'desk tiles', 6000)
  await tick(200)
  const deskTiles = [...document.querySelectorAll('#desk .fcard')].filter((c) => /Via: WhatsApp/.test(c.textContent || '')) as HTMLElement[]
  check('the Desk WhatsApp tiles show Account: india', deskTiles.length === 2 && deskTiles.every((t) => /Account: india/.test(t.textContent || '')), deskTiles.map((t) => t.textContent).join(' | '))
  const sendBtn = [...deskTiles[0].querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Send') as HTMLButtonElement | undefined
  check('the Desk WhatsApp tile has an enabled Send', !!sendBtn && !sendBtn.disabled)
  sendBtn?.click()
  await tick(80)
  const after = [...deskTiles[0].querySelectorAll('button')] as HTMLButtonElement[]
  check('after Send, the tile\'s Send and Not now wait (no second press)', after.length === 2 && after.every((b) => b.disabled), after.map((b) => `${b.textContent}:${b.disabled}`).join(','))
  const notNow = [...deskTiles[1].querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Not now') as HTMLButtonElement | undefined
  notNow?.click()
  await tick(80)
  const deskCalls = calls.filter((c) => c.name === 'desk.answerText')
  check('Send answers yes and Not now answers no', deskCalls.length === 2 && deskCalls[0].args[1] === 't1' && deskCalls[0].args[2] === 'yes' && deskCalls[1].args[1] === 't2' && deskCalls[1].args[2] === 'no', JSON.stringify(deskCalls.map((c) => c.args)))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
