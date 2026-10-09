import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'

// The thread stays where the person is while the browser picture refreshes, and the picture follows the work.
// RENDER_UI_SIZE=1000,800 node --experimental-strip-types scripts/render-ui.ts browser-follow

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const chatListeners: ((e: unknown) => void)[] = []
const openedListeners: ((owner: string) => void)[] = []
const frameListeners: ((f: { owner: string; url: string; src: string }) => void)[] = []

function jpeg(shade: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')!
  g.fillStyle = shade
  g.fillRect(0, 0, 1100, 800)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}
const SHADES = [jpeg('#f4f1ea'), jpeg('#cfe8ff')]
const LIVE = jpeg('#ffe0cc')
let faces = 0

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.')) calls.push({ name, args })
    if (name === 'chat.onEvent') {
      chatListeners.push(args[0] as (e: unknown) => void)
      return () => undefined
    }
    if (name === 'browser.onOpened') {
      openedListeners.push(args[0] as (owner: string) => void)
      return () => undefined
    }
    if (name === 'browser.onFrame') {
      const h = args[0] as (f: { owner: string; url: string; src: string }) => void
      frameListeners.push(h)
      return () => {
        const i = frameListeners.indexOf(h)
        if (i >= 0) frameListeners.splice(i, 1)
      }
    }
    // Every poll is a new frame, as on a live page.
    if (name === 'browser.face') return Promise.resolve({ src: SHADES[faces++ % 2], signIn: false })
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

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
/** Waits for the condition (a busy machine renders late) and says whether it came true. */
async function settles(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) return false
    await tick(20)
  }
  return true
}
async function until(fn: () => boolean, label: string, ms = 4000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(label)
    await tick(20)
  }
}
async function send(text: string, wait = 120) {
  const box = document.querySelector('#stage .composer textarea') as HTMLTextAreaElement
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(wait)
}
const done = () => flushSync(() => chatListeners.forEach((l) => l({ tabId: 'a', kind: 'done' })))
const thread = () => document.querySelector('#stage .skin-thread') as HTMLElement
const atEnd = () => {
  const t = thread()
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80
}
const toEnd = () => {
  const t = thread()
  t.scrollTop = t.scrollHeight
  t.dispatchEvent(new Event('scroll'))
}
const turns = () => [...document.querySelectorAll('#stage .page-turn')]
function ownerTurnText(el: Element): string {
  const turn = el.closest('.skin-user-turn')
  return (turn?.firstElementChild?.textContent || '').trim()
}
const press = (el: Element, label: string) => ([...el.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement).click()
const reply = (text: string) => flushSync(() => chatListeners.forEach((l) => l({ tabId: 'a', kind: 'text', data: text })))
/** Never two watch(true) without a watch(false) between them. */
function balanced(): boolean {
  let live = 0
  for (const c of calls) {
    if (c.name !== 'browser.watch' || c.args[0] !== 'chat:a') continue
    live += c.args[1] ? 1 : -1
    if (live > 1 || live < 0) return false
  }
  return true
}
const watches = (on: boolean) => calls.filter((c) => c.name === 'browser.watch' && c.args[0] === 'chat:a' && c.args[1] === on).length

async function main() {
  createRoot(document.getElementById('root')!).render(
    <div id="stage" style={{ position: 'relative', width: 980, height: 760 }}>
      <ChatPane
        id="a"
        kind="grok"
        cwd="/tmp/brain"
        sessionId="s-a"
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
  await until(() => !!document.querySelector('#stage .composer textarea'), 'composer')

  await send('open it')
  reply(Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a long answer that runs well past the window.`).join('\n\n'))
  done()
  await tick(150)
  check('setup: the reply makes the thread much taller than the window', thread().scrollHeight > thread().clientHeight * 2.5, `${thread().scrollHeight}/${thread().clientHeight}`)
  toEnd()
  await tick(80)
  const top0 = thread().scrollTop
  flushSync(() => openedListeners.forEach((l) => l('chat:a')))
  await until(() => !!document.querySelector('#stage .page-turn img')?.getAttribute('src'), 'picture')
  await tick(150)
  const first = turns()[0]
  check('1 the picture appears in the "open it" turn, above the reply', !!first && ownerTurnText(first) === 'open it', first ? ownerTurnText(first) : 'none')
  check('1 the picture appearing keeps a pinned thread at the end', atEnd() && thread().scrollTop >= top0 - 1, `top ${top0} -> ${thread().scrollTop}, end ${atEnd()}`)
  check('1 the picture is far above the end', first.getBoundingClientRect().bottom < thread().getBoundingClientRect().top, `${first.getBoundingClientRect().bottom} vs ${thread().getBoundingClientRect().top}`)
  const top1 = thread().scrollTop
  const f1 = faces
  await tick(3200)
  check('1 two or more frames landed while waiting', faces - f1 >= 2, String(faces - f1))
  check('1 pinned at the end, frames do not pull the thread up to the picture (F1)', atEnd() && thread().scrollTop >= top1 - 1, `top ${top1} -> ${thread().scrollTop}, end ${atEnd()}`)

  thread().scrollTop = Math.max(0, thread().scrollTop - 600)
  thread().dispatchEvent(new Event('scroll'))
  await tick(80)
  const top2 = thread().scrollTop
  const tr = thread().getBoundingClientRect()
  const reading = [...thread().querySelectorAll('p')].find((el) => el.getBoundingClientRect().top >= tr.top && /Paragraph/.test(el.textContent || '')) as HTMLElement
  const readTop = reading.getBoundingClientRect().top
  const f2 = faces
  await tick(1700)
  check('2 scrolled up, a frame lands and the thread does not move (F2)', faces - f2 >= 1 && thread().scrollTop === top2, `${top2} -> ${thread().scrollTop}, faces ${faces - f2}`)
  press(turns()[0], 'Wide')
  await until(() => !!document.querySelector('#stage .page-turn img.wide'), 'wide')
  await tick(60)
  const readNow = reading.getBoundingClientRect().top
  await tick(1200)
  check('2 scrolled up, Wide leaves the lines being read in place', Math.abs(readNow - readTop) <= 2 && Math.abs(reading.getBoundingClientRect().top - readTop) <= 2, `${reading.textContent?.slice(0, 14)} ${readTop} -> ${readNow} -> ${reading.getBoundingClientRect().top}`)
  press(turns()[0], 'Small')
  await tick(100)

  toEnd()
  await tick(80)
  await send('next')
  await settles(() => turns().length === 1 && ownerTurnText(turns()[0]) === 'next' && atEnd())
  const next = turns()
  check('3 a new message moves the small picture under it, thread at the end (F4)', next.length === 1 && ownerTurnText(next[0]) === 'next' && (next[0].querySelector('img') as HTMLImageElement)?.className === '' && atEnd(), next[0] ? ownerTurnText(next[0]) : String(next.length))
  press(next[0], 'Wide')
  await until(() => !!document.querySelector('#stage .page-turn img.wide'), 'wide at the end')
  await settles(() => atEnd())
  const inView = () => {
    const t = thread().getBoundingClientRect()
    const p = (document.querySelector('#stage .page-turn img.wide') as HTMLElement).getBoundingClientRect()
    return { ok: atEnd() && p.bottom <= t.bottom + 1 && p.top >= t.top - 1, at: `${p.top}-${p.bottom} in ${t.top}-${t.bottom}, end ${atEnd()}` }
  }
  const w1 = inView()
  await tick(1200)
  const w2 = inView()
  check('3 Wide while pinned keeps the end and the whole wide picture in view (F3, F1)', w1.ok && w2.ok, `${w1.at} | ${w2.at}`)

  const on4 = watches(true)
  const off4 = watches(false)
  done()
  await send('wide move')
  await settles(() => turns().length === 1 && ownerTurnText(turns()[0]) === 'wide move' && atEnd())
  const moved = turns()
  check('4 a new message moves the wide picture under it, still wide, thread at the end', moved.length === 1 && ownerTurnText(moved[0]) === 'wide move' && !!moved[0].querySelector('img.wide') && atEnd(), moved[0] ? ownerTurnText(moved[0]) : String(moved.length))
  check('4 across the move at most one stop and one start, one live watch, never two (F5)', watches(true) - on4 <= 1 && watches(false) - off4 <= 1 && watches(true) - watches(false) === 1 && balanced(), `${on4}/${off4} -> ${watches(true)}/${watches(false)}`)
  flushSync(() => frameListeners.forEach((l) => l({ owner: 'chat:a', url: 'https://a.example', src: LIVE })))
  await tick(60)
  check('4 a live frame after the move shows in the one picture', [...document.querySelectorAll('#stage .page-turn img')].length === 1 && (document.querySelector('#stage .page-turn img') as HTMLImageElement).getAttribute('src') === `data:image/jpeg;base64,${LIVE}`)

  press(turns()[0], 'Small')
  await tick(100)
  done()
  await send('small move')
  await settles(() => turns().length === 1 && ownerTurnText(turns()[0]) === 'small move')
  const small = turns()
  check('5 a small picture moves too', small.length === 1 && ownerTurnText(small[0]) === 'small move' && (small[0].querySelector('img') as HTMLImageElement)?.className === '', small[0] ? ownerTurnText(small[0]) : String(small.length))

  press(turns()[0], 'Hide')
  await tick(100)
  done()
  await send('after hide')
  await tick(150)
  const noted = turns()
  check('6 a hidden picture stays where it was, nothing under the new message (F4)', noted.length === 1 && ownerTurnText(noted[0]) === 'small move' && !!noted[0].querySelector('.desk-browser-note'), noted[0] ? ownerTurnText(noted[0]) : String(noted.length))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
