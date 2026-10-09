import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'

// The browser picture with a pop-up on top and the cards a page can raise (camera and microphone, passkey, accounts):
// Close pop-up sits after Reload, cards show under the picture in the chat they were sent to, and each answers once.
// RENDER_UI_SIZE=1400,900 node --experimental-strip-types scripts/render-ui.ts browser-asks

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const openedListeners: ((owner: string) => void)[] = []
const askListeners: ((card: unknown) => void)[] = []
const endListeners: ((end: { owner: string; id: string; note: string }) => void)[] = []
const downloadListeners: ((d: { owner: string; id: string; name: string; state: string }) => void)[] = []
let popup = true

function jpeg(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')!
  g.fillStyle = '#eef3f6'
  g.fillRect(0, 0, 1100, 800)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}
const FACE = jpeg()

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.') && name !== 'browser.face') calls.push({ name, args })
    if (name === 'browser.onOpened') {
      openedListeners.push(args[0] as (owner: string) => void)
      return () => undefined
    }
    if (name === 'browser.onAsk') {
      askListeners.push(args[0] as (card: unknown) => void)
      return () => undefined
    }
    if (name === 'browser.onAskEnded') {
      endListeners.push(args[0] as (end: { owner: string; id: string; note: string }) => void)
      return () => undefined
    }
    if (name === 'browser.onDownload') {
      downloadListeners.push(args[0] as (d: { owner: string; id: string; name: string; state: string }) => void)
      return () => undefined
    }
    if (name === 'browser.face') return Promise.resolve({ src: FACE, signIn: false, url: 'https://accounts.example/auth', canGoBack: false, canGoForward: false, shared: false, popup })
    if (name === 'browser.askAnswer') return Promise.resolve({ ok: true })
    if (name === 'browser.closePopup') return Promise.resolve(true)
    if (name === 'slash.list') return Promise.resolve({ commands: [], models: [] })
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

function pane(id: string) {
  return (
    <div id={id} style={{ position: 'relative', width: 1000, height: 820 }}>
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
async function until(fn: () => boolean, label: string, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(label)
    await tick(20)
  }
}
async function send(id: string, text: string) {
  const box = document.querySelector(`#${id} .composer textarea`) as HTMLTextAreaElement
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(150)
}
const turn = (id: string) => (document.querySelector(`#${id} .page-dock .page-turn`) || document.querySelector(`#${id} .page-turn`)) as HTMLElement | null
const row = (id: string) =>
  [...(turn(id)?.querySelectorAll('.page-turn-actions > button, .page-turn-actions > input') || [])].map((el) =>
    el.tagName === 'INPUT' ? 'address' : el.getAttribute('aria-label') || (el.textContent || '').trim()
  )
const cards = (id: string) => [...(turn(id)?.querySelectorAll('.page-card') || [])] as HTMLElement[]
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined
const since = (n: number, name: string) => calls.slice(n).filter((c) => c.name === name)
const ask = (card: Record<string, unknown>) => flushSync(() => askListeners.forEach((l) => l(card)))

async function main() {
  createRoot(document.getElementById('root')!).render(
    <>
      {pane('a')}
      {pane('b')}
    </>
  )
  await until(() => !!document.querySelector('#a .composer textarea'), 'composer')
  await send('a', 'sign me in')
  await send('b', 'open a page')
  flushSync(() => openedListeners.forEach((l) => l('chat:a')))
  flushSync(() => openedListeners.forEach((l) => l('chat:b')))
  await until(() => !!turn('a')?.querySelector('.page-address') && (turn('a')?.querySelector('.page-address') as HTMLInputElement).value !== '', 'address shown')
  await until(() => row('a').includes('Close pop-up'), 'close pop-up', 4000)

  check('pop-up: the row is Hide, Wide, Large, Back, Forward, Reload, Close pop-up, the address', row('a').join(',') === 'Hide,Wide,Large,Back,Forward,Reload,Close pop-up,address', row('a').join(','))
  let n = calls.length
  buttonIn(turn('a')!, 'Close pop-up')!.click()
  check('Close pop-up asks main once for this chat', since(n, 'browser.closePopup').length === 1 && JSON.stringify(since(n, 'browser.closePopup')[0].args) === JSON.stringify(['chat:a']))
  popup = false
  await until(() => !row('a').includes('Close pop-up'), 'no close pop-up', 4000)
  check('no pop-up: no Close pop-up button', row('a').join(',') === 'Hide,Wide,Large,Back,Forward,Reload,address', row('a').join(','))

  flushSync(() => downloadListeners.forEach((l) => l({ owner: 'chat:a', id: 'd1', name: 'report.pdf', state: 'completed' })))
  ask({ owner: 'chat:a', id: 'k1', kind: 'site', site: 'https://meet.example', uses: ['camera', 'microphone'] })
  ask({ owner: 'chat:a', id: 'k2', kind: 'passkey', site: 'https://bank.example' })
  ask({ owner: 'chat:a', id: 'k3', kind: 'account', site: 'https://bank.example', accounts: [{ id: 'c1', name: 'joe@plyntr.com' }, { id: 'c2', name: 'Joe Two' }] })
  await tick(80)
  const texts = cards('a').map((c) => (c.textContent || '').trim())
  check('the three cards show under chat a with their words', texts.length === 3 && /meet\.example wants to use your camera and microphone\./.test(texts[0]) && /bank\.example is asking for a passkey\./.test(texts[1]) && /Touch ID/.test(texts[1]) && /Sign in to bank\.example as:/.test(texts[2]), JSON.stringify(texts))
  check('chat b shows no card', cards('b').length === 0)
  check('the download line stays under the cards', !!turn('a')?.querySelector('.page-download') && turn('a')!.querySelector('.page-cards')!.compareDocumentPosition(turn('a')!.querySelector('.page-downloads')!) === Node.DOCUMENT_POSITION_FOLLOWING)

  n = calls.length
  buttonIn(cards('a')[0], 'Allow')!.click()
  await tick(40)
  buttonIn(cards('a')[0], 'Allow')!.click()
  check('Allow answers once, then the card goes quiet', since(n, 'browser.askAnswer').length === 1 && JSON.stringify(since(n, 'browser.askAnswer')[0].args) === JSON.stringify(['chat:a', 'k1', 'allow']) && buttonIn(cards('a')[0], 'Allow')!.disabled && buttonIn(cards('a')[0], "Don't allow")!.disabled)
  n = calls.length
  buttonIn(cards('a')[1], 'Cancel')!.click()
  check('Cancel on the passkey card answers cancel', JSON.stringify(since(n, 'browser.askAnswer')[0]?.args) === JSON.stringify(['chat:a', 'k2', 'cancel']))
  n = calls.length
  buttonIn(cards('a')[2], 'Joe Two')!.click()
  check('picking an account answers with its id', JSON.stringify(since(n, 'browser.askAnswer')[0]?.args) === JSON.stringify(['chat:a', 'k3', 'c2']))

  flushSync(() => endListeners.forEach((l) => l({ owner: 'chat:a', id: 'k1', note: 'Allowed.' })))
  flushSync(() => endListeners.forEach((l) => l({ owner: 'chat:a', id: 'k2', note: '' })))
  await tick(60)
  const after = cards('a').map((c) => (c.textContent || '').trim())
  check('an ended card keeps its note; one that ends with nothing goes', after.length === 2 && /Allowed\./.test(after[0]) && !buttonIn(cards('a')[0], 'Allow') && /Sign in to bank\.example/.test(after[1]), JSON.stringify(after))

  ;([...turn('a')!.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Large') as HTMLButtonElement).click()
  await until(() => !!document.querySelector('#a .page-dock'), 'dock')
  check('large: the cards show in the dock too', cards('a').length === 2)

  // Leave the picture wide and in view, so the screenshot shows the row and the cards.
  ask({ owner: 'chat:a', id: 'k4', kind: 'site', site: 'https://meet.example', uses: ['camera'] })
  popup = true
  ;([...turn('a')!.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Wide') as HTMLButtonElement).click()
  await until(() => !!turn('a')?.querySelector('img.wide') && row('a').includes('Close pop-up'), 'wide again', 4000)
  document.getElementById('b')!.style.display = 'none'
  turn('a')!.scrollIntoView({ block: 'start' })
  await tick(200)

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
