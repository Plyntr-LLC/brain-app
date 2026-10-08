import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DeskMessage } from '../../src/shared/desk'
import { pageAfterSend } from '../../src/shared/page-picture'
import { ChatPageTurn } from '../../src/renderer/src/ChatPageTurn'
import { DeskCard } from '../../src/renderer/src/DeskCard'
import { usePageFollow } from '../../src/renderer/src/pin-thread'

// One mount: a Desk browse card and a chat turn share one jpeg. The page is not navigated here.
// node --experimental-strip-types scripts/render-ui.ts shared-browser

type Call = { fn: string; args: unknown[] }
type Mode = 'small' | 'wide' | 'note'

const calls: Call[] = []
const results: { name: string; ok: boolean; detail?: string }[] = []
const record = (fn: string, ...args: unknown[]) => {
  calls.push({ fn, args })
}
const since = (n: number) => calls.slice(n)
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, ...(detail ? { detail } : {}) })
}

function button(root: ParentNode | null | undefined, label: string): HTMLButtonElement | undefined {
  return [...(root?.querySelectorAll('button') || [])].find((el) => (el.textContent || '').trim() === label) as HTMLButtonElement | undefined
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

function until(fn: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (fn()) resolve()
      else if (Date.now() - start > 4000) reject(new Error('timed out'))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

function jpegBytes(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')
  if (!g) throw new Error('no canvas')
  g.fillStyle = '#f4f1ea'
  g.fillRect(0, 0, 1100, 800)
  g.fillStyle = '#222'
  g.fillRect(40, 40, 240, 80)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}

function clickPoint(img: HTMLImageElement, x: number, y: number) {
  const rect = img.getBoundingClientRect()
  const style = getComputedStyle(img)
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0
  img.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + borderLeft + x,
      clientY: rect.top + borderTop + y,
      button: 0
    })
  )
}

function key(el: Element, name: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

const names = { me: 'You', writer: 'Writer' }
const browseMsg: DeskMessage = {
  id: 'm_browse',
  ts: '2026-10-08T09:20:00.000Z',
  from: 'writer',
  to: 'me',
  kind: 'browse',
  text: 'Opened the example page.',
  browse: {
    steps: [{ action: 'url', detail: 'https://example.com', url: 'https://example.com' }],
    title: 'Example',
    windowOpen: true
  }
}
const signMsg: DeskMessage = {
  id: 'm_sign',
  ts: '2026-10-08T09:21:00.000Z',
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

function cardProps(onOpenBrowser: DeskCard extends never ? never : (opts?: { signIn?: boolean }) => void) {
  const noop = () => {}
  return {
    names,
    busy: false,
    onOpenFile: noop,
    onHoldAnswer: noop,
    onSend: noop,
    onRetry: noop,
    onKeepWaiting: noop,
    onStop: noop,
    onContinueJob: noop,
    onStopJob: noop,
    onTalk: noop,
    onOpenLog: noop,
    onOpenMemory: noop,
    onOpenBrowser,
    onRemoveHire: noop
  }
}

function PageThread(props: {
  src: string
  mode: Mode
  pinned: boolean
  mark: string
  onToggle: () => void
  onHide: () => void
  onShow: () => void
  onClickAt: (x: number, y: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: string) => void
  onWheel: (deltaY: number) => void
  onShowWindow: () => void
  composer?: string
  onComposer?: (value: string) => void
  webview?: boolean
}) {
  const thread = useRef<HTMLDivElement>(null)
  const pin = useRef(props.pinned)
  pin.current = props.pinned
  usePageFollow(thread, pin, `${props.mode}:${props.src}`)
  return (
    <div className={`workspace ${props.mark}`} style={{ height: 520, width: 720 }}>
      <div className="stage" style={{ height: 520 }}>
        <div className="chatpane on">
          <div className="skin-pane">
            <div className="skin-thread" ref={thread}>
              <div style={{ height: 700, flex: 'none' }} />
              <div className="skin-user-turn" style={{ flex: 'none' }}>
                <div className="bubble me">https://example.com</div>
                <ChatPageTurn
                  mode={props.mode}
                  src={props.src}
                  signIn={false}
                  onToggle={props.onToggle}
                  onHide={props.onHide}
                  onShow={props.onShow}
                  onClickAt={props.onClickAt}
                  onTypeText={props.onTypeText}
                  onPressKey={props.onPressKey}
                  onWheel={props.onWheel}
                  onShowWindow={props.onShowWindow}
                />
              </div>
            </div>
          </div>
          {props.onComposer ? (
            <textarea style={{ flex: 'none', height: 32 }} value={props.composer} onChange={(e) => props.onComposer?.(e.target.value)} />
          ) : null}
          {props.webview ? <webview className="fileweb" style={{ flex: 'none', height: 0, minHeight: 0 }} /> : null}
        </div>
      </div>
    </div>
  )
}

function Stage(props: { src: string }) {
  const [deskMode, setDeskMode] = useState<Mode>('small')
  const [chatMode, setChatMode] = useState<Mode>('small')
  const [looseMode, setLooseMode] = useState<Mode>('small')
  const [composer, setComposer] = useState('')

  function sendWire(wire: string) {
    record('chat.send', wire)
    const opened = pageAfterSend(wire, Date.now())
    if (!opened) return
    setChatMode(opened.view)
  }

  return (
    <>
      <div className="desk-mount">
        <DeskCard
          msg={browseMsg}
          picture={{ mode: deskMode, src: props.src }}
          onPictureToggle={() => setDeskMode((m) => (m === 'small' ? 'wide' : m))}
          onPictureHide={() => setDeskMode('note')}
          onPictureShow={() => setDeskMode('small')}
          onPictureClick={(x, y) => record('clickAt', x, y)}
          onPictureType={(text) => record('typeText', text)}
          onPicturePress={(keyName) => record('pressKey', keyName)}
          onPictureWheel={(deltaY) => record('wheel', deltaY)}
          {...cardProps(() => setDeskMode((m) => (m === 'note' ? 'small' : 'wide')))}
        />
        <div className="desk-signin">
          <DeskCard
            msg={signMsg}
            {...cardProps((opts) => {
              if (opts?.signIn) record('showWindow', 'desk')
            })}
          />
        </div>
      </div>
      <PageThread
        mark="chat-live"
        src={props.src}
        mode={chatMode}
        pinned
        onToggle={() => setChatMode((m) => (m === 'small' ? 'wide' : m))}
        onHide={() => setChatMode('note')}
        onShow={() => setChatMode('small')}
        onClickAt={(x, y) => record('clickAt', x, y)}
        onTypeText={(text) => record('typeText', text)}
        onPressKey={(keyName) => record('pressKey', keyName)}
        onWheel={(deltaY) => record('wheel', deltaY)}
        onShowWindow={() => record('showWindow', 'chat-live')}
        composer={composer}
        onComposer={setComposer}
        webview
      />
      <PageThread
        mark="chat-unpinned"
        src={props.src}
        mode={looseMode}
        pinned={false}
        onToggle={() => setLooseMode('wide')}
        onHide={() => {}}
        onShow={() => {}}
        onClickAt={() => {}}
        onTypeText={() => {}}
        onPressKey={() => {}}
        onWheel={() => {}}
        onShowWindow={() => {}}
      />
      <button type="button" onClick={() => setLooseMode('wide')}>
        Widen unpinned
      </button>
      <div className="chat-signin">
        <ChatPageTurn
          mode="small"
          src={null}
          signIn
          onToggle={() => {}}
          onHide={() => {}}
          onShow={() => {}}
          onClickAt={() => {}}
          onTypeText={() => {}}
          onPressKey={() => {}}
          onWheel={() => {}}
          onShowWindow={() => record('showWindow', 'chat')}
        />
        <button type="button" onClick={() => sendWire('hello')}>
          Send hello
        </button>
        <button type="button" onClick={() => sendWire('https://example.com')}>
          Send address
        </button>
      </div>
    </>
  )
}

function deskCard(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.desk-mount > .fcard')].find((el) => !!el.querySelector('.desk-browser-shot, .desk-browser-note'))
}

function chatImg(): HTMLImageElement | null {
  return document.querySelector('.chat-live img')
}

function deskImg(): HTMLImageElement | null {
  return deskCard()?.querySelector('img') || null
}

function size(el: Element | null): string {
  if (!el) return 'missing'
  const r = el.getBoundingClientRect()
  return `${Math.round(r.width)}x${Math.round(r.height)}`
}

async function main() {
  const src = jpegBytes()
  createRoot(document.getElementById('root')!).render(<Stage src={src} />)
  await until(() => {
    const img = chatImg()
    return !!img && img.naturalWidth === 1100 && img.naturalHeight === 800 && !!deskImg()
  })
  const expectSrc = `data:image/jpeg;base64,${src}`
  check(
    'both pictures start small on the same jpeg',
    size(chatImg()) === '240x150' && size(deskImg()) === '240x150' && chatImg()?.getAttribute('src') === expectSrc && deskImg()?.getAttribute('src') === expectSrc,
    `${size(chatImg())} ${size(deskImg())}`
  )

  let before = calls.length
  chatImg()?.click()
  await until(() => chatImg()?.classList.contains('wide') === true && size(deskImg()) === '240x150')
  check(
    'a small click only enlarges, and the desk picture stays 240x150',
    chatImg()?.classList.contains('wide') === true && size(deskImg()) === '240x150' && !since(before).some((c) => c.fn === 'clickAt' || c.fn === 'showWindow'),
    `${size(chatImg())} ${size(deskImg())}`
  )

  const wide = chatImg()!
  wide.style.boxSizing = 'content-box'
  wide.style.width = '320px'
  wide.style.height = '320px'
  await until(() => wide.clientWidth === 320 && wide.clientHeight === 320)
  const placed = wide.getBoundingClientRect()
  wide.style.transform = `translate(${Math.round(placed.left) - placed.left}px, ${Math.round(placed.top) - placed.top}px)`
  check('the wide picture content box is 320 and the page is 1100x800', wide.clientWidth === 320 && wide.clientHeight === 320 && wide.naturalWidth === 1100 && wide.naturalHeight === 800, `${wide.clientWidth}x${wide.clientHeight} natural ${wide.naturalWidth}x${wide.naturalHeight}`)

  before = calls.length
  clickPoint(wide, 160, 10)
  check(
    'a click in the empty band does not reach the page',
    !since(before).some((c) => c.fn === 'clickAt' || c.fn === 'showWindow') && wide.classList.contains('wide'),
    since(before).map((c) => c.fn).join(',')
  )

  before = calls.length
  clickPoint(wide, 160, 50)
  const hit = since(before).find((c) => c.fn === 'clickAt')
  check(
    'a click on the page pixels is (550, 22) and the picture stays wide',
    hit?.args[0] === 550 && hit?.args[1] === 22 && wide.classList.contains('wide') && !since(before).some((c) => c.fn === 'showWindow'),
    JSON.stringify(hit?.args)
  )
  check('that click focuses the picture', document.activeElement === wide.closest('button'), document.activeElement?.className || 'none')

  const shot = wide.closest('button')!
  before = calls.length
  key(shot, 'Enter')
  key(shot, 'Backspace')
  key(shot, 'ArrowDown')
  key(shot, 'a')
  const skinThread = document.querySelector<HTMLElement>('.chat-live .skin-thread')!
  const scrollBefore = skinThread.scrollTop
  const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
  shot.dispatchEvent(wheel)
  const pressed = since(before).filter((c) => c.fn === 'pressKey').map((c) => c.args[0])
  const typed = since(before).filter((c) => c.fn === 'typeText').map((c) => c.args[0])
  const wheeled = since(before).filter((c) => c.fn === 'wheel').map((c) => c.args[0])
  const box = document.querySelector<HTMLTextAreaElement>('.chat-live textarea')
  check('Enter, Backspace, and ArrowDown reach the page', JSON.stringify(pressed) === JSON.stringify(['Enter', 'Backspace', 'ArrowDown']), JSON.stringify(pressed))
  check('typing a reaches the page and the composer stays empty', JSON.stringify(typed) === JSON.stringify(['a']) && box?.value === '', JSON.stringify(typed) + ' composer ' + JSON.stringify(box?.value))
  check(
    'the wheel scrolls the page by its delta and does not scroll the thread',
    wheel.defaultPrevented === true && JSON.stringify(wheeled) === JSON.stringify([120]) && skinThread.scrollTop === scrollBefore,
    `prevented ${wheel.defaultPrevented} delta ${JSON.stringify(wheeled)} scroll ${scrollBefore}->${skinThread.scrollTop}`
  )

  before = calls.length
  clickPoint(wide, 160, 160)
  const center = since(before).find((c) => c.fn === 'clickAt')
  check('the center click is (550, 400) and the picture stays wide', center?.args[0] === 550 && center?.args[1] === 400 && wide.classList.contains('wide'), JSON.stringify(center?.args))

  const chatTurn = document.querySelector('.chat-live .skin-user-turn')
  const stage = document.querySelector('.chat-live .stage')
  const workspace = document.querySelector('.chat-live.workspace')
  const pageTurn = document.querySelector('.chat-live .thread.page-turn')
  const wideBox = wide.getBoundingClientRect()
  const threadBox = skinThread.getBoundingClientRect()
  check(
    'the wide picture sits in the skin thread, fully visible, at most 420 tall',
    !!workspace?.contains(wide) &&
      !!stage?.contains(wide) &&
      skinThread.contains(wide) &&
      !!pageTurn?.contains(wide) &&
      !!chatTurn?.contains(wide) &&
      fullyVisible(wide) &&
      boxInside(wideBox, threadBox) &&
      wideBox.height > 150 &&
      wideBox.height <= 420 &&
      wide.getAttribute('src') === expectSrc,
    `${Math.round(wideBox.height)} thread ${Math.round(threadBox.height)} top ${Math.round(wideBox.top - threadBox.top)}`
  )
  const looseThread = document.querySelector<HTMLElement>('.chat-unpinned .skin-thread')!
  const looseBefore = looseThread.scrollTop
  button(document.body, 'Widen unpinned')?.click()
  await until(() => document.querySelector('.chat-unpinned img')?.classList.contains('wide') === true)
  const looseImg = document.querySelector('.chat-unpinned img')!
  const looseBox = looseImg.getBoundingClientRect()
  const looseThreadBox = looseThread.getBoundingClientRect()
  check(
    'an unpinned thread leaves the wide picture below the fold',
    looseThread.scrollTop === looseBefore && looseBox.top >= looseThreadBox.bottom - 1,
    `scroll ${looseThread.scrollTop} imgTop ${Math.round(looseBox.top)} threadBottom ${Math.round(looseThreadBox.bottom)}`
  )
  check('the desk picture is in the browse card and outside the card body', !!deskCard()?.contains(deskImg()!) && !deskImg()?.closest('.fcard-body') && size(deskImg()) === '240x150', size(deskImg()))
  check('an html file still has its webview', !!document.querySelector('.chatpane webview.fileweb'))

  before = calls.length
  button(pageTurn, 'Hide')?.click()
  await until(() => !!pageTurn?.querySelector('.desk-browser-note') && !chatImg())
  check(
    'hiding the chat leaves the desk picture at 240x150',
    pageTurn?.querySelector('.desk-browser-note')?.textContent === 'There were browsers.' && size(deskImg()) === '240x150' && !since(before).some((c) => c.fn === 'showWindow'),
    size(deskImg())
  )
  before = calls.length
  button(pageTurn, 'There were browsers.')?.click()
  await until(() => size(chatImg()) === '240x150')
  check('the chat note restores only the chat picture and does not bring the window forward', size(chatImg()) === '240x150' && size(deskImg()) === '240x150' && !since(before).some((c) => c.fn === 'showWindow'), `${size(chatImg())} ${size(deskImg())}`)

  chatImg()?.click()
  await until(() => chatImg()?.classList.contains('wide') === true)
  const chatWide = size(chatImg())
  before = calls.length
  button(deskCard(), 'Hide')?.click()
  await until(() => deskCard()?.querySelector('.desk-browser-note')?.textContent === 'There were browsers.')
  check('hiding the desk card leaves the chat picture at its size', size(chatImg()) === chatWide && !chatImg()?.closest('.desk-mount') && !since(before).some((c) => c.fn === 'showWindow'), `${size(chatImg())} was ${chatWide}`)
  before = calls.length
  button(deskCard(), 'There were browsers.')?.click()
  await until(() => size(deskImg()) === '240x150')
  check('the desk note restores only the desk picture and does not bring the window forward', size(deskImg()) === '240x150' && size(chatImg()) === chatWide && !since(before).some((c) => c.fn === 'showWindow'), `${size(deskImg())} ${size(chatImg())}`)

  before = calls.length
  button(document.querySelector('.desk-signin'), 'Open browser')?.click()
  button(document.querySelector('.chat-signin'), 'Open browser')?.click()
  const shown = since(before).filter((c) => c.fn === 'showWindow').map((c) => c.args[0])
  check('desk sign-in and chat sign-in both bring the window forward', JSON.stringify(shown) === JSON.stringify(['desk', 'chat']), JSON.stringify(shown))
  check('the chat sign-in sentence is there and has no picture', document.querySelector('.chat-signin p')?.textContent === 'Sign in, in the browser.' && !document.querySelector('.chat-signin img'))

  before = calls.length
  button(document.body, 'Send hello')?.click()
  await new Promise((r) => setTimeout(r, 40))
  check('hello leaves the wide chat picture', chatImg()?.classList.contains('wide') === true && since(before).some((c) => c.fn === 'chat.send' && c.args[0] === 'hello'), size(chatImg()))
  before = calls.length
  button(document.body, 'Send address')?.click()
  await until(() => size(chatImg()) === '240x150' && chatImg()?.classList.contains('wide') !== true)
  check('a later address shows the small picture again', size(chatImg()) === '240x150' && since(before).some((c) => c.fn === 'chat.send' && c.args[0] === 'https://example.com'), size(chatImg()))
  chatImg()?.click()
  await until(() => chatImg()?.classList.contains('wide') === true && (chatImg()?.getBoundingClientRect().height || 0) > 150)
  const again = chatImg()!.getBoundingClientRect()
  check('a click widens that picture again', chatImg()?.classList.contains('wide') === true && again.height > 150 && again.height <= 420, size(chatImg()))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String(e && (e as Error).stack ? (e as Error).stack : e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
