import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { DeskCli } from '../../src/shared/desk'
import { openSharedPage } from '../../src/main/shared-browser'
import { registerBrowserIpc } from '../../src/main/browser-ipc'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { DeskPane } from '../../src/renderer/src/DeskPane'
import '../../src/preload/index'

// Two real chats and the real Desk pane. Clicks go through the preload into one fake Chrome.
// node --experimental-strip-types scripts/render-ui.ts shared-browser

class Buf {
  static from(bytes: Uint8Array) {
    return {
      toString(enc?: string) {
        if (enc !== 'base64') return ''
        let s = ''
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
        return btoa(s)
      }
    }
  }
}
;(globalThis as unknown as { Buffer: typeof Buf }).Buffer = Buf

registerBrowserIpc()

type Call = { fn: string; args: unknown[] }
const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, ...(detail ? { detail } : {}) })
}

const messages = [
  {
    id: 'm_browse',
    ts: '2026-10-08T09:20:00.000Z',
    from: 'writer',
    to: 'me',
    kind: 'browse' as const,
    text: 'Opened the example page.',
    browse: {
      steps: [{ action: 'url', detail: 'https://w.example', url: 'https://w.example' }],
      title: 'Example',
      windowOpen: true
    }
  },
  {
    id: 'm_sign',
    ts: '2026-10-08T09:21:00.000Z',
    from: 'writer',
    to: 'me',
    kind: 'browse' as const,
    text: 'Writer needs you to sign in, in the desk browser.',
    browse: {
      steps: [{ action: 'url', detail: 'https://w.example/login', url: 'https://w.example/login' }],
      signIn: true,
      windowOpen: true
    }
  }
]

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name === 'chat.send') {
      const payload = args[0] as { text?: string; tabId?: string }
      return openSharedPage(String(payload?.text || ''), `chat:${String(payload?.tabId || '')}`)
    }
    if (name === 'slash.list') return Promise.resolve({ commands: [], models: [] })
    if (name === 'ai.detect') return Promise.resolve({ grok: true, claude: false, gpt: false, cursor: false })
    if (name === 'desk.attach') return Promise.resolve({ brain: '/fx/desk' })
    if (name === 'desk.welcome') {
      return Promise.resolve({
        greetingName: 'Joe',
        greeting: 'Desk is here.',
        starters: [],
        readiness: [],
        composerDisabled: false,
        composerPlaceholder: 'Message Conductor',
        everyoneLine: null
      })
    }
    if (name === 'desk.list') {
      return Promise.resolve({
        bots: [{ id: 'writer', name: 'Writer', cli: 'grok', model: 'default', effort: 'low', description: 'Writes.', file: '/fx/writer.md' }],
        states: [{ id: 'writer', state: 'idle' }],
        removedNames: {}
      })
    }
    if (name === 'desk.view') return Promise.resolve(messages)
    if (name === 'desk.picture') {
      const canvas = document.createElement('canvas')
      canvas.width = 1100
      canvas.height = 800
      const g = canvas.getContext('2d')
      if (!g) return Promise.resolve(null)
      g.fillStyle = '#f4f1ea'
      g.fillRect(0, 0, 1100, 800)
      const url = canvas.toDataURL('image/jpeg', 0.8)
      return Promise.resolve(url.slice(url.indexOf(',') + 1))
    }
    if (/\.on[A-Z]/.test(name)) return () => undefined
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}

const realBrowser = window.brain.browser
window.brain = new Proxy(bridge([]) as { browser: typeof realBrowser }, {
  get(target, key) {
    if (key === 'browser') return realBrowser
    return (target as unknown as Record<string, unknown>)[key as string]
  }
}) as typeof window.brain

function button(root: ParentNode | null | undefined, label: string): HTMLButtonElement | undefined {
  return [...(root?.querySelectorAll('button') || [])].find((el) => (el.textContent || '').trim() === label) as HTMLButtonElement | undefined
}

let stage = 'start'
function until(fn: () => boolean, label: string, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (fn()) resolve()
      else if (Date.now() - start > ms) {
        const imgs = [...document.querySelectorAll('img')].map((el) => {
          const img = el as HTMLImageElement
          return `${img.naturalWidth}x${img.naturalHeight} ${img.className} ${(img.getAttribute('src') || '').slice(0, 24)}`
        })
        const fakeNow = (globalThis as unknown as { __browserFake?: { launches?: unknown[]; pages?: Array<{ _url: string; _closed: boolean; windowState: string; viewport: unknown }>; actions?: string[] } }).__browserFake
        reject(new Error([
          label,
          `stage ${stage}`,
          `textareas chat-a=${document.querySelectorAll('#chat-a textarea').length} chat-b=${document.querySelectorAll('#chat-b textarea').length} desk=${document.querySelectorAll('#desk textarea').length}`,
          `imgs ${imgs.join(' | ') || 'none'}`,
          `turns ${document.querySelectorAll('.page-turn').length}`,
          `launches ${fakeNow?.launches?.length ?? 'no-fake'}`,
          `pages ${(fakeNow?.pages || []).map((p) => `${p._url} closed=${p._closed} ${p.windowState} ${JSON.stringify(p.viewport)}`).join(' ; ') || 'none'}`,
          `actions ${(fakeNow?.actions || []).slice(-8).join(' | ') || 'none'}`
        ].join('\n')))
      }
      else setTimeout(tick, 20)
    }
    tick()
  })
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function sendLine(root: ParentNode, text: string) {
  const box = root.querySelector('.composer textarea')
  if (!box) throw new Error('no composer')
  box.focus()
  flushSync(() => typeInto(box, text))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
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

function size(el: Element | null): string {
  if (!el) return 'missing'
  const r = el.getBoundingClientRect()
  return `${Math.round(r.width)}x${Math.round(r.height)}`
}

type Fake = { actions: string[]; pages: Array<{ windowId: number; _url: string; _closed: boolean }>; title?: string }
const fake = () => (globalThis as unknown as { __browserFake: Fake }).__browserFake
const ipcLog = () => ((globalThis as unknown as { __ipcLog?: unknown[][] }).__ipcLog || [])
const showed = () => ipcLog().some((row) => row[0] === 'browser:showWindow')

const noop = () => undefined
function chatProps(id: string) {
  return {
    id,
    kind: 'grok' as const,
    cwd: '/tmp/brain',
    sessionId: `s-${id}`,
    active: true,
    greeting: 'Hi.',
    onFiles: noop,
    onNew: noop,
    onModel: noop,
    onEffort: noop,
    onCaps: noop,
    onTranscript: noop,
    onContext: noop,
    onApprove: noop,
    onRename: noop,
    onResume: noop,
    onFork: noop,
    onAgentMode: noop,
    onDelete: noop,
    onOpenTerm: noop,
    onBusy: noop,
    onActivity: noop
  }
}

function Stage() {
  const [rail, setRail] = useState<HTMLElement | null>(null)
  return (
    <>
      <div id="chat-a" style={{ width: 900, height: 640 }}>
        <ChatPane {...chatProps('chat-a')} />
      </div>
      <div id="chat-b" style={{ width: 900, height: 640 }}>
        <ChatPane {...chatProps('chat-b')} />
      </div>
      <div id="desk" style={{ width: 900, height: 640 }}>
        <div className="stage-row" style={{ display: 'grid', gridTemplateColumns: '640px 240px', height: 640 }}>
          <div className="stage-pane" style={{ position: 'relative', overflow: 'hidden' }}>
            {rail ? (
              <DeskPane
                id="desk-1"
                cwd="/fx/desk"
                active
                rail={rail}
                closing={false}
                onClosed={noop}
                onKeep={noop}
                onOpenFile={noop}
                modelsFor={(_cli: DeskCli, list?: { id: string; label: string }[]) => (list && list.length ? list : [{ id: 'default', label: 'Default' }])}
                effortsFor={() => []}
              />
            ) : null}
          </div>
          <aside className="refs stage-rail" ref={setRail} />
        </div>
      </div>
    </>
  )
}

function laid(img: HTMLImageElement): boolean {
  const rect = img.getBoundingClientRect()
  return img.clientWidth === 640 && img.clientHeight === 320 && rect.left === Math.round(rect.left) && rect.top === Math.round(rect.top)
}

function lay(img: HTMLImageElement) {
  img.style.boxSizing = 'content-box'
  img.style.width = '640px'
  img.style.height = '320px'
  img.style.transform = ''
  const rect = img.getBoundingClientRect()
  const dx = rect.left - Math.round(rect.left)
  const dy = rect.top - Math.round(rect.top)
  if (dx || dy) img.style.transform = `translate(${-dx}px, ${-dy}px)`
}

async function main() {
  stage = 'open writer'
  await openSharedPage('https://w.example', 'desk:writer')
  stage = 'render'
  createRoot(document.getElementById('root')!).render(<Stage />)
  stage = 'wait composers'
  await until(() => !!document.querySelector('#chat-a textarea') && !!document.querySelector('#chat-b textarea') && !!document.querySelector('#desk textarea'), 'composers')
  stage = 'send chats'
  sendLine(document.querySelector('#chat-a')!, 'https://a.example')
  sendLine(document.querySelector('#chat-b')!, 'https://b.example')
  const img = (id: string) => document.querySelector(`#${id} img`) as HTMLImageElement | null
  stage = 'wait pictures'
  await until(() => img('chat-a')?.naturalWidth === 1100 && img('chat-b')?.naturalWidth === 1100 && !!document.querySelector('#desk img'), 'pictures')
  check('both chats start small', size(img('chat-a')) === '240x150' && size(img('chat-b')) === '240x150', `${size(img('chat-a'))} ${size(img('chat-b'))}`)
  const actionsBefore = fake().actions.length
  img('chat-a')?.click()
  await until(() => img('chat-a')?.classList.contains('wide') === true, 'chat wide')
  check(
    'a small click only enlarges that chat',
    img('chat-a')?.classList.contains('wide') === true && size(img('chat-b')) === '240x150' && fake().actions.length === actionsBefore && !showed(),
    `${size(img('chat-a'))} ${size(img('chat-b'))}`
  )
  const wide = img('chat-a')!
  lay(wide)
  await until(() => laid(wide), 'chat laid out')
  const beforeEmpty = fake().actions.length
  clickPoint(wide, 50, 160)
  await new Promise((r) => setTimeout(r, 80))
  check('the left empty band does not click', !fake().actions.slice(beforeEmpty).some((row) => row.startsWith('mouse')), fake().actions.slice(beforeEmpty).join(','))
  clickPoint(wide, 220, 40)
  await until(() => fake().actions.slice(beforeEmpty).some((row) => row.startsWith('mouse')), 'chat click')
  const chatPage = fake().pages.find((p) => p._url === 'https://a.example' && !p._closed)
  check(
    'a click on the wide picture is (300, 100) on that chat window',
    fake().actions.includes(`mouse 300 100 ${chatPage?.windowId}`),
    `${fake().actions.slice(beforeEmpty).join(',')} pages ${fake().pages.map((p) => `${p.windowId}:${p._url}`).join(' ')}`
  )
  const shot = wide.closest('button')!
  const beforeKeys = fake().actions.length
  key(shot, 'Enter')
  key(shot, 'a')
  shot.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
  await until(() => fake().actions.some((row) => row.startsWith('wheel 120')), 'chat wheel')
  check(
    'keys and the wheel reach that chat window',
    fake().actions.includes(`press Enter ${chatPage?.windowId}`) &&
      fake().actions.includes(`type a ${chatPage?.windowId}`) &&
      fake().actions.includes(`wheel 120 ${chatPage?.windowId}`),
    fake().actions.slice(beforeKeys).join(',')
  )

  const deskImg = document.querySelector('#desk img') as HTMLImageElement
  const signCard = [...document.querySelectorAll('#desk .fcard')].find((el) => (el.textContent || '').includes('needs you to sign in'))
  check(
    'the desk sign-in sentence has the picture under it',
    !!signCard?.contains(deskImg) && !deskImg.closest('.fcard-body') && signCard.querySelector('.fcard-body')?.textContent === 'Writer needs you to sign in, in the desk browser.',
    signCard?.querySelector('.fcard-body')?.textContent || 'no card'
  )
  const beforeOpen = ipcLog().length
  button(signCard, 'Open browser')?.click()
  await until(() => deskImg.classList.contains('wide'), 'desk wide')
  check('desk Open browser stays on this picture and does not bring Chrome forward', deskImg.classList.contains('wide') && !showed() && ipcLog().slice(beforeOpen).every((row) => row[0] !== 'browser:showWindow'), String(ipcLog().slice(beforeOpen).map((row) => row[0])))
  lay(deskImg)
  await until(() => laid(deskImg), 'desk laid out')
  const beforeDesk = fake().actions.length
  clickPoint(deskImg, 50, 160)
  await new Promise((r) => setTimeout(r, 80))
  check('the desk empty band does not click', !fake().actions.slice(beforeDesk).some((row) => row.startsWith('mouse')), fake().actions.slice(beforeDesk).join(','))
  clickPoint(deskImg, 220, 40)
  await until(() => fake().actions.slice(beforeDesk).some((row) => row.startsWith('mouse')), 'desk click')
  const writer = fake().pages.find((p) => p._url === 'https://w.example' && !p._closed)
  check('the desk click is (300, 100) on the writer window', fake().actions.includes(`mouse 300 100 ${writer?.windowId}`), `${fake().actions.slice(beforeDesk).join(',')} pages ${fake().pages.map((p) => `${p.windowId}:${p._url}`).join(' ')}`)

  const chatTurn = document.querySelector('#chat-a .thread.page-turn')
  button(chatTurn, 'Hide')?.click()
  await until(() => chatTurn?.querySelector('.desk-browser-note')?.textContent === 'There were browsers.', 'chat hide')
  check('Hide leaves the note and does not bring the window forward', !img('chat-a') && !showed(), chatTurn?.textContent || '')

  fake().title = 'Sign in'
  button(chatTurn, 'There were browsers.')?.click()
  await until(() => document.querySelector('#chat-a .thread.page-turn p')?.textContent === 'Sign in, in the browser.' && !!img('chat-a'), 'chat sign-in')
  const signTurn = document.querySelector('#chat-a .thread.page-turn')
  button(signTurn, 'Open browser')?.click()
  await until(() => img('chat-a')?.classList.contains('wide') === true, 'sign-in wide')
  await new Promise((r) => setTimeout(r, 1600))
  check(
    'a sign-in poll leaves the wide picture under the sentence',
    document.querySelector('#chat-a .thread.page-turn p')?.textContent === 'Sign in, in the browser.' &&
      img('chat-a')?.classList.contains('wide') === true &&
      size(img('chat-b')) === '240x150' &&
      !showed(),
    `${document.querySelector('#chat-a .thread.page-turn p')?.textContent} ${size(img('chat-a'))} ${size(img('chat-b'))}`
  )
  const signImg = img('chat-a')!
  lay(signImg)
  await until(() => laid(signImg), 'sign-in laid out')
  const beforeSign = fake().actions.length
  clickPoint(signImg, 220, 40)
  await until(() => fake().actions.slice(beforeSign).some((row) => row.startsWith('mouse')), 'sign-in click')
  const signPage = fake().pages.find((p) => p._url === 'https://a.example' && !p._closed)
  check('the wide sign-in picture clicks that chat window', fake().actions.includes(`mouse 300 100 ${signPage?.windowId}`) && fake().actions.length > beforeSign, `${fake().actions.slice(beforeSign).join(',')} pages ${fake().pages.map((p) => `${p.windowId}:${p._url}`).join(' ')}`)

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error).stack || e) })
  const out = document.getElementById('out')
  if (out) out.textContent = JSON.stringify(results)
})
