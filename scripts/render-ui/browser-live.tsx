import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { mapClick } from '../../src/shared/page-picture'
import type { DeskCli } from '../../src/shared/desk'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { DeskPane } from '../../src/renderer/src/DeskPane'

// The wide picture, live: frames, mouse and keys, on a real chat and the real Desk.
// node --experimental-strip-types scripts/render-ui.ts browser-live

type Call = { name: string; args: unknown[] }
const calls: Call[] = []
const frameListeners: ((f: { owner: string; url: string; src: string }) => void)[] = []

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

const browseMsg = {
  id: 'm_browse',
  ts: '2026-10-09T09:20:00.000Z',
  from: 'writer',
  to: 'me',
  kind: 'browse' as const,
  text: 'Opened the example page.',
  browse: { steps: [{ action: 'url', detail: 'https://w.example', url: 'https://w.example' }], title: 'Example', windowOpen: true }
}

function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (name.startsWith('browser.') && name !== 'browser.face') calls.push({ name, args })
    if (name === 'browser.onFrame') {
      frameListeners.push(args[0] as (f: { owner: string; url: string; src: string }) => void)
      return () => {
        const i = frameListeners.indexOf(args[0] as (f: { owner: string; url: string; src: string }) => void)
        if (i >= 0) frameListeners.splice(i, 1)
      }
    }
    if (name === 'browser.face') return Promise.resolve({ src: FIRST, signIn: false })
    if (name === 'desk.picture') return Promise.resolve(FIRST)
    if (name === 'desk.attach') return Promise.resolve({ brain: '/fx/desk' })
    if (name === 'desk.welcome')
      return Promise.resolve({ greetingName: 'Joe', greeting: 'Desk is here.', starters: [], readiness: [], composerDisabled: false, composerPlaceholder: 'Message Conductor', everyoneLine: null })
    if (name === 'desk.list')
      return Promise.resolve({
        bots: [{ id: 'writer', name: 'Writer', cli: 'grok', model: 'default', effort: 'low', description: 'Writes.', file: '/fx/writer.md' }],
        states: [{ id: 'writer', state: 'idle' }],
        removedNames: {}
      })
    if (name === 'desk.view') return Promise.resolve([browseMsg])
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
const since = (n: number, name?: string) => calls.slice(n).filter((c) => !name || c.name === name)

let setChatActive: (on: boolean) => void = noop
let setChatShown: (on: boolean) => void = noop

function Stage() {
  const [active, setActive] = useState(true)
  const [shown, setShown] = useState(true)
  const [rail, setRail] = useState<HTMLElement | null>(null)
  setChatActive = setActive
  setChatShown = setShown
  return (
    <>
      <div id="chat" style={{ width: 900, height: 700 }}>
        {shown ? (
          <ChatPane
            id="chat-a"
            kind="grok"
            cwd="/tmp/brain"
            sessionId="s-a"
            active={active}
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
        ) : null}
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
const img = (root: string) => document.querySelector(`#${root} .desk-browser-shot img`) as HTMLImageElement | null
const shotButton = (root: string) => document.querySelector(`#${root} .desk-browser-shot`) as HTMLButtonElement | null

/** A point at (fx, fy) of the page drawn inside the picture's box (not the empty bands), and where the page should get it. */
function spot(el: HTMLImageElement, fx: number, fy: number) {
  const rect = el.getBoundingClientRect()
  const scale = Math.min(el.clientWidth / el.naturalWidth, el.clientHeight / el.naturalHeight)
  const left = (el.clientWidth - el.naturalWidth * scale) / 2
  const top = (el.clientHeight - el.naturalHeight * scale) / 2
  const border = Number.parseFloat(getComputedStyle(el).borderLeftWidth) || 0
  const x = left + el.naturalWidth * scale * fx
  const y = top + el.naturalHeight * scale * fy
  const at = { clientX: rect.left + border + x, clientY: rect.top + border + y }
  const page = mapClick({ x, y }, { width: el.clientWidth, height: el.clientHeight }, { width: el.naturalWidth, height: el.naturalHeight })!
  return { ...at, page }
}
function mouse(el: HTMLElement, type: string, at: { clientX: number; clientY: number }, extra: Record<string, number> = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.clientX, clientY: at.clientY, button: 0, ...extra })
  el.dispatchEvent(ev)
  return ev
}
function keydown(el: HTMLElement, init: KeyboardEventInit) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}

async function exercise(root: string, owner: string, widen: () => Promise<void>) {
  check(`${root}: a small picture has started no frames`, !calls.some((c) => c.name === 'browser.watch' && c.args[0] === owner))
  const before = calls.length
  const small = img(root)!
  const c0 = spot(small, 0.5, 0.5)
  mouse(small, 'mousedown', c0, { detail: 1, buttons: 1 })
  mouse(small, 'mouseup', c0, { detail: 1 })
  keydown(shotButton(root)!, { key: 'a', code: 'KeyA' })
  check(`${root}: a small picture sends no mouse or key to the page`, since(before).every((c) => !/browser\.(pointer|key)/.test(c.name)), since(before).map((c) => c.name).join(','))
  mouse(small, 'click', c0, { detail: 1 })
  await tick(120)
  await widen()
  await until(() => !!img(root)?.classList.contains('wide'), `${root} wide`)
  await tick(150)
  const wide = img(root)!
  check(`${root}: the wide picture is not 1100x800 on screen`, wide.clientWidth !== 1100 && wide.clientWidth > 300, `${wide.clientWidth}x${wide.clientHeight}`)
  check(`${root}: going wide starts frames for this place`, since(before, 'browser.watch').some((c) => c.args[0] === owner && c.args[1] === true))

  const n = calls.length
  const a = spot(wide, 0.2, 0.4)
  const b = spot(wide, 0.35, 0.4)
  const cc = spot(wide, 0.5, 0.42)
  const d = spot(wide, 0.65, 0.45)
  mouse(wide, 'mousedown', a, { detail: 1, buttons: 1 })
  for (const p of [b, cc, d]) {
    await tick(45)
    mouse(wide, 'mousemove', p, { buttons: 1 })
  }
  mouse(wide, 'mouseup', d, { detail: 1, buttons: 0 })
  await tick(60)
  const ptr = since(n, 'browser.pointer').map((c) => c.args[1] as { type: string; x: number; y: number; buttons: number; clickCount: number })
  // Mouse event coordinates are whole CSS pixels, so a page point can be off by up to one CSS pixel (about 3 page pixels here).
  const want = [a, b, cc, d, d].map((p) => p.page)
  check(
    `${root}: a drag is down, three moves with the button held, up, at the mapped page points`,
    ptr.map((p) => p.type).join(',') === 'down,move,move,move,up' &&
      ptr.every((p, i) => Math.abs(p.x - want[i].x) <= 3 && Math.abs(p.y - want[i].y) <= 3) &&
      ptr.slice(1, 4).every((p) => p.buttons === 1) &&
      since(n, 'browser.pointer').every((c) => c.args[0] === owner),
    JSON.stringify(ptr) + ' want ' + JSON.stringify(want)
  )
  check(`${root}: the mouse press focuses the picture`, document.activeElement === shotButton(root))
  const n2 = calls.length
  mouse(wide, 'mousedown', a, { detail: 2, buttons: 1 })
  mouse(wide, 'mouseup', a, { detail: 2 })
  await tick(40)
  const dbl = since(n2, 'browser.pointer').map((c) => (c.args[1] as { clickCount: number }).clickCount)
  check(`${root}: a double-click sends clickCount 2`, dbl.length === 2 && dbl.every((k) => k === 2), JSON.stringify(dbl))
  const drag = new Event('dragstart', { bubbles: true, cancelable: true })
  wide.dispatchEvent(drag)
  check(`${root}: dragging the image itself is cancelled`, drag.defaultPrevented)

  const btn = shotButton(root)!
  const composer = document.querySelector(`#chat .composer textarea`) as HTMLTextAreaElement | null
  const composerBefore = composer?.value ?? ''
  const n3 = calls.length
  const keys: KeyboardEventInit[] = [
    { key: 'Tab', code: 'Tab' },
    { key: 'Tab', code: 'Tab', shiftKey: true },
    { key: 'Delete', code: 'Delete' },
    { key: 'Escape', code: 'Escape' },
    { key: 'Home', code: 'Home' },
    { key: 'A', code: 'KeyA', shiftKey: true }
  ]
  const prevented = keys.map((k) => keydown(btn, k).defaultPrevented)
  const cmds: [KeyboardEventInit, string][] = [
    [{ key: 'v', code: 'KeyV', metaKey: true }, 'paste'],
    [{ key: 'a', code: 'KeyA', metaKey: true }, 'selectAll'],
    [{ key: 'c', code: 'KeyC', metaKey: true }, 'copy'],
    [{ key: 'x', code: 'KeyX', metaKey: true }, 'cut'],
    [{ key: 'z', code: 'KeyZ', metaKey: true }, 'undo'],
    [{ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }, 'redo']
  ]
  const cmdPrevented = cmds.map(([k]) => keydown(btn, k).defaultPrevented)
  const quit = keydown(btn, { key: 'q', code: 'KeyQ', metaKey: true })
  await tick(40)
  const sent = since(n3, 'browser.key').map((c) => ({ owner: c.args[0], ...(c.args[1] as { key: string; modifiers: number; text?: string; command?: string }) }))
  const plain = sent.slice(0, 6)
  check(
    `${root}: Tab, Shift+Tab, Delete, Escape, Home and a capital letter reach the page once each`,
    plain.map((k) => `${k.key}:${k.modifiers}:${k.text ?? ''}`).join(' ') === 'Tab:0: Tab:8: Delete:0: Escape:0: Home:0: A:8:A' && prevented.every(Boolean) && plain.every((k) => k.owner === owner),
    JSON.stringify(plain)
  )
  check(
    `${root}: Cmd+V, A, C, X, Z and Shift+Z become paste, selectAll, copy, cut, undo, redo`,
    sent.slice(6).map((k) => k.command).join(',') === cmds.map(([, c]) => c).join(',') && cmdPrevented.every(Boolean),
    JSON.stringify(sent.slice(6))
  )
  check(`${root}: Cmd+Q stays Brain's (not sent, not prevented)`, sent.length === 12 && !quit.defaultPrevented)
  check(`${root}: Brain's composer got none of those keys`, (composer?.value ?? '') === composerBefore)

  const srcBefore = img(root)!.getAttribute('src')
  const other = jpeg('#335')
  flushSync(() => frameListeners.forEach((l) => l({ owner: owner === 'chat:chat-a' ? 'desk:writer' : 'chat:chat-a', url: 'https://x', src: other })))
  await tick(40)
  check(`${root}: another place's frame does not change this picture`, img(root)!.getAttribute('src') === srcBefore)
  const mine = jpeg('#3a5')
  flushSync(() => frameListeners.forEach((l) => l({ owner, url: 'https://w.example/next', src: mine })))
  await tick(40)
  check(`${root}: this place's frame replaces the picture`, img(root)!.getAttribute('src') === `data:image/jpeg;base64,${mine}`)
}

async function main() {
  createRoot(document.getElementById('root')!).render(<Stage />)
  await until(() => !!document.querySelector('#chat .composer textarea'), 'chat composer')
  const box = document.querySelector('#chat .composer textarea') as HTMLTextAreaElement
  box.focus()
  flushSync(() => typeInto(box, 'https://a.example'))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await until(() => !!img('chat')?.naturalWidth, 'chat picture')
  await exercise('chat', 'chat:chat-a', async () => {
    const small = img('chat')!
    if (!small.classList.contains('wide')) small.click()
  })

  const watchOff = () => calls.filter((c) => c.name === 'browser.watch' && c.args[0] === 'chat:chat-a' && c.args[1] === false).length
  const watchOn = () => calls.filter((c) => c.name === 'browser.watch' && c.args[0] === 'chat:chat-a' && c.args[1] === true).length
  let off = watchOff()
  const hide = [...document.querySelectorAll('#chat .page-turn button')].find((b) => b.textContent?.trim() === 'Hide') as HTMLButtonElement
  hide.click()
  await tick(80)
  check('chat: leaving wide (Hide) stops the frames', watchOff() === off + 1, `${off} -> ${watchOff()}`)
  ;(document.querySelector('#chat .desk-browser-note') as HTMLButtonElement).click()
  await tick(80)
  img('chat')!.click()
  await until(() => !!img('chat')?.classList.contains('wide'), 'chat wide again')
  await tick(80)
  const on = watchOn()
  off = watchOff()
  flushSync(() => setChatActive(false))
  await tick(80)
  check('chat: the tab going inactive stops the frames', watchOff() === off + 1, `${off} -> ${watchOff()}`)
  flushSync(() => setChatActive(true))
  await tick(80)
  check('chat: the tab coming back starts them again', watchOn() === on + 1)
  off = watchOff()
  flushSync(() => setChatShown(false))
  await tick(80)
  check('chat: closing the chat stops the frames', watchOff() === off + 1, `${off} -> ${watchOff()}`)

  await until(() => !!img('desk')?.naturalWidth, 'desk picture', 6000)
  await exercise('desk', 'desk:writer', async () => {
    const small = img('desk')!
    if (!small.classList.contains('wide')) small.click()
  })
  const deskOff = calls.filter((c) => c.name === 'browser.watch' && c.args[0] === 'desk:writer' && c.args[1] === false).length
  const deskHide = [...document.querySelectorAll('#desk button')].find((b) => b.textContent?.trim() === 'Hide') as HTMLButtonElement
  deskHide.click()
  await tick(80)
  check('desk: leaving wide (Hide) stops the frames', calls.filter((c) => c.name === 'browser.watch' && c.args[0] === 'desk:writer' && c.args[1] === false).length === deskOff + 1)

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
