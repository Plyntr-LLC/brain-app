import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AwayBlock } from '../../src/renderer/src/AwayBlock'
import type { FileHit } from '../../src/renderer/src/ptyChat'
import lotlinePaths from './lotline-paths.json'

const CWD = '/Users/joe/Projects/agency-brain'
const P = '/Users/joe/Projects'
const LOT = `${P}/lotline`
const LONG = `${P}/a-very-long-repository-folder-name-that-keeps-going-past-the-sidebar-x`

const files = (root: string, n: number, live = -1): FileHit[] => Array.from({ length: n }, (_, i) => ({ path: `${root}/src/f${i}.ts`, live: i === live }))
const lotHits: FileHit[] = (lotlinePaths as string[]).map((p, i) => ({ path: `${LOT}/${p}`, live: i === 4 }))

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail }) })
const tick = () => new Promise((r) => setTimeout(r, 30))

function stage(title: string): HTMLElement {
  const wrap = document.createElement('section')
  wrap.style.cssText = 'display:inline-block;vertical-align:top;margin:12px;width:220px'
  wrap.innerHTML = `<p style="font:600 12px sans-serif;margin:0 0 4px">${title}</p><aside class="explorer" style="width:220px;position:relative;display:block;border:1px solid #ddd"></aside>`
  document.getElementById('root')!.appendChild(wrap)
  return wrap.querySelector('aside') as HTMLElement
}

function mount(el: HTMLElement, hits: FileHit[]): Root {
  const r = createRoot(el)
  flushSync(() => r.render(<AwayBlock cwd={CWD} hits={hits} />))
  return r
}

const head = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.away-head')
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.away-line')]
const fileNodes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.flink')]
const name = (row: HTMLElement) => row.querySelector('.away-name')?.textContent || ''
const headText = (el: HTMLElement) => (head(el)?.querySelector('.away-title')?.textContent || '').trim()
const headCount = (el: HTMLElement) => (head(el)?.querySelector('.away-count')?.textContent || '').trim()

function oneLine(row: HTMLElement): boolean {
  const cs = getComputedStyle(row)
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
  const inner = row.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  return inner <= lh * 1.5
}

async function toggle(el: HTMLElement) {
  head(el)?.click()
  await tick()
}

async function run() {
  // 1. Two repos, one live: folded to one line, then open.
  const one = stage('1. two repos')
  mount(one, [...files(`${P}/gutter-iq`, 3), ...files(`${P}/mail-desk`, 2, 1), { path: `${CWD}/context/x.md` }])
  await tick()
  check('1 folded: one header, no repo rows', !!head(one) && rows(one).length === 0, `head=${!!head(one)} rows=${rows(one).length}`)
  check('1 header reads Also touching with 2', headText(one) === 'Also touching' && headCount(one) === '2', `${headText(one)} | ${headCount(one)}`)
  check('1 header is one line', !!head(one) && oneLine(head(one)!))
  check('1 folded header shows the live dot', head(one)?.classList.contains('live') === true)
  check('1 folded header says it is closed', head(one)?.getAttribute('aria-expanded') === 'false')
  await toggle(one)
  check('1 open: two repo rows', rows(one).length === 2, `rows=${rows(one).length}`)
  check('1 open header says it is open', head(one)?.getAttribute('aria-expanded') === 'true')
  check('1 each row one line', rows(one).every(oneLine))
  check('1 counts on rows', rows(one).map((r) => r.querySelector('.away-count')?.textContent).join(',') === '3,2', rows(one).map((r) => r.textContent).join(' | '))
  check('1 live marker only on the live repo', rows(one).map((r) => r.classList.contains('live')).join(',') === 'false,true')
  check('1 no files until a repo is opened', fileNodes(one).length === 0, `files=${fileNodes(one).length}`)

  // 2. Five repos: folded shows 5, open shows all five (no "N more"), lotline opens its files, header folds again.
  const five = [...files(`${P}/gutter-iq`, 2), ...files(`${P}/mail-desk`, 1), ...files(`${P}/plyntr-chat`, 4), ...lotHits, ...files(`${P}/mykennel`, 3)]
  const still = stage('2. five repos (folded)')
  mount(still, five)
  const two = stage('2. five repos, open + lotline')
  mount(two, five)
  await tick()
  check('2 folded: header 5, no rows', headCount(two) === '5' && rows(two).length === 0, `${headCount(two)} rows=${rows(two).length}`)
  check('2 folded: live dot from lotline', head(two)?.classList.contains('live') === true)
  check('2 no more row anywhere', !two.querySelector('.away-more'))
  await toggle(two)
  check('2 open: five repo rows, no more row', rows(two).length === 5 && !two.querySelector('.away-more'), rows(two).map((r) => r.textContent).join(' | '))
  check('2 open rows one line', rows(two).every(oneLine))
  check('2 open: still no files', fileNodes(two).length === 0)
  const lotRow = rows(two).find((r) => name(r) === 'lotline')!
  lotRow.click()
  await tick()
  const lotBox = lotRow.parentElement as HTMLElement
  const shown = fileNodes(two)
  check('2 lotline open: 26 files', shown.length === 26, `files=${shown.length}`)
  check('2 files all under lotline', shown.every((f) => f.parentElement === lotBox))
  check('2 file text is the path inside lotline', shown.map((f) => f.textContent).join('\n') === (lotlinePaths as string[]).join('\n'))
  check('2 live file keeps its live style', shown[4]?.classList.contains('live') === true && shown.filter((f) => f.classList.contains('live')).length === 1)
  check('2 other repos stay collapsed', rows(two).filter((r) => r !== lotRow).every((r) => !(r.parentElement as HTMLElement).querySelector('.flink')))
  lotRow.click()
  await tick()
  check('2 lotline again: closed', fileNodes(two).length === 0)
  await toggle(two)
  check('2 header click folds back to no rows', rows(two).length === 0 && fileNodes(two).length === 0 && headCount(two) === '5')
  await toggle(two)

  // 3. Same instance, new hits: lotline gone, a new repo collapsed, the block stays open.
  const three = stage('3. lotline dropped')
  const r3 = mount(three, [...lotHits, ...files(`${P}/gutter-iq`, 2)])
  await tick()
  await toggle(three)
  rows(three).find((r) => name(r) === 'lotline')!.click()
  await tick()
  check('3 lotline open before the swap', fileNodes(three).length === 26)
  flushSync(() => r3.render(<AwayBlock cwd={CWD} hits={[...files(`${P}/gutter-iq`, 2), ...files(`${P}/summit-ops`, 5)]} />))
  await tick()
  check('3 header count follows the hits', headCount(three) === '2', headCount(three))
  check('3 no lotline row after the swap', !rows(three).some((r) => name(r) === 'lotline'))
  check('3 new repo collapsed', fileNodes(three).length === 0 && rows(three).some((r) => name(r) === 'summit-ops'))
  check('3 no live dot when nothing is live', head(three)?.classList.contains('live') === false)

  // 4. A 70-character repo name.
  const four = stage('4. long name')
  mount(four, files(LONG, 2))
  await tick()
  await toggle(four)
  const longName = four.querySelector<HTMLElement>('.away-line .away-name')!
  check('4 long name is 70 characters', LONG.split('/').pop()!.length === 70)
  check('4 long row one line', rows(four).every(oneLine))
  check('4 long name cut with an ellipsis', longName.scrollWidth > longName.clientWidth && getComputedStyle(longName).textOverflow === 'ellipsis')

  // 5. Nothing outside the folder: no block at all.
  const five2 = stage('5. nothing outside')
  mount(five2, [{ path: `${CWD}/context/x.md` }])
  await tick()
  check('5 no block when nothing is outside the folder', !five2.querySelector('.away'))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void run().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String(e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
