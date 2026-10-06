import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { toSavedMsgs } from '../../src/shared/saved-msg'

type Call = { path: string; args: unknown[] }
const calls: Call[] = []
const chatListeners: ((e: unknown) => void)[] = []

/** Any bridge call the page does not name records itself and resolves to an empty answer. */
function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    calls.push({ path: name, args })
    if (name === 'chat.onEvent') {
      chatListeners.push(args[0] as (e: unknown) => void)
      return () => undefined
    }
    if (/\.on[A-Z]/.test(name)) return () => undefined
    if (name === 'files.pathFor') return `/tmp/${(args[0] as File).name}`
    if (name === 'chat.send') return Promise.resolve({ ok: true })
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}
;(window as unknown as { brain: unknown }).brain = bridge([])

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const CWD = '/Users/joe/Projects/agency-brain'
const transcript: Record<string, unknown[]> = {}

function Pane({ id, initial }: { id: string; initial?: unknown[] }) {
  const noop = () => undefined
  return (
    <ChatPane
      id={id}
      kind="grok"
      cwd={CWD}
      sessionId={`s-${id}`}
      active
      greeting="Hi."
      initialMessages={initial as never}
      onFiles={noop}
      onNew={noop}
      onModel={noop}
      onEffort={noop}
      onCaps={noop}
      onTranscript={(tid, msgs) => (transcript[tid] = msgs)}
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
  )
}

/** A text of exactly this many lines and UTF-8 bytes (ASCII), each line marked so swaps show. */
function body(tag: string, lines: number, bytes: number): string {
  const rows = Array.from({ length: lines }, (_, i) => `${tag}${i}`)
  const short = bytes - rows.join('\n').length
  rows[lines - 1] += 'z'.repeat(short)
  return rows.join('\n')
}

let paneA: HTMLElement
const box = () => paneA.querySelector<HTMLTextAreaElement>('.composer textarea')!
const chips = () => [...paneA.querySelectorAll<HTMLElement>('.pasterow .paste-chip')]
const sends = () => calls.filter((c) => c.path === 'chat.send').map((c) => (c.args[0] as { text: string }).text)
const emit = (ev: Record<string, unknown>) => flushSync(() => chatListeners.forEach((l) => l({ tabId: 'chat-a', ...ev })))
function typeInto(value: string) {
  const el = box()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function paste(text: string, files: File[] = []): boolean {
  const el = box()
  el.focus()
  const dt = new DataTransfer()
  if (text) dt.setData('text/plain', text)
  for (const f of files) dt.items.add(f)
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  flushSync(() => el.dispatchEvent(ev))
  return ev.defaultPrevented
}
async function enter() {
  box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(80)
}
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent || '').trim() === label)

async function main() {
  const layout = document.createElement('style')
  layout.textContent = '.stage{display:grid;grid-template-columns:760px 760px;gap:8px}.stage>div{position:relative;height:760px;overflow:hidden;display:flex;flex-direction:column;border:1px solid #ccc}'
  document.head.appendChild(layout)
  const stage = document.createElement('div')
  stage.className = 'stage'
  paneA = document.createElement('div')
  const paneB = document.createElement('div')
  stage.append(paneA, paneB)
  document.getElementById('root')!.appendChild(stage)
  createRoot(paneA, { onUncaughtError: (e) => check('render error', false, String((e as Error)?.stack || e)) }).render(<Pane id="chat-a" />)
  await tick(150)
  check('the chat mounts with its composer', !!paneA.querySelector('.composer textarea'), paneA.innerHTML.slice(0, 300))
  if (!paneA.querySelector('.composer textarea')) throw new Error('no composer')

  const one = body('one', 200, 10240)
  const two = body('two', 30, 4096)
  const tok1 = '[Pasted text #1 +200 lines]'
  const tok2 = '[Pasted text #2 +30 lines]'

  // (a) a big paste lands as a token at the caret, with a chip
  typeInto('Review this: ')
  check('(a) big paste is taken over', paste(one))
  await tick()
  check('(a) box holds the token, no extra spaces', box().value === `Review this: ${tok1}`, JSON.stringify(box().value))
  check('(a) one chip with size and lines', chips().length === 1 && /10KB/.test(chips()[0].textContent || '') && /200 lines/.test(chips()[0].textContent || ''), chips().map((c) => c.textContent).join(' | '))

  // (b) a second paste is #2
  typeInto(`${box().value} and `)
  paste(two)
  await tick()
  check('(b) second token follows', box().value === `Review this: ${tok1} and ${tok2}`, JSON.stringify(box().value))
  check('(b) two chips', chips().length === 2 && /4KB/.test(chips()[1].textContent || '') && /30 lines/.test(chips()[1].textContent || ''))

  // (c) send swaps each token for its paste, in place
  const before = box().value
  const want = before.trim().split(tok1).join(one).split(tok2).join(two)
  await enter()
  check('(c) chat.send once with both pastes in place', sends().length === 1 && sends()[0] === want, `${sends().length} ${JSON.stringify((sends()[0] || '').slice(0, 80))}`)
  check('(c) box and chips clear', box().value === '' && chips().length === 0)
  emit({ kind: 'done' })
  await tick()

  // (d) the thread folds the pastes; show opens the first
  const bubble = [...paneA.querySelectorAll<HTMLElement>('.bubble.me')].pop()!
  const labels = () => [...bubble.querySelectorAll<HTMLButtonElement>('.paste-label')]
  check('(d) two folded pastes in the bubble', labels().length === 2 && (labels()[0].textContent || '').startsWith(tok1) && (labels()[1].textContent || '').startsWith(tok2), labels().map((l) => l.textContent).join(' | '))
  check('(d) the full text is not on screen while folded', !bubble.querySelector('.paste-body') && !(bubble.textContent || '').includes('one199'))
  labels()[0].click()
  await tick()
  check('(d) show opens paste 1 exactly', bubble.querySelector('.paste-body')?.textContent === one)

  // (d2) a reload: saved through the same mapping, JSON round trip, a fresh pane
  const saved = JSON.parse(JSON.stringify(toSavedMsgs(transcript['chat-a'] as never)))
  createRoot(paneB, { onUncaughtError: (e) => check('render error', false, String((e as Error)?.stack || e)) }).render(<Pane id="chat-b" initial={saved} />)
  await tick(150)
  const bubbleB = [...paneB.querySelectorAll<HTMLElement>('.bubble.me')].pop()
  const labelsB = [...(bubbleB?.querySelectorAll<HTMLButtonElement>('.paste-label') || [])]
  check('(d2) after reload the two pastes are still folded', labelsB.length === 2 && (labelsB[0].textContent || '').startsWith(tok1) && (labelsB[1].textContent || '').startsWith(tok2), labelsB.map((l) => l.textContent).join(' | '))
  labelsB[0]?.click()
  await tick()
  check('(d2) show after reload equals paste 1', bubbleB?.querySelector('.paste-body')?.textContent === one)

  // (e) Expand writes the paste into the box
  const three = body('three', 40, 3000)
  paste(three)
  await tick()
  button(paneA, 'Expand')?.click()
  await tick()
  check('(e) expand puts the text in the box, no token, no chip', box().value === three && chips().length === 0, JSON.stringify(box().value.slice(0, 60)))
  let n = sends().length
  await enter()
  check('(e) send passes the box unchanged', sends().length === n + 1 && sends()[n] === three.trim())
  emit({ kind: 'done' })
  await tick()

  // (f) an edited token is just text
  paste(three)
  await tick()
  typeInto(box().value.slice(0, -1))
  await tick()
  check('(f) a broken token has no chip', chips().length === 0, box().value)
  const typed = box().value
  n = sends().length
  await enter()
  check('(f) send passes the box exactly as typed', sends()[n] === typed.trim(), JSON.stringify(sends()[n]))
  emit({ kind: 'done' })
  await tick()

  // (g) the cutovers
  const at15 = body('g', 15, 1000)
  check('(g) 1,000 characters on 15 lines stays plain', !paste(at15) && chips().length === 0 && box().value === '')
  const wide = body('w', 2, 1001)
  check('(g) 1,001 characters becomes a chip', paste(wide) && chips().length === 1)
  button(paneA, '×')?.click()
  await tick()
  const tall = Array.from({ length: 16 }, (_, i) => `r${i}`).join('\n')
  check('(g) 16 short lines becomes a chip', paste(tall) && chips().length === 1 && box().value === '[Pasted text #1 +16 lines]', box().value)
  paneA.querySelector<HTMLButtonElement>('.paste-chip .tabx')?.click()
  await tick()

  // (h) caret, undo, and the chip's ×
  typeInto('AABB')
  box().setSelectionRange(2, 2)
  paste(one)
  await tick()
  check('(h) the token goes in at the caret', box().value === `AA${tok1}BB`, JSON.stringify(box().value))
  check('(h) the caret sits right after the token', box().selectionStart === 2 + tok1.length, String(box().selectionStart))
  box().focus()
  flushSync(() => document.execCommand('undo'))
  await tick()
  check('(h2) undo takes the paste back out', box().value === 'AABB' && chips().length === 0, JSON.stringify(box().value))
  box().setSelectionRange(4, 4)
  paste(two)
  await tick()
  check('(h3) a fresh paste after undo gets its own chip', chips().length === 1)
  paneA.querySelector<HTMLButtonElement>('.paste-chip .tabx')?.click()
  await tick()
  check('(h3) × removes the token and the chip', box().value === 'AABB' && chips().length === 0, JSON.stringify(box().value))
  typeInto('AABB go')
  n = sends().length
  await enter()
  check('(h3) send leaves the removed paste out', sends()[n] === 'AABB go' && !sends()[n].includes('two0'))
  emit({ kind: 'done' })
  await tick()

  // (i) a paste sent while busy queues, then goes out whole
  typeInto('start')
  await enter()
  paste(one)
  await tick()
  n = sends().length
  await enter()
  check('(i) while busy the paste queues', sends().length === n && paneA.querySelectorAll('.followq-row').length === 1)
  check('(i) the queued row shows the token, not the text', (paneA.querySelector('.followq-row span')?.textContent || '') === tok1)
  emit({ kind: 'done' })
  await tick(80)
  check('(i) the drained send carries the paste', sends()[n] === one, JSON.stringify((sends()[n] || '').slice(0, 40)))
  emit({ kind: 'done' })
  await tick()

  // (i2) Edit on a queued paste brings back the token and its chip
  typeInto('start two')
  await enter()
  paste(two)
  await tick()
  await enter()
  button(paneA.querySelector('.followq-row')!, 'Edit')?.click()
  await tick()
  check('(i2) edit restores the token and the chip', box().value === '[Pasted text #1 +30 lines]' && chips().length === 1, JSON.stringify(box().value))
  emit({ kind: 'done' })
  await tick()
  n = sends().length
  await enter()
  check('(i2) the edited send carries the paste', sends()[n] === two, JSON.stringify((sends()[n] || '').slice(0, 40)))
  emit({ kind: 'done' })
  await tick()

  // (k) size is UTF-8 bytes
  const accents = Array.from({ length: 20 }, () => 'é'.repeat(100)).join('\n')
  paste(accents)
  await tick()
  check('(k) the chip reads 4KB and 20 lines', chips().length === 1 && /4KB/.test(chips()[0].textContent || '') && /20 lines/.test(chips()[0].textContent || ''), chips()[0]?.textContent || '')
  check('(k) the token counts 20 lines', box().value === '[Pasted text #1 +20 lines]', box().value)
  paneA.querySelector<HTMLButtonElement>('.paste-chip .tabx')?.click()
  await tick()

  // (j) files keep today's path
  const fileChips = () => [...paneA.querySelectorAll<HTMLElement>('.attachrow:not(.pasterow) .chip')]
  check('(j) a file paste is taken (no text)', paste('', [new File(['png'], 'shot.png', { type: 'image/png' })]))
  await tick(80)
  check('(j) the file attaches, no paste chip, box unchanged', fileChips().some((c) => (c.textContent || '').includes('shot.png')) && chips().length === 0 && box().value === '')
  const big = body('path', 20, 1500)
  check('(j) a file plus text keeps the browser text paste', !paste(big, [new File(['pdf'], 'doc.pdf', { type: 'application/pdf' })]))
  await tick(80)
  check('(j) that file attaches and no paste chip appears', fileChips().some((c) => (c.textContent || '').includes('doc.pdf')) && chips().length === 0)

  // Leave a composer with two pastes on screen for the screenshot.
  for (let c = paneA.querySelector<HTMLButtonElement>('.attachrow:not(.pasterow) .chip .tabx'); c; c = paneA.querySelector<HTMLButtonElement>('.attachrow:not(.pasterow) .chip .tabx')) {
    c.click()
    await tick()
  }
  typeInto('Review this: ')
  paste(one)
  typeInto(`${box().value} and `)
  paste(two)
  await tick()

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
