import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatPane } from '../../src/renderer/src/TerminalWorkspace'
import { TitleBar } from '../../src/renderer/src/TitleBar'

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
    if (name === 'chat.send') return Promise.resolve({ ok: true })
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}
;(window as unknown as { brain: unknown }).brain = bridge([])

// A fake clock: thought times come from Date.now.
let clock = 1_800_000_000_000
Date.now = () => clock

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const CWD = '/Users/joe/Projects/agency-brain'
const ID = 'chat-1'
const noop = () => undefined

let pane: HTMLElement
const thread = () => pane.querySelector<HTMLElement>('.skin-thread')!
const box = () => pane.querySelector<HTMLTextAreaElement>('.composer textarea')!
const emit = (ev: Record<string, unknown>) => flushSync(() => chatListeners.forEach((l) => l({ tabId: ID, ...ev })))
const chip = (name: string) => [...thread().querySelectorAll<HTMLElement>('.skin-tool')].find((c) => (c.querySelector('.p')?.textContent || '') === name)
const style = (el: Element | null | undefined) => (el ? getComputedStyle(el) : ({} as CSSStyleDeclaration))
const boxed = (el: Element | null | undefined) => !!el && style(el).backgroundColor !== 'rgba(0, 0, 0, 0)' && style(el).borderTopWidth !== '0px' && style(el).borderTopStyle !== 'none'
async function send(text: string) {
  const el = box()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick(80)
}

async function main() {
  const layout = document.createElement('style')
  layout.textContent = 'body{margin:0}.look-stage{display:flex;flex-direction:column;width:1440px;height:900px}.look-chat{position:relative;flex:1;min-height:0;width:880px;margin:0 auto;display:flex;flex-direction:column;border-left:1px solid var(--line);border-right:1px solid var(--line)}.look-dark{display:none}'
  document.head.appendChild(layout)
  const themeCalls: string[] = []
  const stage = document.createElement('div')
  stage.className = 'look-stage'
  const bars = document.createElement('div')
  const dark = document.createElement('div')
  dark.className = 'look-dark'
  pane = document.createElement('div')
  pane.className = 'look-chat'
  stage.append(bars, pane, dark)
  document.getElementById('root')!.appendChild(stage)
  const bar = (theme: 'light' | 'dark') => (
    <TitleBar
      title="agency-brain"
      role="owner"
      account=""
      sync={{ ok: true, line: 'Synced 2 min ago' }}
      watching
      discardNote=""
      onDiscard={noop}
      theme={theme}
      setTheme={(t) => themeCalls.push(`${theme}->${t}`)}
      showLogout
      onLogout={noop}
      settingsOpen={false}
      onSettings={noop}
    />
  )
  createRoot(bars).render(bar('light'))
  createRoot(dark).render(bar('dark'))
  createRoot(pane, { onUncaughtError: (e) => check('render error', false, String((e as Error)?.stack || e)) }).render(
    <ChatPane id={ID} kind="grok" cwd={CWD} sessionId="s1" active greeting="Hi." onFiles={noop} onNew={noop} onModel={noop} onEffort={noop} onCaps={noop} onTranscript={noop} onContext={noop} onApprove={noop} onRename={noop} onResume={noop} onFork={noop} onAgentMode={noop} onDelete={noop} onOpenTerm={noop} onBusy={noop} onActivity={noop} />
  )
  await tick(150)
  check('the chat mounts', !!box())

  // Title bar, both themes
  for (const [root, theme, label] of [[bars, 'light', 'Dark mode'], [dark, 'dark', 'Light mode']] as const) {
    const icon = root.querySelector<HTMLButtonElement>('.titlebar .title-icon')
    check(`title bar (${theme}): the theme icon is named "${label}"`, icon?.getAttribute('aria-label') === label && icon?.title === label && (icon?.textContent || '').trim() === '◐', icon?.outerHTML || 'none')
    icon?.click()
    const names = [...root.querySelectorAll('.titlebar button')].map((b) => (b.textContent || '').trim())
    check(`title bar (${theme}): sync pill, Log out and Settings stay`, !!root.querySelector('.titlebar .sync-pill') && names.includes('Log out') && names.includes('Settings'), names.join(','))
  }
  check('title bar: a click calls the theme setter', themeCalls.join(' ') === 'light->dark dark->light', themeCalls.join(' '))

  // Turn 1
  const T0 = clock
  await send('What is the goal for Maple Street Bakery?')
  emit({ kind: 'thought', data: 'Reading the client file first.' })
  await tick()
  const folds = () => [...thread().querySelectorAll<HTMLButtonElement>('.skin-activity > .think-label')]
  check('turn 1: a live thought is one collapsed line, "Thinking · show"', folds()[0]?.textContent === 'Thinking · show' && !thread().querySelector('.think-body'), folds()[0]?.textContent || 'none')
  clock = T0 + 2000
  emit({ kind: 'thought', data: ' Then the weekly-report skill.' })
  for (const p of ['clients/maple/context.md', 'skills/weekly-report/SKILL.md', 'clients/maple/notes.md']) emit({ kind: 'file', path: `${CWD}/${p}`, tool: 'Read' })
  clock = T0 + 2500
  emit({ kind: 'thought', data: 'second look' })
  await tick()
  check('turn 1: thinking and the file steps stay one closed row', folds().length === 1 && folds()[0]?.textContent === 'Thinking · 3 files · show' && !thread().querySelector('.skin-tool'), folds()[0]?.textContent || 'none')
  folds()[0]?.click()
  await tick()
  check('turn 1: opening that row shows the later thought and a live chip', (thread().textContent || '').includes('second look') && !!thread().querySelector('.skin-chips .skin-tool.live'))
  folds()[0]?.click()
  await tick()
  const cols = Array.from({ length: 20 }, (_, i) => `Column ${i + 1}`)
  const table = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n| ${cols.map((_, i) => `value ${i + 1}`).join(' | ')} |`
  emit({ kind: 'text', data: `Maple Street Bakery's goal is **20 catering inquiries a month**.\n\nThis week's update should be five short lines.\n\n${table}\n\n\`\`\`\n${'x'.repeat(400)}\n\`\`\`\n` })
  emit({ kind: 'file', path: `${CWD}/clients/maple/log.md`, tool: 'Read' })
  emit({ kind: 'done' })
  await tick(80)

  const avatarsAfter1 = thread().querySelectorAll('.skin-avatar').length
  const first = folds()[0]
  const later = folds()[1]
  check('turn 1: the finished run reads "Thought for 2 s · 3 files · show"', first?.textContent === 'Thought for 2 s · 3 files · show', first?.textContent || 'none')
  check('turn 1: the file after the answer is its own closed row', later?.textContent === '1 file · show' && !thread().querySelector('.skin-tool'), later?.textContent || 'none')
  check('turn 1: the closed row is under 30px tall', !!first && first.getBoundingClientRect().height < 30, String(first?.getBoundingClientRect().height))
  first?.click()
  later?.click()
  await tick()
  const c1 = chip('context.md')!
  const c2 = chip('SKILL.md')!
  const c3 = chip('notes.md')!
  const c4 = chip('log.md')!
  check('turn 1: the first three chips share one row', !!c1 && c1.closest('.skin-chips') === c2?.closest('.skin-chips') && c2?.closest('.skin-chips') === c3?.closest('.skin-chips') && c1.offsetTop === c2.offsetTop && c2.offsetTop === c3.offsetTop, [c1, c2, c3].map((c) => c?.offsetTop).join(','))
  check('turn 1: the chip after the answer is in another row, lower', !!c4 && c4.closest('.skin-chips') !== c1.closest('.skin-chips') && c4.getBoundingClientRect().top !== c1.getBoundingClientRect().top, `${c4?.getBoundingClientRect().top} ${c1?.getBoundingClientRect().top}`)
  check('turn 1: after done no chip is live', !thread().querySelector('.skin-tool.live'))
  check('turn 1: opening the row shows its thinking', (first?.parentElement?.textContent || '').includes('weekly-report skill'))
  first?.click()
  await tick()

  const answer = [...thread().querySelectorAll<HTMLElement>('.skin-row .bubble.md')].find((b) => b.querySelector('table'))
  const a = style(answer)
  check('answer: no grey box', !!answer && a.backgroundColor === 'rgba(0, 0, 0, 0)' && (a.borderTopStyle === 'none' || a.borderTopWidth === '0px'), `${a.backgroundColor} ${a.borderTopStyle} ${a.borderTopWidth}`)
  check('answer: 14.5px on a 1.55 line', a.fontSize === '14.5px' && a.lineHeight === '22.475px', `${a.fontSize} ${a.lineHeight}`)
  check('answer: the wide table and long code line stay inside the thread', thread().scrollWidth <= thread().clientWidth, `${thread().scrollWidth} > ${thread().clientWidth}`)
  const me = thread().querySelector<HTMLElement>('.bubble.me')
  check('your message stays a right-aligned bubble', style(me).alignSelf === 'flex-end' && boxed(me), `${style(me).alignSelf} ${style(me).backgroundColor} ${style(me).borderTopWidth}`)

  // Turn 2
  clock = T0 + 60_000
  await send('Draft the update.')
  emit({ kind: 'file', path: `${CWD}/clients/maple/draft.md`, tool: 'Edit' })
  emit({ kind: 'permission', title: 'Edit draft.md', path: `${CWD}/clients/maple/draft.md`, options: [{ id: 'allowOnce', label: 'Allow' }, { id: 'skip', label: 'Skip' }] })
  emit({ kind: 'error', data: 'The CLI stopped before it finished.' })
  await tick(80)
  const draftRow = folds()[2]
  draftRow?.click()
  await tick()
  const c5 = chip('draft.md')
  check("turn 2: its chip sits in a row of its own", !!c5 && ![c1, c4].some((c) => c.closest('.skin-chips') === c5.closest('.skin-chips')), c5 ? 'shared' : 'missing')
  const avatars = [...thread().querySelectorAll<HTMLElement>('.skin-avatar')]
  check('two avatars, one per turn, on the first row after your message', avatars.length === 2 && avatarsAfter1 === 1 && avatars.every((av) => av.closest('.skin-row')?.previousElementSibling?.classList.contains('skin-user-turn')), `${avatars.length} ${avatars.map((av) => av.closest('.skin-row')?.previousElementSibling?.className).join(' | ')}`)
  check('avatars read G for Grok', avatars.every((av) => (av.textContent || '') === 'G'))
  check('no avatar on your own message', !thread().querySelector('.bubble.me .skin-avatar'))
  const perm = thread().querySelector<HTMLElement>('.skin-perm')
  check('the permission ask keeps its box and buttons', boxed(perm) && [...(perm?.querySelectorAll('button') || [])].map((b) => b.textContent).join(',') === 'Allow,Skip')
  const err = [...thread().querySelectorAll<HTMLElement>('.bubble')].find((b) => (b.textContent || '').includes('The CLI stopped'))
  check('the error keeps its box', boxed(err), `${style(err).backgroundColor} ${style(err).borderTopWidth}`)

  // Quiet notices: a compact note and a plain system line read as one muted line, not a "Command" box.
  emit({ kind: 'status', data: 'compacting' })
  emit({ kind: 'status', data: 'compacted' })
  emit({ kind: 'status', data: 'compacting' })
  emit({ kind: 'done' })
  await tick(80)
  const inner = (text: string) =>
    [...thread().querySelectorAll<HTMLElement>('div, p, span')].filter((el) => (el.textContent || '').includes(text)).pop()
  for (const text of ['Older turns were summarized', 'This CLI did not compact this session']) {
    const el = inner(text)
    const row = el?.closest<HTMLElement>('.skin-row') || el
    const cs = style(el)
    check(`notice "${text}": 12px muted line`, !!el && cs.fontSize === '12px' && cs.color === getComputedStyle(document.documentElement).getPropertyValue('--muted').trim().replace(/^#(..)(..)(..)$/, (_m, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`), `${cs.fontSize} ${cs.color}`)
    const boxedUp = (() => {
      for (let e: HTMLElement | null = el || null; e && e !== thread(); e = e.parentElement) if (boxed(e)) return e.className
      return ''
    })()
    check(`notice "${text}": no box around it`, !!el && !boxedUp, boxedUp)
    check(`notice "${text}": no "Command" label`, !!row && !(row.textContent || '').includes('Command'), row?.textContent || 'none')
  }

  box().blur()
  window.scrollTo(0, 0)
  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
