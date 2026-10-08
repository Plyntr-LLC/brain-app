import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'

const chatListeners: ((e: unknown) => void)[] = []
const openedListeners: ((owner: string) => void)[] = []

function jpeg(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 800
  const g = canvas.getContext('2d')!
  g.fillStyle = '#f4f1ea'
  g.fillRect(0, 0, 1100, 800)
  g.fillStyle = '#223'
  g.fillRect(80, 80, 400, 60)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return url.slice(url.indexOf(',') + 1)
}

/** Any bridge call the page does not name resolves to an empty answer. */
function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name === 'chat.onEvent') {
      chatListeners.push(args[0] as (e: unknown) => void)
      return () => undefined
    }
    if (name === 'browser.onOpened') {
      openedListeners.push(args[0] as (owner: string) => void)
      return () => undefined
    }
    if (name === 'browser.face') return Promise.resolve({ src: jpeg(), signIn: false })
    if (/\.on[A-Z]/.test(name)) return () => undefined
    if (name === 'chat.send') return Promise.resolve({ ok: true })
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
    <div id={id} className="stage-pane">
      <ChatPane
        id={id}
        kind="grok"
        cwd="/Users/joe/Projects/agency-brain"
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
async function send(id: string, text: string) {
  const box = document.querySelector<HTMLTextAreaElement>(`#${id} .composer textarea`)
  if (!box) throw new Error(`no composer in ${id}`)
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(200)
  const sent = [...document.querySelectorAll(`#${id} *`)].some((el) => el.children.length === 0 && (el.textContent || '').trim() === text)
  if (!sent) throw new Error(`"${text}" did not show in ${id}`)
}
const fire = (owner: string) => flushSync(() => openedListeners.forEach((l) => l(owner)))
const done = (id: string) => flushSync(() => chatListeners.forEach((l) => l({ tabId: id, kind: 'done' })))
const turns = (id: string) => [...document.querySelectorAll(`#${id} .page-turn`)]
/** The user text of the turn that holds this page picture. */
function ownerTurnText(el: Element): string {
  let at: Element | null = el
  while (at && at.parentElement && !at.parentElement.matches(`.stage-pane`)) {
    const prev: Element | null = at.previousElementSibling
    for (let p = prev; p; p = p.previousElementSibling) {
      const t = (p.textContent || '').trim()
      if (t) return t
    }
    at = at.parentElement
  }
  return ''
}

async function main() {
  const layout = document.createElement('style')
  layout.textContent = '.stage-row{display:grid;grid-template-columns:540px 540px;height:900px}.stage-pane{position:relative;overflow:hidden;display:flex;flex-direction:column;border:1px solid #ccc}'
  document.head.appendChild(layout)
  createRoot(document.getElementById('root')!).render(
    <div className="stage-row">
      {pane('chat-a')}
      {pane('chat-b')}
    </div>
  )
  await tick(200)
  check('both chats listen for browser:opened', openedListeners.length >= 2, String(openedListeners.length))

  let threw = ''
  try {
    fire('chat:chat-a')
  } catch (e) {
    threw = String(e)
  }
  await tick()
  check('an opened event before any message does not throw and shows no picture', !threw && turns('chat-a').length === 0, threw || String(turns('chat-a').length))

  await send('chat-a', 'check the site')
  fire('chat:chat-a')
  await tick(200)
  const first = turns('chat-a')
  check('after a send, the opened event shows one picture in that chat', first.length === 1, String(first.length))
  check('the picture sits in the turn of the message that asked', first.length === 1 && ownerTurnText(first[0]).includes('check the site'), first[0] ? ownerTurnText(first[0]) : 'none')
  check('the picture is the real thread picture with an image', !!first[0]?.querySelector('img'), first[0]?.innerHTML.slice(0, 120) || 'none')

  fire('chat:chat-a')
  await tick(120)
  const again = turns('chat-a')
  check('a second event in the same turn leaves the one picture where it was', again.length === 1 && again[0] === first[0], String(again.length))

  fire('chat:chat-b')
  await tick(120)
  check('another chat\'s event changes nothing here, and that chat (no message) shows none', turns('chat-a').length === 1 && turns('chat-a')[0] === first[0] && turns('chat-b').length === 0, `${turns('chat-a').length} ${turns('chat-b').length}`)

  const hide = [...(first[0]?.querySelectorAll('button') || [])].find((b) => (b.textContent || '').trim() === 'Hide') as HTMLButtonElement | undefined
  hide?.click()
  await tick(120)
  fire('chat:chat-a')
  await tick(120)
  const note = document.querySelector('#chat-a .desk-browser-note')
  check('after Hide, another event in the same turn keeps the note', !!hide && !!note && !document.querySelector('#chat-a .page-turn img'), `${!!hide} ${!!note}`)

  done('chat-a')
  await tick(120)
  await send('chat-a', 'now the second page')
  fire('chat:chat-a')
  await tick(200)
  const moved = turns('chat-a')
  check('a new message and a new event move the one picture under the new message, shown again', moved.length === 1 && ownerTurnText(moved[0]).includes('now the second page') && !!moved[0].querySelector('img'), moved[0] ? ownerTurnText(moved[0]) : String(moved.length))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
