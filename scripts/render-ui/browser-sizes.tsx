import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { mapClick } from '../../src/shared/page-picture'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'

// Small, Wide and Large for the chat's browser picture, on two real chats.
// RENDER_UI_SIZE=1400,900 RENDER_UI_HASH=end=large node --experimental-strip-types scripts/render-ui.ts browser-sizes

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const chatListeners: ((e: unknown) => void)[] = []
const openedListeners: ((owner: string) => void)[] = []
const frameListeners: ((f: { owner: string; url: string; src: string }) => void)[] = []
let signIn = false

function jpeg(shade: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')!
  g.fillStyle = shade
  g.fillRect(0, 0, 1100, 800)
  g.fillStyle = '#123'
  g.fillRect(60, 60, 300, 80)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}
const FIRST = jpeg('#f4f1ea')
const NEXT = jpeg('#cfe8ff')

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.') && name !== 'browser.face') calls.push({ name, args })
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
    if (name === 'browser.face') return Promise.resolve({ src: FIRST, signIn })
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
const OWNER = 'chat:a'

let showTab: (id: string) => void = noop
function Stage() {
  const [on, setOn] = useState('a')
  showTab = setOn
  return (
    <div id="stage" style={{ position: 'relative', width: 1000, height: 860 }}>
      {['a', 'b'].map((id) => (
        <ChatPane
          key={id}
          id={id}
          kind="grok"
          cwd="/tmp/brain"
          sessionId={`s-${id}`}
          active={on === id}
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
      ))}
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
const pane = () => document.querySelector('#stage .chatpane.on') as HTMLElement
const textarea = () => pane().querySelector('.composer textarea') as HTMLTextAreaElement
async function send(text: string, wait = 160) {
  const box = textarea()
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(wait)
}
const fire = () => flushSync(() => openedListeners.forEach((l) => l(OWNER)))
const done = () => flushSync(() => chatListeners.forEach((l) => l({ tabId: 'a', kind: 'done' })))
const turns = () => [...pane().querySelectorAll('.page-turn')]
const dock = () => pane().querySelector(':scope > .page-dock') as HTMLElement | null
const pictures = () => [...pane().querySelectorAll('.desk-browser-shot img')] as HTMLImageElement[]
// The size buttons only; Back, Forward and Reload are browser-controls' job.
const labels = (root: Element | null) => [...(root?.querySelectorAll('.page-turn-actions button:not(.page-nav)') || [])].map((b) => (b.textContent || '').trim())
const press = (root: Element | null, label: string) => {
  const b = [...(root?.querySelectorAll('button') || [])].find((x) => (x.textContent || '').trim() === label) as HTMLButtonElement | undefined
  if (!b) throw new Error(`no ${label} button`)
  b.click()
}
/** The user text of the turn that holds this picture. */
function ownerTurnText(el: Element): string {
  let at: Element | null = el
  while (at && at.parentElement && !at.parentElement.matches('.chatpane')) {
    for (let p = at.previousElementSibling; p; p = p.previousElementSibling) {
      const t = (p.textContent || '').trim()
      if (t) return t
    }
    at = at.parentElement
  }
  return ''
}
const watches = (on: boolean) => calls.filter((c) => c.name === 'browser.watch' && c.args[0] === OWNER && c.args[1] === on).length
/** Never two watch(true) without a watch(false) between them. */
function watchesBalanced(): boolean {
  let live = 0
  for (const c of calls) {
    if (c.name !== 'browser.watch' || c.args[0] !== OWNER) continue
    live += c.args[1] ? 1 : -1
    if (live > 1 || live < 0) return false
  }
  return true
}
/** The width the 1100x800 page is drawn at inside this picture (object-fit contain). */
const drawnWidth = (img: HTMLImageElement) => 1100 * Math.min(img.clientWidth / 1100, img.clientHeight / 800)
function spot(el: HTMLImageElement, px: number, py: number) {
  const rect = el.getBoundingClientRect()
  const scale = Math.min(el.clientWidth / 1100, el.clientHeight / 800)
  const left = (el.clientWidth - 1100 * scale) / 2
  const top = (el.clientHeight - 800 * scale) / 2
  const border = Number.parseFloat(getComputedStyle(el).borderLeftWidth) || 0
  const x = left + px * scale
  const y = top + py * scale
  const page = mapClick({ x, y }, { width: el.clientWidth, height: el.clientHeight }, { width: el.naturalWidth, height: el.naturalHeight })!
  // A mouse event carries whole CSS pixels (MouseEventInit truncates), so aim at the nearest one.
  return { clientX: Math.round(rect.left + border + x), clientY: Math.round(rect.top + border + y), page }
}
function mouse(target: EventTarget, type: string, at: { clientX: number; clientY: number }, extra: Record<string, number> = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.clientX, clientY: at.clientY, button: 0, ...extra }))
}
const pointers = (from: number) => calls.slice(from).filter((c) => c.name === 'browser.pointer' && c.args[0] === OWNER).map((c) => c.args[1] as { type: string; x: number; y: number })
const near = (a: number, b: number, d = 2) => Math.abs(a - b) <= d

async function main() {
  createRoot(document.getElementById('root')!).render(<Stage />)
  await until(() => !!document.querySelector('#stage .chatpane.on .composer textarea'), 'chat composer')

  await send('open the site')
  fire()
  await until(() => !!pictures()[0]?.naturalWidth, 'small picture')
  check('1 one picture, in the turn that asked', turns().length === 1 && ownerTurnText(turns()[0]).includes('open the site'), turns()[0] ? ownerTurnText(turns()[0]) : 'none')
  check('1 it starts small', pictures().length === 1 && pictures()[0].className === '', pictures()[0]?.className)
  check('1 the buttons read Hide, Wide, Large', labels(turns()[0]).join(',') === 'Hide,Wide,Large', labels(turns()[0]).join(','))

  press(turns()[0], 'Wide')
  await until(() => !!pictures()[0]?.classList.contains('wide'), 'wide')
  await tick(120)
  check('2 Wide shows the wide picture in the thread', turns().length === 1 && !dock() && !!turns()[0].querySelector('img.wide'))
  check('2 the buttons read Hide, Small, Large', labels(turns()[0]).join(',') === 'Hide,Small,Large', labels(turns()[0]).join(','))
  check('2 going wide starts one watch', watches(true) === 1 && watches(false) === 0, `${watches(true)} ${watches(false)}`)
  const wideDrawn = drawnWidth(pictures()[0])

  press(turns()[0], 'Large')
  await until(() => !!dock(), 'dock')
  await until(() => !!dock()?.querySelector('img.large')?.clientWidth, 'large picture')
  await tick(150)
  const d = dock()!
  const big = pictures()[0]
  check('3 the dock is right before the Skin pane', !!d.nextElementSibling?.matches('.skin-pane'), d.nextElementSibling?.className)
  check('3 one picture in the whole pane (F1)', pictures().length === 1 && turns().length === 1, `${pictures().length} pictures ${turns().length} turns`)
  const paneBox = pane().getBoundingClientRect()
  const ratio = d.getBoundingClientRect().height / paneBox.height
  check('3 the dock is 55% to 65% of the pane height', ratio >= 0.55 && ratio <= 0.65, ratio.toFixed(3))
  check('3 the page is drawn wider than in wide', drawnWidth(big) > wideDrawn, `${drawnWidth(big).toFixed(0)} vs ${wideDrawn.toFixed(0)}`)
  check('3 the buttons read Hide, Small, Wide', labels(d).join(',') === 'Hide,Small,Wide', labels(d).join(','))

  const ds = getComputedStyle(d)
  const padL = Number.parseFloat(ds.paddingLeft)
  const padR = Number.parseFloat(ds.paddingRight)
  const padT = Number.parseFloat(ds.paddingTop)
  const dr = d.getBoundingClientRect()
  const ir = big.getBoundingClientRect()
  const actions = d.querySelector('.page-turn-actions')!.getBoundingClientRect()
  const paneLeft = paneBox.left + pane().clientLeft
  check('3b the dock spans the pane', near(dr.left, paneLeft) && near(dr.right, paneLeft + pane().clientWidth), `${dr.left}-${dr.right} vs ${paneLeft}-${paneLeft + pane().clientWidth}`)
  check('3b the picture is the pane width less the dock padding', near(big.clientWidth, pane().clientWidth - padL - padR), `${big.clientWidth} vs ${pane().clientWidth - padL - padR}`)
  check('3b the picture runs from the dock top to the button row', near(ir.top, dr.top + padT) && near(ir.bottom, actions.top), `${ir.top}/${dr.top + padT} ${ir.bottom}/${actions.top}`)
  const thread = pane().querySelector('.skin-thread') as HTMLElement
  const tr = thread.getBoundingClientRect()
  check('3b the conversation starts at the dock bottom, does not overlap it, and has room', near(tr.top, dr.bottom) && tr.top >= dr.bottom - 0.5 && tr.height >= 150, `${tr.top} vs ${dr.bottom}, height ${tr.height}`)
  for (let i = 0; i < 30; i++) {
    done()
    await send(`line ${i + 1}`, 30)
  }
  done()
  await tick(120)
  thread.scrollTop = 0
  const top0 = thread.scrollTop
  thread.scrollTop = 400
  check('3b with 30 more messages the conversation scrolls under the dock', thread.scrollHeight > thread.clientHeight && thread.scrollTop !== top0 && !!dock(), `${thread.scrollHeight}/${thread.clientHeight} ${top0}->${thread.scrollTop}`)
  const ta = textarea()
  const tar = ta.getBoundingClientRect()
  const hit = document.elementFromPoint(tar.left + tar.width / 2, tar.top + tar.height / 2)
  check('3b the message box is on screen and on top', hit === ta && tar.bottom <= window.innerHeight, `${hit?.tagName}.${(hit as HTMLElement)?.className} bottom ${tar.bottom}/${window.innerHeight}`)

  check('3c one live watch after Large', watches(true) - watches(false) === 1 && watchesBalanced(), `${watches(true)} on ${watches(false)} off`)
  flushSync(() => frameListeners.forEach((l) => l({ owner: OWNER, url: 'https://a.example', src: NEXT })))
  await tick(40)
  check('3c a frame changes the one dock picture', pictures().length === 1 && pictures()[0].getAttribute('src') === `data:image/jpeg;base64,${NEXT}`)

  const shot = d.querySelector('.desk-browser-shot') as HTMLButtonElement
  let n = calls.length
  const at = spot(pictures()[0], 210, 100)
  mouse(pictures()[0], 'mousedown', at, { detail: 1, buttons: 1 })
  mouse(window, 'mouseup', at, { detail: 1 })
  const p1 = pointers(n)
  const down = p1.find((p) => p.type === 'down')
  const up = p1.find((p) => p.type === 'up')
  check('4 a click on the large picture lands on page point 210,100 (F4)', !!down && !!up && near(down.x, 210, 1) && near(down.y, 100, 1) && near(up.x, 210, 1) && near(up.y, 100, 1), JSON.stringify(p1))
  n = calls.length
  const pr = pictures()[0].getBoundingClientRect()
  mouse(pictures()[0], 'mousedown', at, { detail: 1, buttons: 1 })
  mouse(window, 'mouseup', { clientX: pr.right + 200, clientY: at.clientY }, { detail: 1 })
  const dragUp = pointers(n).find((p) => p.type === 'up')
  check('4 a drag released past the right edge ends on x 1100', dragUp?.x === 1100, JSON.stringify(dragUp))
  n = calls.length
  shot.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
  const wheel = calls.slice(n).find((c) => c.name === 'browser.wheel')
  check('4b the wheel on the large picture scrolls the page', !!wheel && wheel.args[0] === OWNER && wheel.args[1] === 120, JSON.stringify(wheel?.args))

  n = calls.length
  shot.focus()
  shot.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
  const keyed = calls.slice(n).filter((c) => c.name === 'browser.key')
  check('5 a key on the focused picture goes to the page', keyed.length === 1 && keyed[0].args[0] === OWNER, JSON.stringify(keyed.map((k) => k.args)))
  n = calls.length
  const box = textarea()
  box.focus()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true, cancelable: true }))
  flushSync(() => typeInto(box, 'b'))
  check('5 a key in the message box stays there (F5)', calls.slice(n).every((c) => c.name !== 'browser.key') && box.value === 'b', `${box.value} ${calls.slice(n).map((c) => c.name)}`)
  flushSync(() => typeInto(box, ''))

  done()
  await send('next one')
  fire()
  await tick(150)
  check('6 a new turn that opens a page keeps Large (F7)', !!dock() && pictures().length === 1 && !pane().querySelector('.skin-thread .page-turn'))

  const offBefore = watches(false)
  press(dock(), 'Small')
  await tick(150)
  check('7 Small takes the dock away', !dock())
  check('7 the small picture is back under the newest asking message (F6)', turns().length === 1 && ownerTurnText(turns()[0]).includes('next one') && pictures()[0]?.className === '', turns()[0] ? ownerTurnText(turns()[0]) : 'none')
  check('7 leaving Large stops the watch', watches(false) > offBefore && watches(true) === watches(false), `${watches(true)} ${watches(false)}`)

  press(turns()[0], 'Large')
  await until(() => !!dock(), 'dock again')
  press(dock(), 'Hide')
  await tick(150)
  const noteTurn = turns()[0]
  check('7b Hide from Large takes the dock away and leaves the note in its turn', !dock() && !!noteTurn?.querySelector('.desk-browser-note') && ownerTurnText(noteTurn).includes('next one'))
  check('7b the note shows no size buttons', labels(noteTurn).length === 0, labels(noteTurn).join(','))
  ;(noteTurn.querySelector('.desk-browser-note') as HTMLButtonElement).click()
  await tick(150)
  check('7b the note click gives small with Hide, Wide, Large', pictures()[0]?.className === '' && labels(turns()[0]).join(',') === 'Hide,Wide,Large', labels(turns()[0]).join(','))

  press(turns()[0], 'Wide')
  await tick(100)
  done()
  await send('third')
  fire()
  await tick(150)
  check('8 a new turn keeps Wide, under the new message', turns().length === 1 && ownerTurnText(turns()[0]).includes('third') && !!turns()[0].querySelector('img.wide'), turns()[0] ? ownerTurnText(turns()[0]) : 'none')
  press(turns()[0], 'Hide')
  await tick(100)
  check('8 Hide from Wide gives the note with no size buttons', !!turns()[0].querySelector('.desk-browser-note') && labels(turns()[0]).length === 0)
  ;(turns()[0].querySelector('.desk-browser-note') as HTMLButtonElement).click()
  await tick(100)
  check('8 the note click gives small with Hide, Wide, Large', labels(turns()[0]).join(',') === 'Hide,Wide,Large', labels(turns()[0]).join(','))

  press(turns()[0], 'Large')
  await until(() => !!dock(), 'dock before switching')
  flushSync(() => showTab('b'))
  await tick(150)
  const visibleDocks = [...document.querySelectorAll('.page-dock')].filter((el) => el.getClientRects().length > 0)
  check('9 another tab shows no dock (F9)', visibleDocks.length === 0 && !pane().querySelector('.page-dock'), String(visibleDocks.length))
  flushSync(() => showTab('a'))
  await tick(150)
  check('9 back on the tab, its dock is there', !!dock())

  press(dock(), 'Small')
  await tick(100)
  signIn = true
  await until(() => (pane().textContent || '').includes('Sign in, in the browser.'), 'sign-in text', 4000)
  check('10 a sign-in shows Open browser and Large', labels(turns()[0]).join(',') === 'Open browser,Large', labels(turns()[0]).join(','))
  press(turns()[0], 'Open browser')
  await tick(150)
  check('10 Open browser gives wide', !!turns()[0]?.querySelector('img.wide'))
  signIn = false
  await until(() => !(pane().textContent || '').includes('Sign in, in the browser.'), 'sign-in gone', 4000)

  const end = /end=(small|wide|large)/.exec(location.hash)?.[1] || 'large'
  const holder = dock() ?? turns()[0]
  if (end === 'small' && labels(holder).includes('Small')) press(holder, 'Small')
  if (end === 'wide' && labels(holder).includes('Wide')) press(holder, 'Wide')
  if (end === 'large' && labels(holder).includes('Large')) press(holder, 'Large')
  await tick(150)

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
