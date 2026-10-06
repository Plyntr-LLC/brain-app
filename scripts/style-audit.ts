// Audits the running dev app against mockup E's style rules (scripts/render-ui/style-rules.ts) over the DevTools
// protocol. Start the app with `npm run dev -- --remoteDebuggingPort 9333`, then:
// node --experimental-strip-types scripts/style-audit.ts [outDir]
// AUDIT_INVENTORY=<file> writes the control inventory there when the file is missing, else compares against it.
// Prints STYLE_AUDIT_PASS or STYLE_AUDIT_FAIL, saves a screenshot per surface and compare.html (mockup E next to
// the Chat tab at 1440x900). Exits 1 on any violation.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { styleRules, type RuleSet, type Violation } from './render-ui/style-rules.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] || join(tmpdir(), 'brain-style-audit')
const port = process.env.AUDIT_PORT || '9333'
const inventoryFile = process.env.AUDIT_INVENTORY || join(outDir, 'inventory.json')
const W = 1440
const H = 900
mkdirSync(outDir, { recursive: true })

const targets = (await (await fetch(`http://localhost:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) throw new Error(`no app page on port ${port}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, (m: { result?: any; error?: { message: string } }) => void>()
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m)
    pending.delete(m.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
async function js<T>(expression: string): Promise<T> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value as T
}
const rules = <T = Violation[]>(which: RuleSet) => js<T>(`(${styleRules.toString()})(${JSON.stringify(which)})`)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const click = (sel: string) => js<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)
const has = (sel: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)
const tabByText = (test: string) => `[...document.querySelectorAll('.tab .tabname')].find((b) => ${test})`
const chatTab = tabByText(`/^(grok|claude|cursor|chatgpt)\\b/i.test(b.textContent.trim())`)
const factoryTab = tabByText(`b.textContent.trim() === 'Factory'`)
const sessionModel = `[...document.querySelectorAll('.runmeta .runmeta-k')].find((x) => x.textContent.trim() === 'Model')?.nextElementSibling`

const report: { surface: string; violations: Violation[]; shot: string }[] = []
async function surface(name: string, sets: RuleSet[], setup?: () => Promise<void>, teardown?: () => Promise<void>) {
  if (setup) await setup()
  await wait(500)
  const v: Violation[] = []
  for (const s of sets) v.push(...(await rules(s)))
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const shot = join(outDir, `${name}.png`)
  writeFileSync(shot, Buffer.from(r.data, 'base64'))
  report.push({ surface: name, violations: v, shot })
  if (teardown) await teardown()
  await wait(250)
}

await send('Page.enable')
try {
  if (await has('.settings')) await click('.settings-toggle')
  if (await has('.picker')) await click('.tabadd')
  if ((await js<string>(`document.documentElement.dataset.theme || 'light'`)) === 'dark') await click('.title-icon')
  if (!(await js<boolean>(`!!${chatTab}`))) throw new Error('open a Grok, Claude, Cursor or ChatGPT tab first')
  await js(`${chatTab}.click()`)

  // Native window size: the inventory is taken here. The Skin strip depends on how the terminal's rows round
  // against the window height, so it is checked across a sweep of heights at the native width.
  await surface('chat-native', ['strip'])
  const width = await js<number>('innerWidth')
  const sweep: Violation[] = []
  for (let h = 700; h <= 800 && !sweep.length; h += 4) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 0, mobile: false })
    await wait(350)
    for (const v of await rules('strip')) sweep.push({ ...v, detail: `window ${width}x${h}: ${v.detail}` })
  }
  await send('Emulation.clearDeviceMetricsOverride')
  await wait(300)
  report.push({ surface: 'skin-strip-sweep', violations: sweep, shot: report[0].shot })
  const inv = await rules<Record<string, string>>('inventory')
  if (!existsSync(inventoryFile)) {
    writeFileSync(inventoryFile, JSON.stringify(inv, null, 2))
    console.log(`inventory saved: ${inventoryFile}`)
  } else {
    const before = JSON.parse(readFileSync(inventoryFile, 'utf8')) as Record<string, string>
    const v: Violation[] = []
    for (const [k, place] of Object.entries(before)) if (inv[k] !== place) v.push({ rule: 'control-moved-or-missing', at: k, detail: `before: ${place}; now: ${inv[k] ?? 'missing'}` })
    report.push({ surface: 'inventory', violations: v, shot: report[0].shot })
  }

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await wait(600)
  await surface('chat', ['ui', 'chrome', 'session', 'strip', 'composer'])
  await surface('new-tab-picker', ['ui'], () => click('.tabadd').then(() => undefined), () => click('.tabadd').then(() => undefined))
  await surface(
    'model-picker',
    ['ui', 'picker'],
    async () => {
      if (!(await js<boolean>(`(() => { const b = ${sessionModel}; if (b) b.click(); return !!b })()`))) throw new Error('no Model button in the Session block')
    },
    () => js(`${sessionModel}?.click()`).then(() => undefined)
  )
  await surface('settings', ['ui'], () => click('.settings-toggle').then(() => wait(800)), () => click('.settings-toggle').then(() => undefined))
  await surface('factory', ['ui', 'chrome', 'session'], async () => {
    if (await js<boolean>(`!!${factoryTab}`)) await js(`${factoryTab}.click()`)
    else {
      await click('.tabadd')
      await wait(400)
      await js(`[...document.querySelectorAll('.picker button')].find((b) => b.textContent.trim() === 'Factory').click()`)
    }
    await wait(800)
    if (!(await has('.factorywrap.on'))) throw new Error('the Factory tab did not open')
  })
  await js(`${chatTab}.click()`)
  await surface('chat-dark', ['ui', 'dark', 'session'], () => click('.title-icon').then(() => wait(400)), () => click('.title-icon').then(() => undefined))
} finally {
  await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  ws.close()
}

let total = 0
for (const s of report) {
  total += s.violations.length
  const byRule = new Map<string, Violation[]>()
  for (const v of s.violations) byRule.set(v.rule, [...(byRule.get(v.rule) || []), v])
  console.log(`\n## ${s.surface}: ${s.violations.length} violation(s)  screenshot: ${s.shot}`)
  for (const [rule, list] of byRule) {
    console.log(`  ${rule} x${list.length}`)
    for (const v of list.slice(0, Number(process.env.AUDIT_SHOW || 6))) console.log(`    ${v.at}  ${v.detail}`)
  }
}
const mockShot = join(outDir, 'mock-e.png')
try {
  const mock = pathToFileURL(join(root, 'plans/mockups/20261006-factory/e-app-touchup.html')).href
  execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, '--virtual-time-budget=4000', `--screenshot=${mockShot}`, mock], { stdio: 'ignore' })
} catch {
  console.log('mockup screenshot skipped: Chrome did not run')
}
const cell = (title: string, file: string) => `<figure style="margin:0"><figcaption style="font:600 13px sans-serif;margin:0 0 6px">${title}</figcaption><img src="${pathToFileURL(file).href}" style="width:100%;border:1px solid #ccc"></figure>`
const cells = [cell('Mockup E', mockShot), ...report.filter((s) => s.surface !== 'inventory').map((s) => cell(`App: ${s.surface}`, s.shot))]
writeFileSync(join(outDir, 'compare.html'), `<!doctype html><meta charset="utf-8"><title>Mockup E vs app</title><body style="margin:16px;background:#f3eee8"><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${cells.join('')}</div></body>`)
console.log(`\n${total === 0 ? 'STYLE_AUDIT_PASS' : 'STYLE_AUDIT_FAIL'} (${total} violation(s) on ${report.length} surfaces)\ncompare: ${join(outDir, 'compare.html')}`)
process.exit(total === 0 ? 0 : 1)
