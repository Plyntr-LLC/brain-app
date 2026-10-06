import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { ActivityRail } from '../../src/renderer/src/ActivityRail'
import { SessionCard, type SessionRow } from '../../src/renderer/src/SessionCard'
import type { Activity, RailState } from '../../src/renderer/src/activity'

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const CWD = '/Users/joe/Projects/agency-brain'
const t0 = Date.now()

const steps = Array.from({ length: 12 }, (_, i) => ({ title: `Step ${i + 1}: do the next part of the report`, state: (i < 4 ? 'done' : i === 4 ? 'live' : 'todo') as RailState }))
const log = Array.from({ length: 30 }, (_, i) => ({ at: t0 - (30 - i) * 60000, text: `Read clients/summit/file-${i + 1}.md` }))
const chat: Activity = {
  now: { text: 'Writing clients/summit/reports/2026-10-06.html', since: t0 - 42000, tone: 'live' },
  steps,
  log,
  files: Array.from({ length: 20 }, (_, i) => ({ path: `${CWD}/clients/summit/f${i + 1}.md` })),
  filesFolded: true
}
const factory: Activity = {
  runId: 'run-1',
  now: { text: 'Waiting on you: push when ready', tone: 'ask' },
  progress: ['Plan', 'Build', 'Test', 'Review', 'Push'].map((label, i) => ({ label, state: (i < 4 ? 'done' : 'ask') as RailState, note: i < 4 ? 'done' : 'waiting on you' })),
  team: ['Lead', 'Planner', 'Builder', 'Tester', 'Reviewer'].map((role) => ({ role, who: 'Grok 4.6', state: 'done' as RailState, note: 'done' })),
  log,
  files: Array.from({ length: 26 }, (_, i) => ({ path: `components/dealer/file-${i + 1}.ts`, added: 10 + i, deleted: i % 3 })),
  ship: { line: 'main → origin', block: null, pushed: false, deploy: 'Vercel deploys production' }
}

function Column({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState<string | null>(null)
  const rows: SessionRow[] = [
    { key: 'model', label: 'Model', value: 'Grok 4.7', choices: [{ id: 'grok-4.7', label: 'Grok 4.7', on: true }, { id: 'grok-4.6', label: 'Grok 4.6', on: false }], onChoose: () => setOpen(null) },
    { key: 'effort', label: 'Effort', value: 'High', choices: [{ id: 'high', label: 'High', on: true }, { id: 'xhigh', label: 'Extra high', on: false }], onChoose: () => setOpen(null) },
    { key: 'context', label: 'Context', value: '38%' },
    { key: 'folder', label: 'Folder', value: 'agency-brain', title: CWD, choices: [{ id: CWD, label: 'agency-brain', on: true }], onChoose: () => setOpen(null), extra: { label: 'Choose folder…', onClick: () => setOpen(null) } }
  ]
  return (
    <aside className="refs">
      <ActivityRail activity={activity} onPush={() => undefined} openFile={{ open: () => undefined, canOpen: () => true }} />
      <SessionCard rows={rows} open={open} setOpen={setOpen} />
    </aside>
  )
}

function mount(title: string, activity: Activity): HTMLElement {
  const wrap = document.createElement('section')
  wrap.className = 'rail-stage'
  wrap.innerHTML = `<p class="rail-stage-title">${title}</p><div class="rail-stage-col"></div>`
  document.getElementById('root')!.appendChild(wrap)
  const col = wrap.querySelector('.rail-stage-col') as HTMLElement
  flushSync(() => createRoot(col).render(<Column activity={activity} />))
  return col.querySelector('.refs') as HTMLElement
}

const within = (r: DOMRect, box: DOMRect) => r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5
const section = (refs: HTMLElement, cls: string) => refs.querySelector<HTMLElement>(`.rail-box.${cls}`)
const body = (refs: HTMLElement, cls: string) => section(refs, cls)?.querySelector<HTMLElement>('.rail-body') || null
const header = (sec: HTMLElement) => sec.querySelector<HTMLElement>('h5')
function rowHeight(b: HTMLElement): number {
  const row = b.firstElementChild as HTMLElement | null
  return row ? row.getBoundingClientRect().height : 0
}

function shared(name: string, refs: HTMLElement) {
  const box = refs.getBoundingClientRect()
  const sections = [...refs.querySelectorAll<HTMLElement>('.rail-box')]
  check(`${name}: every section header inside the column`, sections.length > 0 && sections.every((s) => !!header(s) && within(header(s)!.getBoundingClientRect(), box)), sections.map((s) => `${s.className} ${Math.round(header(s)?.getBoundingClientRect().top || -1)}`).join(' | '))
  const nowBox = section(refs, 'rail-now')
  check(`${name}: Now fully inside`, !!nowBox && within(nowBox.getBoundingClientRect(), box))
  const meta = refs.querySelector<HTMLElement>('.runmeta')
  const keyed = (k: string) => [...(meta?.querySelectorAll('.runmeta-k') || [])].find((x) => (x.textContent || '').trim() === k)?.nextElementSibling as HTMLElement | undefined
  check(`${name}: the Session card shows every row uncut`, !!meta && meta.scrollHeight <= meta.clientHeight + 1, meta ? `${meta.scrollHeight} > ${meta.clientHeight}` : 'no card')
  for (const k of ['Model', 'Effort']) {
    const b = keyed(k)
    check(`${name}: Session ${k} button fully inside`, b?.tagName === 'BUTTON' && within(b.getBoundingClientRect(), box) && within(b.getBoundingClientRect(), meta!.getBoundingClientRect()), JSON.stringify(b?.getBoundingClientRect()))
    // Only the page scrolls here, never the column, so a button clipped inside the column stays clipped.
    if (b) window.scrollTo(0, window.scrollY + b.getBoundingClientRect().top - 100)
    const r = b?.getBoundingClientRect()
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
    window.scrollTo(0, 0)
    check(`${name}: Session ${k} button is what a click there hits`, !!b && !!hit && (hit === b || b.contains(hit)), hit ? `${hit.tagName}.${hit.className}` : 'nothing')
  }
  const rail = refs.querySelector<HTMLElement>('.activity-rail')!
  check(`${name}: the column is not a second scroller`, rail.scrollHeight <= rail.clientHeight + 1, `${rail.scrollHeight} > ${rail.clientHeight}`)
}

function tall(name: string, refs: HTMLElement, classes: string[], long: string[]) {
  for (const cls of classes) {
    const b = body(refs, cls)
    check(`${name}: ${cls} body shows at least two rows`, !!b && b.clientHeight >= 2 * rowHeight(b) - 1, b ? `${b.clientHeight} < 2 × ${rowHeight(b)}` : 'no body')
  }
  for (const cls of long) {
    const b = body(refs, cls)
    check(`${name}: ${cls} body scrolls on its own`, !!b && b.scrollHeight > b.clientHeight, b ? `${b.scrollHeight} <= ${b.clientHeight}` : 'no body')
  }
}

async function apart(name: string, refs: HTMLElement, bottom: string, middle: string) {
  const rail = refs.querySelector<HTMLElement>('.activity-rail')!
  const bodies = [...refs.querySelectorAll<HTMLElement>('.rail-body')]
  const heads = [...refs.querySelectorAll<HTMLElement>('.rail-box h5')].map((h) => h.getBoundingClientRect().top)
  const a = body(refs, bottom)!
  const b = body(refs, middle)!
  a.scrollTop = a.scrollHeight
  b.scrollTop = Math.floor((b.scrollHeight - b.clientHeight) / 2)
  await tick()
  check(`${name}: ${bottom} scrolled to its bottom`, a.scrollTop > 0 && Math.abs(a.scrollTop + a.clientHeight - a.scrollHeight) <= 1, `${a.scrollTop}`)
  check(`${name}: ${middle} scrolled to its middle`, b.scrollTop > 0 && b.scrollTop + b.clientHeight < b.scrollHeight - 1, `${b.scrollTop}`)
  check(`${name}: every other body stays at the top`, bodies.filter((x) => x !== a && x !== b).every((x) => x.scrollTop === 0), bodies.map((x) => x.scrollTop).join(','))
  check(`${name}: the column did not scroll`, rail.scrollTop === 0 && refs.scrollTop === 0, `${rail.scrollTop} ${refs.scrollTop}`)
  const after = [...refs.querySelectorAll<HTMLElement>('.rail-box h5')].map((h) => h.getBoundingClientRect().top)
  check(`${name}: every header stayed put`, JSON.stringify(after) === JSON.stringify(heads), `${heads.join(',')} -> ${after.join(',')}`)
}

async function main() {
  const layout = document.createElement('style')
  layout.textContent = 'body{margin:0}.rail-stage{display:inline-block;vertical-align:top;margin:12px}.rail-stage-title{font:600 12px sans-serif;margin:0 0 4px}.rail-stage-col{width:300px;height:760px;display:flex;border:1px solid #ccc}.rail-stage-col>.refs{flex:1}'
  document.head.appendChild(layout)

  const c = mount('Chat, crowded', chat)
  await tick()
  section(c, 'rail-files')?.querySelector<HTMLButtonElement>('.rail-fold')?.click()
  await tick()
  section(c, 'rail-files')?.querySelector<HTMLButtonElement>('.rail-more')?.click()
  await tick(80)
  check('chat: all 20 files listed', c.querySelectorAll('.rail-files .rail-file').length === 20, String(c.querySelectorAll('.rail-files .rail-file').length))
  shared('chat', c)
  tall('chat', c, ['rail-steps', 'rail-log', 'rail-files'], ['rail-log', 'rail-files'])
  await apart('chat', c, 'rail-log', 'rail-files')

  const f = mount('Factory, crowded', factory)
  await tick(80)
  section(f, 'rail-files')?.querySelector<HTMLButtonElement>('.rail-more')?.click()
  await tick(80)
  check('factory: all 26 changed files listed', f.querySelectorAll('.rail-files .rail-file').length === 26, String(f.querySelectorAll('.rail-files .rail-file').length))
  shared('factory', f)
  tall('factory', f, ['rail-progress', 'rail-team', 'rail-files', 'rail-log'], ['rail-files', 'rail-log'])
  const ship = section(f, 'rail-ship')
  const push = [...(ship?.querySelectorAll('button') || [])].find((x) => (x.textContent || '').trim() === 'Push')
  check('factory: Ship fully inside', !!ship && within(ship.getBoundingClientRect(), f.getBoundingClientRect()))
  check('factory: Push fully inside', !!push && within(push.getBoundingClientRect(), f.getBoundingClientRect()))
  await apart('factory', f, 'rail-files', 'rail-log')

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String(e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
