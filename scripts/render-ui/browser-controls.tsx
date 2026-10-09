import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'

// The browser picture's control row on two real chats: Back, Forward, Reload and the address field after the sizes,
// download lines, and no right-click or Cmd+P reaching the page from the wrong place.
// RENDER_UI_SIZE=1400,900 node --experimental-strip-types scripts/render-ui.ts browser-controls

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const openedListeners: ((owner: string) => void)[] = []
const downloadListeners: ((d: { owner: string; id: string; name: string; state: string }) => void)[] = []
let canGoBack = false

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

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.') && name !== 'browser.face') calls.push({ name, args })
    if (name === 'browser.onOpened') {
      openedListeners.push(args[0] as (owner: string) => void)
      return () => undefined
    }
    if (name === 'browser.onDownload') {
      downloadListeners.push(args[0] as (d: { owner: string; id: string; name: string; state: string }) => void)
      return () => undefined
    }
    if (name === 'browser.face') return Promise.resolve({ src: FACE, signIn: false, url: 'https://a.example/page', canGoBack, canGoForward: false, shared: false })
    if (name === 'browser.go' || name === 'browser.nav' || name === 'browser.print') return Promise.resolve(true)
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

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
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
const press = (id: string, label: string) =>
  ([...turn(id)!.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent || '').trim() === label) as HTMLButtonElement).click()
const since = (n: number, name?: string) => calls.slice(n).filter((c) => !name || c.name === name)

async function main() {
  createRoot(document.getElementById('root')!).render(
    <>
      {pane('a')}
      {pane('b')}
    </>
  )
  await until(() => !!document.querySelector('#a .composer textarea'), 'composer')
  await send('a', 'open a page')
  flushSync(() => openedListeners.forEach((l) => l('chat:a')))
  await until(() => !!turn('a')?.querySelector('img'), 'picture')
  await until(() => (turn('a')?.querySelector('.page-address') as HTMLInputElement | null)?.value === 'https://a.example/page', 'address shown')

  const want = (sizes: string[]) => ['Hide', ...sizes, 'Back', 'Forward', 'Reload', 'address'].join(',')
  check('small: the row is Hide, Wide, Large, Back, Forward, Reload, the address', row('a').join(',') === want(['Wide', 'Large']), row('a').join(','))
  const back = () => [...turn('a')!.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back') as HTMLButtonElement
  check('Back is disabled when the page cannot go back', back().disabled === true)
  canGoBack = true
  await until(() => !back().disabled, 'back enabled', 4000)
  check('Back turns on when the face says it can go back', !back().disabled)
  let n = calls.length
  back().click()
  check('Back calls nav back for this chat', since(n, 'browser.nav').length === 1 && JSON.stringify(since(n, 'browser.nav')[0].args) === JSON.stringify(['chat:a', 'back']), JSON.stringify(since(n)))

  const addr = turn('a')!.querySelector('.page-address') as HTMLInputElement
  addr.focus()
  flushSync(() => typeInto(addr, 'example.com'))
  n = calls.length
  addr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(60)
  check('Enter in the address field calls go once with the typed text', since(n, 'browser.go').length === 1 && JSON.stringify(since(n, 'browser.go')[0].args) === JSON.stringify(['chat:a', 'example.com']), JSON.stringify(since(n)))

  const img = turn('a')!.querySelector('img') as HTMLImageElement
  const shot = turn('a')!.querySelector('.desk-browser-shot') as HTMLButtonElement
  const r = img.getBoundingClientRect()
  n = calls.length
  img.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2, buttons: 2 }))
  img.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }))
  img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }))
  await tick(60)
  check('a right-click on the small picture sends nothing to main', since(n).every((c) => c.name !== 'browser.pointer' && c.name !== 'browser.key'), JSON.stringify(since(n).map((c) => c.name)))

  press('a', 'Wide')
  await until(() => !!turn('a')?.querySelector('img.wide'), 'wide')
  check('wide: the row is Hide, Small, Large, Back, Forward, Reload, the address', row('a').join(',') === want(['Small', 'Large']), row('a').join(','))
  const wideShot = turn('a')!.querySelector('.desk-browser-shot') as HTMLButtonElement
  wideShot.focus()
  n = calls.length
  wideShot.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', metaKey: true, ctrlKey: !/mac/i.test(navigator.platform), bubbles: true, cancelable: true }))
  await tick(60)
  check('Cmd+P on a wide picture prints and sends no key to the page', since(n, 'browser.print').length === 1 && since(n, 'browser.key').length === 0, JSON.stringify(since(n).map((c) => c.name)))
  void shot

  press('a', 'Large')
  await until(() => !!document.querySelector('#a .page-dock'), 'dock')
  check('large: the row is Hide, Small, Wide, Back, Forward, Reload, the address', row('a').join(',') === want(['Small', 'Wide']), row('a').join(','))

  flushSync(() => downloadListeners.forEach((l) => l({ owner: 'chat:a', id: 'd1', name: 'report.pdf', state: 'completed' })))
  flushSync(() => downloadListeners.forEach((l) => l({ owner: 'chat:a', id: 'd2', name: 'big.zip', state: 'interrupted' })))
  await tick(60)
  const lines = [...(turn('a')?.querySelectorAll('.page-download') || [])].map((el) => (el.textContent || '').trim())
  check('the download lines show under chat a: name, Open, Show in Finder; a broken one says so', lines.length === 2 && lines[0].includes('report.pdf') && lines[0].includes('Open') && lines[0].includes('Show in Finder') && lines[1].includes('big.zip did not finish'), JSON.stringify(lines))
  check('chat b shows no download line', !document.querySelector('#b .page-download'))
  n = calls.length
  ;([...turn('a')!.querySelectorAll('.page-download button')].find((b) => b.textContent === 'Show in Finder') as HTMLButtonElement).click()
  check('Show in Finder asks main by id', since(n, 'browser.openDownload').length === 1 && JSON.stringify(since(n, 'browser.openDownload')[0].args) === JSON.stringify(['d1', 'show']))

  press('a', 'Hide')
  await tick(80)
  check('the note shows none of the row', !!turn('a')?.querySelector('.desk-browser-note') && row('a').length === 0, row('a').join(','))
  ;(turn('a')!.querySelector('.desk-browser-note') as HTMLButtonElement).click()
  await tick(80)
  press('a', 'Wide')
  await tick(200)

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})

