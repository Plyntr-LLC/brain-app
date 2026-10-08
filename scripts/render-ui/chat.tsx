import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { ActivityRail } from '../../src/renderer/src/ActivityRail'
import type { Activity } from '../../src/renderer/src/activity'
import { nextAction, type ActionState } from '../../src/renderer/src/chat-activity'

type Call = { path: string; args: unknown[] }
const calls: Call[] = []
const chatListeners: ((e: unknown) => void)[] = []
const phoneListeners: ((e: unknown) => void)[] = []
const opened: string[] = []

/** Any bridge call the page does not name records itself and resolves to an empty answer. */
function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    calls.push({ path: name, args })
    if (name === 'chat.onEvent') {
      chatListeners.push(args[0] as (e: unknown) => void)
      return () => undefined
    }
    if (name === 'phone.onIncoming') {
      phoneListeners.push(args[0] as (e: unknown) => void)
      return () => undefined
    }
    if (/\.on[A-Z]/.test(name)) return () => undefined
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
const ID = 'chat-1'

let activityCalls = 0
let rail: HTMLElement
function Harness() {
  const [activity, setActivity] = useState<Activity | null>(null)
  return (
    <div className="stage-row">
      <div className="stage-pane">
        <ChatPane
          id={ID}
          kind="grok"
          cwd={CWD}
          sessionId="s1"
          active
          greeting="Hi."
          onFiles={() => undefined}
          onNew={() => undefined}
          onModel={() => undefined}
          onEffort={() => undefined}
          onCaps={() => undefined}
          onTranscript={() => undefined}
          onContext={() => undefined}
          onApprove={() => undefined}
          onRename={() => undefined}
          onResume={() => undefined}
          onFork={() => undefined}
          onAgentMode={() => undefined}
          onDelete={() => undefined}
          onOpenTerm={() => undefined}
          onBusy={() => undefined}
          onActivity={(_id, a) => {
            activityCalls++
            setActivity(a)
          }}
        />
      </div>
      <aside className="refs stage-rail" ref={(el) => (rail = el as HTMLElement)}>
        {activity ? (
          <ActivityRail activity={activity} openFile={{ open: (p) => opened.push(p), canOpen: (p) => p.startsWith(`${CWD}/`) }} />
        ) : null}
      </aside>
    </div>
  )
}

const emit = (ev: Record<string, unknown>) => flushSync(() => chatListeners.forEach((l) => l({ tabId: ID, ...ev })))
const now = () => (rail.querySelector('.rail-now-text')?.textContent || '').trim()
const timer = () => !!rail.querySelector('.rail-now .rail-timer')
const logLines = () => [...rail.querySelectorAll('.rail-log .rail-logtext')].map((e) => e.textContent || '')
const stepRows = () => [...rail.querySelectorAll<HTMLElement>('.rail-steps .rail-row')]
function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
async function send(text: string) {
  const boxes = [...document.querySelectorAll<HTMLTextAreaElement>('.stage-pane textarea')]
  const box = boxes[boxes.length - 1]
  typeInto(box, text)
  await tick()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick(80)
}

async function main() {
  const layout = document.createElement('style')
  layout.textContent = '.stage-row{display:grid;grid-template-columns:860px 300px;height:760px;border:1px solid #ccc}.stage-pane{position:relative;overflow:hidden;display:flex;flex-direction:column}.stage-rail{display:flex;flex-direction:column;border-left:1px solid #ddd;background:var(--paper)}'
  document.head.appendChild(layout)
  createRoot(document.getElementById('root')!).render(<Harness />)
  await tick(150)
  const listenerOk = chatListeners.length > 0
  check('the chat listens for events', listenerOk, JSON.stringify(calls.map((c) => c.path).slice(0, 20)))

  // (i) send
  await send('pull last week’s Summit numbers and draft the report')
  check('(i) Enter sends through chat.send', calls.some((c) => c.path === 'chat.send'), JSON.stringify(calls.map((c) => c.path)))
  check('(i) Now is live with a timer', !!rail.querySelector('.rail-now.live') && timer(), now())

  // (ii) plan
  emit({ kind: 'plan', steps: [{ title: 'Pull the numbers', status: 'completed' }, { title: 'Compare weeks', status: 'completed' }, { title: 'Write the report', status: 'in_progress' }, { title: 'Draft the email', status: 'pending' }] })
  await tick()
  check('(ii) Plan heading', (rail.querySelector('.rail-steps h5')?.textContent || '') === 'Plan')
  check('(ii) Plan rows done, done, live, todo', stepRows().map((r) => ['done', 'live', 'todo'].find((c) => r.classList.contains(c))).join(',') === 'done,done,live,todo', stepRows().map((r) => r.className).join(' | '))
  check('(ii) no Team, Progress or Ship in a chat rail', !rail.querySelector('.rail-team, .rail-progress, .rail-ship'))

  // (iii) actions
  emit({ kind: 'status', data: 'work:Ran GAQL report' })
  emit({ kind: 'status', data: 'work:Read clients/summit/context.md' })
  for (const p of [`${CWD}/clients/summit/reports/a.html`, `${CWD}/clients/summit/context.md`, `${CWD}/clients/summit/notes.md`, '/Users/joe/Projects/lotline/README.md']) emit({ kind: 'file', path: p })
  emit({ kind: 'status', data: 'work:Read clients/summit/context.md' })
  emit({ kind: 'status', data: 'work:Read clients/summit/context.md' })
  await tick()
  check('(iii) Now is the newest action with a timer', now() === 'Read clients/summit/context.md' && timer(), now())
  const expected = ['Ran GAQL report', 'Read clients/summit/context.md', 'Reading a.html', 'Reading context.md', 'Reading notes.md', 'Reading README.md']
  check('(iii) Done so far, in order, no placeholder, no repeat', JSON.stringify(logLines()) === JSON.stringify(expected), JSON.stringify(logLines()))

  // (viii) no per-second rail updates while busy
  const before = activityCalls
  await tick(3000)
  check('(viii) a 3-second busy wait sends no rail updates', activityCalls === before, `${activityCalls - before} calls`)

  // (xii) a background job while the turn is busy: the turn's action stays in Now.
  const BG = 'Started in the background: asking Grok 4.6 (xhigh)'
  emit({ kind: 'status', data: 'bg:' + JSON.stringify([{ label: BG, at: Date.now() - 90000 }]) })
  await tick()
  check('(xii) busy with a background job: Now stays on the action', now() === 'Read clients/summit/context.md' && timer() && !!rail.querySelector('.rail-now.live'), now())
  emit({ kind: 'status', data: 'bg:[]' })
  await tick()

  // (iv) permission while busy
  emit({ kind: 'permission', title: 'Edit report.html', path: `${CWD}/clients/summit/reports/a.html`, options: [{ id: 'allowOnce', label: 'Allow' }, { id: 'skip', label: 'Skip' }] })
  await tick(80)
  check('(iv) Now asks while the turn is busy', now() === 'Waiting on you: Edit report.html' && !!rail.querySelector('.rail-now.ask'), now())
  const allow = [...document.querySelectorAll<HTMLButtonElement>('.stage-pane button')].find((b) => (b.textContent || '').trim() === 'Allow')
  check('(iv) the thread shows the ask', !!allow)
  allow?.click()
  await tick(80)
  check('(iv) answering returns Now to the action', now() === 'Read clients/summit/context.md', now())
  check('(iv) the answer reached skin.decide', calls.some((c) => c.path === 'skin.decide' && c.args[1] === 'allowOnce'))

  // (vii) files, before the next send clears them
  const fold = rail.querySelector<HTMLButtonElement>('.rail-fold')
  check('(vii) Files · 4, folded', (fold?.textContent || '').trim() === 'Files · 4' && !rail.querySelector('.rail-file'))
  fold?.click()
  await tick()
  const inFolder = [...rail.querySelectorAll<HTMLElement>('.rail-file')].find((f) => f.title === `${CWD}/clients/summit/reports/a.html`)
  inFolder?.click()
  const outside = [...rail.querySelectorAll<HTMLElement>('.rail-file')].find((f) => f.title === '/Users/joe/Projects/lotline/README.md')
  outside?.click()
  await tick()
  check('(vii) an in-folder file opens by its absolute path', opened.length === 1 && opened[0] === `${CWD}/clients/summit/reports/a.html`, JSON.stringify(opened))
  check('(vii) a file outside the folder is a plain line', !!outside && outside.tagName !== 'BUTTON')

  // (v) done
  emit({ kind: 'done' })
  await tick(80)
  check('(v) done: idle, no timer', now() === 'Idle. Waiting for your next message.' && !!rail.querySelector('.rail-now.idle') && !timer(), now())
  check('(v) Plan stays until the next send', stepRows().length === 4)

  // (xiii) the turn is over and a background job runs: Now shows it with a timer instead of Idle.
  emit({ kind: 'status', data: 'bg:' + JSON.stringify([{ label: BG, at: Date.now() - 90000 }]) })
  await tick(80)
  const timerText = () => (rail.querySelector('.rail-now .rail-timer')?.textContent || '').trim()
  check('(xiii) background: Now names the job', now() === 'In the background: asking Grok 4.6 (xhigh)' && !!rail.querySelector('.rail-now.live'), now())
  check('(xiii) background: timer from the job start', /^1:3\d$/.test(timerText()), timerText())
  emit({ kind: 'status', data: 'bg:' + JSON.stringify([{ label: BG, at: Date.now() - 90000 }, { label: 'Started in the background: Wait for deploy', at: Date.now() - 5000 }]) })
  await tick(80)
  check('(xiii) two jobs: (+1 more)', now() === 'In the background: asking Grok 4.6 (xhigh) (+1 more)', now())
  emit({ kind: 'permission', title: 'Edit report.html', path: `${CWD}/clients/summit/reports/a.html`, options: [{ id: 'allowOnce', label: 'Allow' }, { id: 'skip', label: 'Skip' }] })
  await tick(80)
  check('(xiii) a permission ask wins over background jobs', now() === 'Waiting on you: Edit report.html' && !!rail.querySelector('.rail-now.ask'), now())
  ;[...document.querySelectorAll<HTMLButtonElement>('.stage-pane button')].find((b) => (b.textContent || '').trim() === 'Allow')?.click()
  await tick(80)
  check('(xiii) after the answer Now is the background job again', now() === 'In the background: asking Grok 4.6 (xhigh) (+1 more)', now())
  emit({ kind: 'status', data: 'bg:[]' })
  await tick(80)
  check('(xiii) no jobs left: idle, no timer', now() === 'Idle. Waiting for your next message.' && !!rail.querySelector('.rail-now.idle') && !timer(), now())

  // (vi) a second send clears Done so far and keeps the plan. A later plan adds a step and does not send a finished step back.
  await send('now draft the email')
  check('(vi) Done so far cleared, Plan kept', !rail.querySelector('.rail-log') && stepRows().length === 4, `${stepRows().length}`)
  emit({
    kind: 'plan',
    steps: [
      { title: 'Pull the numbers', status: 'pending' },
      { title: 'Send the draft', status: 'in_progress' }
    ]
  })
  await tick()
  const labels = () => stepRows().map((r) => (r.querySelector('.rail-label')?.textContent || '').trim())
  check(
    '(vi) the new point is added and a finished step stays done',
    labels().join('|') === 'Pull the numbers|Compare weeks|Write the report|Draft the email|Send the draft' &&
      stepRows()[0].classList.contains('done') &&
      stepRows()[4].classList.contains('live'),
    labels().join('|')
  )

  // (ix) error ends a busy turn
  emit({ kind: 'status', data: 'work:Drafting the email' })
  await tick()
  emit({ kind: 'error', data: 'the CLI stopped' })
  await tick(80)
  check('(ix) error: idle, no timer', now() === 'Idle. Waiting for your next message.' && !timer(), now())

  // A phone message starts a turn: Done so far goes, the plan stays.
  emit({ kind: 'done' })
  emit({ kind: 'plan', steps: [{ title: 'Old step', status: 'completed' }] })
  emit({ kind: 'status', data: 'work:Old action one' })
  emit({ kind: 'status', data: 'work:Old action two' })
  emit({ kind: 'done' })
  await tick()
  check('(x) before the phone turn the rail holds the old turn', stepRows().length === 6 && logLines().includes('Old action one'), `${stepRows().length} ${JSON.stringify(logLines())}`)
  flushSync(() => phoneListeners.forEach((l) => l({ tabId: ID, text: 'from my phone: check the inbox' })))
  await tick(80)
  check('(x) a phone message keeps the plan and clears Done so far', stepRows().length === 6 && !rail.querySelector('.rail-log') && !!rail.querySelector('.rail-now.live'), `${stepRows().length} ${now()}`)
  emit({ kind: 'plan', steps: [{ title: 'Read the inbox', status: 'in_progress' }] })
  emit({ kind: 'status', data: 'work:Read the inbox' })
  emit({ kind: 'status', data: 'work:Sorted mail' })
  emit({ kind: 'done' })
  await tick()
  check(
    '(x) the phone plan adds a step and a finished step stays done',
    labels().join('|') === 'Pull the numbers|Compare weeks|Write the report|Draft the email|Send the draft|Old step|Read the inbox' &&
      stepRows()[0].classList.contains('done') &&
      stepRows()[6].classList.contains('live'),
    labels().join('|')
  )
  await send('/clear')
  await tick(80)
  check('(xi) /clear clears Plan and Done so far', !rail.querySelector('.rail-steps') && !rail.querySelector('.rail-log'), `${stepRows().length} ${logLines().length}`)

  // nextAction directly.
  let st: ActionState = { log: [] }
  st = nextAction(st, 'Thinking', 1)
  st = nextAction(st, 'Ran tests', 2)
  check('nextAction: Thinking then Ran tests', st.log.length === 0 && st.current === 'Ran tests')
  st = nextAction({ log: [] }, 'Working', 1)
  check('nextAction: Working is never current', st.current === undefined && st.log.length === 0)
  st = { log: [] }
  for (let i = 1; i <= 32; i++) st = nextAction(st, `step ${i}`, i)
  check('nextAction: 32 labels keep the newest 30 finished', st.log.length === 30 && st.log[0].text === 'step 2' && st.log[29].text === 'step 31' && st.current === 'step 32', JSON.stringify(st.log.map((l) => l.text).slice(0, 3)))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
