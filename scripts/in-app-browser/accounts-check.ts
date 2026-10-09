// Runs under Electron (see scripts/check-whatsapp-accounts.ts). Phase 1 is the whole check; phase 2 only proves each
// WhatsApp account's login from phase 1 is still its own after a restart on the same userData.
import './set-paths.ts'
import { app, BaseWindow, nativeImage, session, type Session, type WebContents, type WebContentsView } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { BROWSER_RULE } from '../../src/shared/chat-reach.ts'
import { closeShared, faceShared, openSharedPage, sharedDeskBrowser } from '../../src/main/shared-browser.ts'
import { startPageTurn } from '../../src/main/desk/page-lane.ts'
import { bridgeScriptPath, browserServer, startBrowserBridge, stopBrowserBridge } from '../../src/main/browser-bridge.ts'

const ROOT = process.env.BB_ROOT || process.cwd()
const PHASE = process.env.BB_PHASE || '1'
const TRACE = process.env.BB_TRACE || join(ROOT, 'plans', '20261009-whatsapp-accounts-check.txt')
const userData = app.getPath('userData')
const partitionsDir = join(userData, 'Partitions')
if (PHASE === '1') writeFileSync(TRACE, `whatsapp accounts check ${new Date().toISOString()} userData ${userData}\n`)

const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 240)})` : ''}`)
  if (!ok) throw new Fail(name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([work, new Promise<never>((_, no) => (t = setTimeout(() => no(new Fail(`${what} passed ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t))
}

const SHARED = 'persist:brain-browser'
const INDIA = 'persist:brain-wa-india'

// The stand-in for web.whatsapp.com. Each partition remembers who it was linked as, in its own localStorage.
// The page colour says who: personal green, india orange, nobody white.
const STAND_IN = (qr: boolean) => `<!doctype html><title>WhatsApp</title><h1>WhatsApp stand-in</h1>
<p id="who"></p>
<input id="name" placeholder="Link name" aria-label="Link name" style="font-size:20px">
<button id="link">Link</button>
<button id="buy">Buy now</button><p id="bought">not bought</p>
<button id="notif">Ask notifications</button><p id="perm">perm:</p>
<a href="/file.txt">Download file</a>
${qr ? '<canvas aria-label="Scan this QR code to link a device!" width="200" height="200" style="display:block;background:#000"></canvas>' : ''}
<script>
const paint = () => {
  const who = localStorage.linked || 'nobody'
  document.getElementById('who').textContent = 'Linked as: ' + who
  document.body.style.background = who === 'personal' ? '#00aa00' : who === 'india' ? '#ff8800' : '#ffffff'
}
paint()
document.getElementById('link').onclick = () => { localStorage.linked = document.getElementById('name').value; paint() }
document.getElementById('buy').onclick = () => { document.getElementById('bought').textContent = 'bought' }
document.getElementById('notif').onclick = () => Notification.requestPermission().then((r) => { document.getElementById('perm').textContent += ' notif:' + r })
</script>`

app.on('session-created', (ses: Session) => {
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url)
    if (u.hostname !== 'web.whatsapp.com') return fetch(req)
    if (u.pathname === '/file.txt') return new Response('downloaded from the stand-in', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="wa-file.txt"' } })
    return new Response(STAND_IN(u.searchParams.has('qr')), { headers: { 'content-type': 'text/html' } })
  })
})

const PAGES: Record<string, string> = {
  '/form': '<!doctype html><title>Form page</title><h1>Purple Walrus 42</h1><a href="/next" style="display:inline-block;margin:30px;padding:20px">Next page</a><script>document.cookie = "brain=1; max-age=3600; path=/"</script>',
  '/next': '<!doctype html><title>Next</title><h1>Next page</h1><p>You arrived.</p>',
  '/cookie': '<!doctype html><title>Cookie</title><h1>Cookie page</h1><p id="c"></p><script>document.getElementById("c").textContent = "cookies: " + (document.cookie || "none")</script>'
}
function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const body = PAGES[(req.url || '/').split('?')[0]]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
    res.end(body || 'not found')
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}

type Mcp = { call: (method: string, params?: unknown) => Promise<any>; kill: () => void }
async function mcpFor(owner: string): Promise<Mcp> {
  const spec = browserServer(owner)
  if (!spec) throw new Fail('bridge not running')
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  let id = 0
  const waiting = new Map<number, (m: any) => void>()
  child.stdout!.on('data', (d) => {
    buf += d
    let n
    while ((n = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, n))
      buf = buf.slice(n + 1)
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  const mcp: Mcp = {
    call: (method, params) =>
      new Promise((done) => {
        const i = ++id
        waiting.set(i, done)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
      }),
    kill: () => child.kill()
  }
  await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
  return mcp
}
type ToolOut = { text: string; isError: boolean }
async function tool(mcp: Mcp, name: string, args: Record<string, unknown> = {}, ms = 45_000): Promise<ToolOut> {
  const m = await deadline(mcp.call('tools/call', { name, arguments: args }), ms, name)
  const content = (m?.result?.content || []) as { type: string; text?: string }[]
  return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!m?.result?.isError }
}
const WA = 'https://web.whatsapp.com/'
const openWa = (mcp: Mcp, account?: string, url = WA) => tool(mcp, 'browser_open', account === undefined ? { url } : { url, account })

function views(): WebContents[] {
  return BaseWindow.getAllWindows()
    .flatMap((w) => (w.isDestroyed() ? [] : (w.contentView.children as WebContentsView[])))
    .map((v) => v.webContents)
    .filter((wc) => wc && !wc.isDestroyed())
}
const onWhatsApp = (wc: WebContents) => {
  try {
    return new URL(wc.getURL()).hostname === 'web.whatsapp.com'
  } catch {
    return false
  }
}
const waViews = () => views().filter(onWhatsApp)
const inPartition = (wc: WebContents, partition: string) => wc.session === session.fromPartition(partition)
const waIn = (partition: string) => waViews().filter((wc) => inPartition(wc, partition))
const one = (partition: string, what: string) => {
  const all = waIn(partition)
  check(`${what}: exactly one WhatsApp window on ${partition}`, all.length === 1, String(all.length))
  return all[0]
}
const linked = (wc: WebContents) => wc.executeJavaScript('localStorage.linked || "nobody"') as Promise<string>
const partitionFolders = () => (existsSync(partitionsDir) ? readdirSync(partitionsDir).sort() : [])

/** The colour at the middle of the page in a base64 jpeg. */
function centre(b64: string | null): { r: number; g: number; b: number } {
  const img = nativeImage.createFromBuffer(Buffer.from(b64 || '', 'base64'))
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const i = (Math.floor(height * 0.8) * width + Math.floor(width / 2)) * 4
  return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] }
}
const isGreen = (c: { r: number; g: number; b: number }) => c.g > 140 && c.r < 80 && c.b < 80
const isOrange = (c: { r: number; g: number; b: number }) => c.r > 200 && c.g > 90 && c.g < 180 && c.b < 80

async function phaseOne() {
  const { server, base } = await serve()
  await startBrowserBridge({ dir: userData, script: bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser: sharedDeskBrowser(), onOpened: () => {} })
  const A = await mcpFor('chat:A')
  const B = await mcpFor('chat:B')
  const C = await mcpFor('chat:C')

  const listed = await A.call('tools/list')
  const tools = (listed?.result?.tools || []) as { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[]
  const open = tools.find((t) => t.name === 'browser_open')
  const close = tools.find((t) => t.name === 'browser_close')
  const acc = open?.inputSchema?.properties?.account
  const says = (text: string) => /leave (it|account) out for the main WhatsApp/i.test(text) && /such as india/i.test(text) && /new name shows a QR/i.test(text)
  check('1c browser_open has an account property', !!acc)
  check('1c browser_open says how to pick an account', says(open?.description || ''), open?.description)
  check('1c the account schema says how to pick an account', says(acc?.description || ''), acc?.description)
  check('1c BROWSER_RULE says how to pick an account', /leave the account of browser_open out for the main WhatsApp/i.test(BROWSER_RULE) && /such as india/i.test(BROWSER_RULE) && /new name shows a QR/i.test(BROWSER_RULE), BROWSER_RULE)
  check('1c browser_close says WhatsApp windows stay open', /WhatsApp windows stay open/i.test(close?.description || ''), close?.description)

  const m1 = await openWa(A)
  check('1 main opens the stand-in, not linked yet', !m1.isError && /Linked as: nobody/.test(m1.text), m1.text)
  check('1 the accounts line names main', /WhatsApp account on screen: main\. Accounts on this computer: main\./.test(m1.text), m1.text)
  const main = one(SHARED, '1')
  const mainId = main.id
  await tool(A, 'browser_type', { target: 'Link name', text: 'personal' })
  const l1 = await tool(A, 'browser_click', { target: 'Link' })
  check('1 main is linked as personal', /Linked as: personal/.test(l1.text), l1.text)

  for (const name of ['main', 'MAIN', ' main ']) {
    const r = await openWa(A, name)
    const wc = waIn(SHARED)
    check(`1b account "${name}" is the main window on ${SHARED}`, !r.isError && /Linked as: personal/.test(r.text) && wc.length === 1 && wc[0].id === mainId, `${r.text.slice(0, 80)} ids ${wc.map((w) => w.id)}`)
  }
  check('1b no brain-wa-main folder', !partitionFolders().includes('brain-wa-main'), partitionFolders().join(','))

  const q = await openWa(A, undefined, `${WA}?qr=1`)
  check('1c a WhatsApp QR page is a sign-in and still carries the accounts line', /wants a sign-in/.test(q.text) && /WhatsApp account on screen: main\./.test(q.text), q.text)

  const i1 = await openWa(A, ' India ')
  check('2 " India " opens a WhatsApp nobody linked yet', !i1.isError && /Linked as: nobody/.test(i1.text), i1.text)
  const india = one(INDIA, '2')
  const indiaId = india.id
  check('2 the india window is not the main window', indiaId !== mainId)
  check('2 the partition folder brain-wa-india exists', existsSync(join(partitionsDir, 'brain-wa-india')), partitionFolders().join(','))
  await tool(A, 'browser_type', { target: 'Link name', text: 'india' })
  await tool(A, 'browser_click', { target: 'Link' })
  const i2 = await tool(A, 'browser_read')
  check('2 a read after the open acts on the india window (F4)', /Linked as: india/.test(i2.text), i2.text)
  check('2 the accounts line names india on screen and lists main, india', /WhatsApp account on screen: india\. Accounts on this computer: main, india\./.test(i1.text), i1.text)
  const i3 = await openWa(A, 'india')
  check('2 reopening india names it on screen with main, india listed', /WhatsApp account on screen: india\. Accounts on this computer: main, india\./.test(i3.text), i3.text)

  check('3 main is still linked as personal', (await linked(main)) === 'personal')

  const m2 = await openWa(A)
  check('4 no account brings back main, linked as personal', /Linked as: personal/.test(m2.text), m2.text)
  check('4 exactly two WhatsApp windows', waViews().length === 2, String(waViews().length))

  await openWa(A, 'india', `${WA}send?phone=15551212`)
  check('4b a send address with india lands in the india window', india.getURL().includes('send?phone=15551212') && waIn(INDIA).length === 1 && waIn(INDIA)[0].id === indiaId, india.getURL())
  await openWa(A, undefined, `${WA}send?phone=15551212`)
  check('4b the same address with no account lands in main on the shared partition', main.getURL().includes('send?phone=15551212') && inPartition(main, SHARED) && waIn(SHARED)[0].id === mainId, main.getURL())

  const b1 = await openWa(B, 'INDIA')
  check('5 chat B opening INDIA shares the india window (F1, F9)', /Linked as: india/.test(b1.text) && waIn(INDIA).length === 1 && waIn(INDIA)[0].id === indiaId, b1.text)

  const held = startPageTurn('wa:india')
  await held.promise
  let navigated = 0
  const onNav = () => navigated++
  india.on('did-start-navigation', onNav)
  let bDone = false
  const bOpen = openWa(B, 'india').then((r) => {
    bDone = true
    return r
  })
  const t0 = Date.now()
  const c1 = await openWa(C)
  const cMs = Date.now() - t0
  await sleep(1500)
  check('5b while the india lane is held, the main WhatsApp opens', !c1.isError && /Linked as: personal/.test(c1.text) && cMs < 10_000, `${cMs} ms ${c1.text.slice(0, 60)}`)
  check('5b while the india lane is held, chat B\'s india open waits and the india window does not navigate', !bDone && navigated === 0, `done ${bDone} navigations ${navigated}`)
  held.release()
  const b2 = await bOpen
  india.off('did-start-navigation', onNav)
  check('5b after the release, chat B\'s india open finishes', /Linked as: india/.test(b2.text), b2.text)

  const before = partitionFolders().join(',')
  const viewsBefore = views().length
  const bad1 = await openWa(A, '../x')
  const bad2 = await openWa(A, 'a/b')
  check('6 account ../x and a/b are refused and open nothing', bad1.isError && bad2.isError && views().length === viewsBefore && partitionFolders().join(',') === before, `${bad1.text} | ${bad2.text} | ${partitionFolders().join(',')}`)
  const shownBefore = await tool(A, 'browser_read')
  const off = await tool(A, 'browser_open', { url: `${base}/form`, account: 'india' })
  const shownAfter = await tool(A, 'browser_read')
  check('6 an account with another address is refused, nothing opens, the chat keeps its page (F3)', off.isError && views().length === viewsBefore && /Linked as: personal/.test(shownBefore.text) && shownAfter.text === shownBefore.text, `${off.text} | ${shownAfter.text.slice(0, 80)}`)

  await openWa(A, 'india')
  const ua = (await india.executeJavaScript('navigator.userAgent')) as string
  check('7 the india partition sends a Chrome user agent (F8)', /Chrome\//.test(ua) && !/Electron/.test(ua), ua)
  await tool(A, 'browser_click', { target: 'Ask notifications' })
  await sleep(500)
  const perm = await tool(A, 'browser_read')
  check('7 a permission prompt on india is denied', /notif:denied/.test(perm.text), perm.text)
  const saved: { state: string; path: string }[] = []
  session.fromPartition(INDIA).on('will-download', (_e, item) => item.once('done', (_d, state) => saved.push({ state, path: item.getSavePath() })))
  await tool(A, 'browser_click', { target: 'Download file' })
  const t1 = Date.now()
  while (!saved.length && Date.now() - t1 < 10_000) await sleep(200)
  check('7 a download on india saves to Downloads with no dialog', saved.length === 1 && saved[0].state === 'completed' && saved[0].path === join(app.getPath('downloads'), 'wa-file.txt'), JSON.stringify(saved))

  const f1 = await tool(A, 'browser_open', { url: `${base}/form` })
  const n1 = await tool(A, 'browser_click', { target: 'Next page' })
  const formWc = views().find((wc) => wc.getURL() === `${base}/next`)
  check('8 general browsing works and stays on the shared partition', /Purple Walrus 42/.test(f1.text) && /You arrived/.test(n1.text) && !!formWc && inPartition(formWc, SHARED), n1.text.slice(0, 80))
  const ck = await tool(B, 'browser_open', { url: `${base}/cookie` })
  check('8 site logins stay shared across chats', /cookies: .*brain=1/.test(ck.text), ck.text)
  check('8 both WhatsApp logins are untouched', (await linked(main)) === 'personal' && (await linked(india)) === 'india')
  check('8 both WhatsApp windows still show WhatsApp', onWhatsApp(main) && onWhatsApp(india) && !main.isDestroyed() && !india.isDestroyed())

  await openWa(A, 'india')
  await openSharedPage(`${base}/form`, 'chat:A')
  const sharedForm = views().filter((wc) => wc.getURL() === `${base}/form`)
  check('8b a bare-address send opens on the shared partition', sharedForm.length >= 1 && sharedForm.every((wc) => inPartition(wc, SHARED)) && onWhatsApp(main) && onWhatsApp(india), sharedForm.map((w) => w.getURL()).join(','))
  await openSharedPage(WA, 'chat:A')
  await sleep(800)
  const face = await faceShared('chat:A')
  const col = centre(face.src)
  check('8b a bare WhatsApp send shows main (green, linked as personal)', isGreen(col) && (await linked(main)) === 'personal' && (await linked(india)) === 'india', JSON.stringify(col))

  await openWa(A, 'india')
  const faceIndia = centre((await faceShared('chat:A')).src)
  check('9 chat A shows india (orange)', isOrange(faceIndia), JSON.stringify(faceIndia))
  const buy = await tool(A, 'browser_click', { target: 'Buy now' })
  check('9 Buy now is held by the pay check', buy.isError && /spend money/.test(buy.text), buy.text)
  const approved = await sharedDeskBrowser().clickApproved('Buy now', WA, 'chat:A')
  const indiaBought = await india.executeJavaScript('document.getElementById("bought").textContent')
  const mainBought = await main.executeJavaScript('document.getElementById("bought")?.textContent || "none"')
  check('9 the approved click lands on india, not main (F6)', 'ok' in approved && indiaBought === 'bought' && mainBought !== 'bought', `${JSON.stringify(approved).slice(0, 80)} india ${indiaBought} main ${mainBought}`)

  await tool(A, 'browser_close')
  await tool(B, 'browser_close')
  await closeShared('chat:A')
  const desk = sharedDeskBrowser()
  await desk.open('d1', 'desk:x')
  const d = await desk.runStep('d1', { action: 'url', url: WA, account: 'india' })
  desk.release('d1')
  check('10 a Desk owner can show india', 'ok' in d && /Linked as: india/.test(d.text), JSON.stringify(d).slice(0, 100))
  await desk.closeOwner?.('desk:x')
  await sleep(300)
  check('10 no close destroys a WhatsApp window (F7)', !main.isDestroyed() && !india.isDestroyed() && waViews().length === 2, String(waViews().length))

  for (const m of [A, B, C]) m.kill()
  stopBrowserBridge()
  server.close()
  log('PHASE_1_PASS')
}

async function phaseTwo() {
  const { server, base } = await serve()
  await startBrowserBridge({ dir: userData, script: bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser: sharedDeskBrowser(), onOpened: () => {} })
  const A = await mcpFor('chat:A')
  const m = await openWa(A)
  check('12 after a restart main is still linked as personal', /Linked as: personal/.test(m.text), m.text)
  const i = await openWa(A, 'india')
  check('12 after a restart india is still linked as india (F11)', /Linked as: india/.test(i.text), i.text)
  check('12 the accounts are exactly main, india (F10)', /Accounts on this computer: main, india\.$/m.test(i.text), i.text)
  const ck = await tool(A, 'browser_open', { url: `${base}/cookie` })
  check('12 the shared site cookie survived', /cookies: .*brain=1/.test(ck.text), ck.text)
  A.kill()
  stopBrowserBridge()
  server.close()
  log('PHASE_2_PASS')
}

app.whenReady().then(async () => {
  try {
    if (PHASE === '2') await phaseTwo()
    else await phaseOne()
    app.quit()
  } catch (e) {
    log(`WHATSAPP_ACCOUNTS_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    app.exit(1)
  }
})
app.on('window-all-closed', () => {})
