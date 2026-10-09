// Runs under Electron 44 (see scripts/check-browser-popups.ts): pop-ups, the page guard, site asks and the passkey
// gate on the real browser modules. Recorders stand in for macOS's camera/microphone answer, the Open panel and the
// menu; a stand-in window answers "is Brain up front". Chromium gets a fake camera only (never the fake permission UI).
import '../in-app-browser/set-paths.ts'
import { app, BaseWindow, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type Session, type WebContents, type WebContentsView } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { standIn } from '../in-app-browser/wa-stand-in.ts'

app.commandLine.appendSwitch('use-fake-device-for-media-stream')

const ROOT = process.env.BB_ROOT || process.cwd()
const TRACE = join(ROOT, 'plans', '20261009-browser-popups-check.txt')
writeFileSync(TRACE, `browser popups check ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 240)})` : ''}`)
  if (!ok) throw new Fail(name)
}
const note = (line: string) => log(`note ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) return false
    await sleep(50)
  }
  return true
}

// ---- recorders, in place before any app module loads ----
const dialogCalls: string[] = []
let dialogAnswer: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async (_a: unknown, b?: unknown) => {
  dialogCalls.push(String(((b ?? _a) as { message?: string }).message || ''))
  return dialogAnswer
}
const opened: string[] = []
;(shell as unknown as { openPath: unknown }).openPath = async (p: string) => {
  opened.push(p)
  return ''
}
;(shell as unknown as { openExternal: unknown }).openExternal = async () => {}
type Item = { label?: string; click?: () => void }
const menus: Item[][] = []
const buildMenu = Menu.buildFromTemplate.bind(Menu)
;(Menu as unknown as { buildFromTemplate: unknown }).buildFromTemplate = (t: Item[]) => {
  const menu = buildMenu(t as never)
  menus.push(t)
  ;(menu as unknown as { popup: () => void }).popup = () => {}
  return menu
}
const handlers = new Map<string, (...a: unknown[]) => unknown>()
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = ((ch: string, fn: (...a: unknown[]) => unknown) => {
  handlers.set(ch, fn)
  return handle(ch, fn as never)
}) as typeof ipcMain.handle
const sent: { channel: string; payload: any }[] = []
const front = { visible: true, minimized: false, focused: true }
const fakeWin = {
  isDestroyed: () => false,
  isVisible: () => front.visible,
  isMinimized: () => front.minimized,
  isFocused: () => front.focused,
  webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
}
;(BrowserWindow as unknown as { getAllWindows: unknown }).getAllWindows = () => [fakeWin]
const frames: { owner: string; url: string }[] = []
const sender = { once() {}, isDestroyed: () => false, send: (_ch: string, f: { owner: string; url: string }) => frames.push({ owner: f.owner, url: f.url }) }
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({ sender }, ...args) as Promise<any>
const mediaAsked: string[] = []
let macSays = true

// ---- fixtures ----
let PORT = 0
const other = () => `http://127.0.0.1:${PORT}`
const PAGES: Record<string, (q: URLSearchParams) => string> = {
  '/opener': () => `<!doctype html><title>Opener</title><h1>Opener</h1>
<button id="signin" style="width:200px;height:40px">Sign in</button>
<a id="blank" href="/b" target="_blank" style="display:block;width:200px;height:40px">blank</a>
<button id="twice" style="width:200px;height:40px">twice</button>
<button id="writer" style="width:200px;height:40px">writer</button>
<button id="attach" style="width:200px;height:40px">attach</button>
<button id="pkpop" style="width:200px;height:40px">pkpop</button>
<input id="typed" aria-label="Notes"><p id="got">none</p>
<script>
addEventListener('message', (e) => { document.getElementById('got').textContent = 'got ' + e.data })
document.getElementById('signin').onclick = () => window.open('/auth', 'auth', 'width=400,height=500')
document.getElementById('twice').onclick = () => { window.open('/b?first', 'one'); setTimeout(() => window.open('/b?second', 'two'), 1000) }
document.getElementById('writer').onclick = () => { const w = window.open('', 'w'); w.document.write('<title>Writer</title><input type=file id=f style="width:300px;height:80px">') }
document.getElementById('attach').onclick = () => window.open('/file.txt', 'att')
document.getElementById('pkpop').onclick = () => window.open('/pkpop', 'pk')
</script>`,
  '/auth': () => `<!doctype html><title>Auth</title><h1>Auth pop-up</h1><input id="user" aria-label="User name">
<script>setTimeout(() => { window.opener && window.opener.postMessage('token-123', '*'); window.close() }, 2500)</script>`,
  '/b': (q) => `<!doctype html><title>B ${q.toString()}</title><h1>Heading B</h1><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })</script>`,
  '/adload': () => `<!doctype html><title>Adload</title><h1>Adload</h1><script>window.open('/b?ad'); setTimeout(() => window.open('/b?timer'), 2000)</script>`,
  '/bomb': () => `<!doctype html><title>Bomb</title><button id="go" style="width:200px;height:40px">go</button><script>document.getElementById('go').onclick = () => { for (let i = 0; i < 6; i++) window.open('/b?n=' + i, 'n' + i) }</script>`,
  '/schemes': () => `<!doctype html><title>Schemes</title><button id="go" style="width:200px;height:40px">go</button><button id="late" style="width:200px;height:40px">late</button><script>
document.getElementById('go').onclick = () => { for (const u of ['file:///etc/hosts', 'myapp://x', 'data:text/html,x']) window.open(u) }
document.getElementById('late').onclick = () => { const w = window.open('', 'late'); w.location = 'myapp://x'; setTimeout(() => { try { w.location = 'file:///etc/hosts' } catch (e) {} }, 300) }
</script>`,
  '/cam': () => `<!doctype html><title>Cam</title><p id="r">none</p><p id="q">none</p><p id="clip">none</p><p id="errs">0</p>
<button id="cam" style="width:160px;height:30px">cam</button><button id="camonly" style="width:160px;height:30px">camonly</button>
<button id="query" style="width:160px;height:30px">query</button><button id="clipb" style="width:160px;height:30px">clip</button>
<button id="five" style="width:160px;height:30px">five</button><button id="others" style="width:160px;height:30px">others</button>
<iframe id="ifr" allow="camera; microphone" src="${other()}/camframe" style="width:300px;height:60px"></iframe>
<script>
const r = (id, t) => { document.getElementById(id).textContent = t }
document.getElementById('cam').onclick = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => { r('r', 'stream ' + s.getTracks().length); s.getTracks().forEach((t) => t.stop()) }, (e) => r('r', 'err ' + e.name))
document.getElementById('camonly').onclick = () => navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { r('r', 'camonly stream'); s.getTracks().forEach((t) => t.stop()) }, (e) => r('r', 'camonly err ' + e.name))
document.getElementById('query').onclick = () => navigator.permissions.query({ name: 'camera' }).then((p) => r('q', p.state), (e) => r('q', 'err ' + e.name))
document.getElementById('clipb').onclick = () => navigator.clipboard.readText().then((t) => r('clip', 'text ' + t), (e) => r('clip', 'err ' + e.name))
document.getElementById('five').onclick = () => { let n = 0; for (let i = 0; i < 5; i++) navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()), () => r('errs', String(++n))) }
document.getElementById('others').onclick = async () => {
  const out = []
  await new Promise((done) => navigator.geolocation.getCurrentPosition(() => { out.push('geo ok'); done() }, (e) => { out.push('geo ' + e.code); done() }, { timeout: 3000 }))
  out.push('notif ' + (await Notification.requestPermission()))
  await navigator.requestMIDIAccess().then(() => out.push('midi ok'), (e) => out.push('midi ' + e.name))
  r('r', out.join(' | '))
}
addEventListener('message', (e) => r('r', 'frame ' + e.data))
</script>`,
  '/camframe': () => `<!doctype html><button id="go" style="width:200px;height:40px">go</button><script>document.getElementById('go').onclick = () => navigator.mediaDevices.getUserMedia({ video: true }).then(() => parent.postMessage('stream', '*'), (e) => parent.postMessage('err ' + e.name, '*'))</script>`,
  '/pk': () => `<!doctype html><title>Passkey</title><p id="r">none</p><p id="r2">none</p>
<button id="get" style="width:160px;height:30px">get</button><button id="cond" style="width:160px;height:30px">cond</button>
<button id="own" style="width:160px;height:30px">own</button><button id="two" style="width:160px;height:30px">two</button>
<button id="ifr" style="width:160px;height:30px">ifr</button><button id="adhoc" style="width:160px;height:30px">adhoc</button>
<iframe id="same" srcdoc="<p>inner</p>" style="width:100px;height:30px"></iframe>
<script>
const r = (id, t) => { document.getElementById(id).textContent = t }
const pk = (extra = {}) => Object.assign({ publicKey: { challenge: new Uint8Array(16), timeout: 60000, rpId: 'localhost', userVerification: 'preferred' } }, extra)
const t0 = () => performance.now()
const res = (id, start) => [(v) => r(id, 'resolved'), (e) => r(id, e.name + ' ' + Math.round(performance.now() - start))]
document.getElementById('get').onclick = () => { const s = t0(); navigator.credentials.get(pk()).then(...res('r', s)) }
document.getElementById('cond').onclick = () => { const s = t0(); navigator.credentials.get(pk({ mediation: 'conditional' })).then(...res('r', s)) }
document.getElementById('own').onclick = () => { const s = t0(); const ac = new AbortController(); setTimeout(() => ac.abort(), 600); navigator.credentials.get(pk({ signal: ac.signal })).then(...res('r', s)) }
document.getElementById('two').onclick = () => { const s = t0(); navigator.credentials.get(pk()).then(...res('r', s)); setTimeout(() => navigator.credentials.get(pk()).then(...res('r2', t0())), 400) }
document.getElementById('ifr').onclick = () => { const w = document.getElementById('same').contentWindow; const s = t0(); w.navigator.credentials.get(pk()).then(...res('r', s)); w.print() }
document.getElementById('adhoc').onclick = () => { const f = document.createElement('iframe'); document.body.appendChild(f); f.contentDocument.write('<title>Receipt</title><p>Receipt 42</p>'); f.contentDocument.close(); f.contentWindow.print() }
</script>`,
  '/pkpop': () => `<!doctype html><title>PkPop</title><h1>PkPop</h1><p id="r">none</p><script>
print()
navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16), timeout: 60000, rpId: 'localhost' } }).then(() => { document.getElementById('r').textContent = 'resolved' }, (e) => { document.getElementById('r').textContent = e.name })
</script>`
}
function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    if (u.pathname === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' })
      res.end('downloaded')
      return
    }
    const page = PAGES[u.pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' })
    res.end(page ? page(u.searchParams) : 'not found')
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

// WhatsApp stand-in, with a link, a camera button, a notification ask on load, and a pop-up when "Sam Lee" opens
// while the page address has ?popper (the send's second check).
const waExtra = `<script>
Notification.requestPermission()
window.__realOpen = window.open.bind(window)
</script>`
const waAfter = `<a id="walink" href="https://example.test/linked" target="_blank" style="display:block;width:200px;height:40px;margin:8px">walink</a>
<button id="wacam" style="width:160px;height:30px">wacam</button><p id="war">none</p>
<script>
document.getElementById('wacam').onclick = () => navigator.mediaDevices.getUserMedia({ video: true }).then(() => { document.getElementById('war').textContent = 'stream' }, (e) => { document.getElementById('war').textContent = 'err ' + e.name })
// When the send opens Sam Lee's chat (its click counts as input), the page opens a pop-up a moment later.
if (location.search.includes('popper')) {
  let fired = false
  new MutationObserver(() => {
    const title = document.querySelector('#main header span')?.getAttribute('title')
    if (title === 'Sam Lee' && !fired) {
      fired = true
      setTimeout(() => window.__realOpen('https://example.test/popped'), 100)
    }
  }).observe(document.body, { childList: true, subtree: true })
}
</script>`
app.on('session-created', (ses: Session) => {
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'web.whatsapp.com') {
      const page = standIn(u).replace('<body style="margin:0;font:14px sans-serif">', `<body style="margin:0;font:14px sans-serif">${waExtra}`) + waAfter
      return new Response(page, { headers: { 'content-type': 'text/html' } })
    }
    if (u.hostname === 'example.test') return new Response(`<!doctype html><title>Example ${u.pathname}</title><h1>Example ${u.pathname}</h1>`, { headers: { 'content-type': 'text/html' } })
    return fetch(req)
  })
})

function views(): WebContents[] {
  return BaseWindow.getAllWindows()
    .flatMap((w) => (w.isDestroyed() ? [] : (w.contentView.children as WebContentsView[])))
    .map((v) => v.webContents)
    .filter((wc) => wc && !wc.isDestroyed())
}
const wcAt = (part: string) => views().find((wc) => wc.getURL().includes(part))
const centre = async (wc: WebContents, sel: string) =>
  (await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)) as {
    x: number
    y: number
  }
const text = (wc: WebContents, sel: string) => wc.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`) as Promise<string>
const asks = (owner?: string) => sent.filter((s) => s.channel === 'browser:ask' && (!owner || s.payload.owner === owner)).map((s) => s.payload)
const ends = (id: string) => sent.filter((s) => s.channel === 'browser:askEnded' && s.payload.id === id).map((s) => s.payload)

app.whenReady().then(async () => {
  const server = await serve()
  PORT = (server.address() as { port: number }).port
  const base = `http://localhost:${PORT}`
  try {
    const { sharedDeskBrowser } = await import('../../src/main/shared-browser.ts')
    const { registerBrowserIpc } = await import('../../src/main/browser-ipc.ts')
    const { startBrowserUi } = await import('../../src/main/browser-ui.ts')
    const { BROWSER_PARTITION, pageAsks } = await import('../../src/main/desk/inapp.ts')
    const siteAsks: string[] = []
    pageAsks.on('ask', (a) => {
      if (a.kind === 'site') siteAsks.push(`${a.site} ${a.uses.join('+')}`)
    })
    const bridge = await import('../../src/main/browser-bridge.ts')
    registerBrowserIpc()
    const browser = sharedDeskBrowser()
    startBrowserUi({
      browser,
      window: () => fakeWin as unknown as BrowserWindow,
      test: {
        askMs: 8000,
        mediaAccess: async (use) => {
          mediaAsked.push(use)
          return macSays
        }
      }
    })
    const click = async (owner: string, wc: WebContents, sel: string, button: 'left' | 'right' = 'left') => {
      const at = await centre(wc, sel)
      for (const type of ['down', 'up'] as const) await call('browser:pointer', owner, { type, x: at.x, y: at.y, button, buttons: type === 'down' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 })
    }
    const face = (owner: string) => call('browser:face', owner)
    const windowCount = () => BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).length

    // ---- MCP for chat A ----
    await bridge.startBrowserBridge({ dir: app.getPath('userData'), script: bridge.bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser, onOpened: () => {} })
    const spec = bridge.browserServer('chat:A')!
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] })
    let buf = ''
    let rpc = 0
    const waiting = new Map<number, (m: any) => void>()
    child.stdout!.on('data', (d) => {
      buf += d
      let n
      while ((n = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, n))
        buf = buf.slice(n + 1)
        waiting.get(m.id)?.(m)
      }
    })
    const mcp = (method: string, params?: unknown) =>
      new Promise<any>((done) => {
        const i = ++rpc
        waiting.set(i, done)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
      })
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await mcp('tools/call', { name, arguments: args })
      return String(r?.result?.content?.[0]?.text ?? '') as string
    }
    await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const before = windowCount()

    // 1. sign-in pop-up
    await tool('browser_open', { url: `${base}/opener` })
    const opener = wcAt('/opener')!
    await call('browser:watch', 'chat:A', true)
    await click('chat:A', opener, '#signin')
    await until(async () => (await face('chat:A'))?.popup === true)
    const f1 = await face('chat:A')
    check('1 the sign-in pop-up opens on top of chat A', f1?.popup === true && /\/auth$/.test(f1?.url || ''), JSON.stringify({ popup: f1?.popup, url: f1?.url }))
    const readPop = await tool('browser_read')
    check('1 a read through the bridge reads the pop-up', /Auth pop-up/.test(readPop), readPop.slice(0, 120))
    await until(() => frames.some((f) => f.owner === 'chat:A' && /\/auth$/.test(f.url)), 3000)
    check('1 the live picture showed the pop-up', frames.some((f) => f.owner === 'chat:A' && /\/auth$/.test(f.url)))
    const framesNow = frames.length
    await until(async () => (await face('chat:A'))?.popup === false, 6000)
    const got = await text(opener, '#got')
    check('1 the pop-up posted to its opener and closed itself; A is back on the opener', got === 'got token-123' && /\/opener$/.test((await face('chat:A'))?.url || ''), got)
    await until(() => frames.slice(framesNow).some((f) => /\/opener$/.test(f.url)), 3000)
    check('1 the live picture moved back to the opener', frames.slice(framesNow).some((f) => /\/opener$/.test(f.url)))
    check('1 a bridge read reads the opener again', /Opener/.test(await tool('browser_read')))

    // 2. _blank, Close pop-up, beforeunload, browser_close
    await opener.executeJavaScript(`document.getElementById('typed').value = 'kept text'`)
    await click('chat:A', opener, '#blank')
    await until(async () => (await face('chat:A'))?.popup === true)
    check('2 a target=_blank link opens on top', /\/b$/.test((await face('chat:A'))?.url || ''))
    const closed = await call('browser:closePopup', 'chat:A')
    await until(async () => (await face('chat:A'))?.popup === false)
    check('2 Close pop-up (its page has a beforeunload) returns to the opener with its text', closed === true && (await opener.executeJavaScript(`document.getElementById('typed').value`)) === 'kept text' && !wcAt('/b'))
    await click('chat:A', opener, '#blank')
    await until(async () => (await face('chat:A'))?.popup === true)
    const closeOne = await tool('browser_close')
    check('2 browser_close with a pop-up up closes only the pop-up', /Closed the pop-up/.test(closeOne) && !opener.isDestroyed() && (await face('chat:A'))?.popup === false, closeOne)

    // 3. gesture rule, cap, schemes, leaks
    await browser.goTo!(`${base}/adload`, 'chat:B')
    await sleep(2600)
    check('3 a load-time and a timer window.open with no click open nothing (B stays, no pop-up)', !wcAt('/b?ad') && !wcAt('/b?timer') && (await face('chat:B'))?.popup === false && /\/adload$/.test((await face('chat:B'))?.url || ''))
    await browser.goTo!(`${base}/bomb`, 'chat:B')
    await click('chat:B', wcAt('/bomb')!, '#go')
    await sleep(1200)
    const bombs = views().filter((wc) => /\/b\?n=/.test(wc.getURL())).length
    check('3 six windows asked at once: three pop-ups, the rest open nothing', bombs === 3, `${bombs}`)
    await browser.closeOwner!('chat:B')
    await browser.goTo!(`${base}/opener`, 'chat:C')
    const openerC = wcAt('/opener')!.id === opener.id ? views().filter((wc) => /\/opener$/.test(wc.getURL())).find((wc) => wc.id !== opener.id)! : wcAt('/opener')!
    await click('chat:C', openerC, '#twice')
    await until(() => views().some((wc) => /second/.test(wc.getURL())), 4000)
    const first = views().find((wc) => /first/.test(wc.getURL()))!
    await first.executeJavaScript('window.close()')
    await sleep(500)
    check('3 the older of two pop-ups closes itself: the newer stays on top', /second/.test((await face('chat:C'))?.url || '') && (await face('chat:C'))?.popup === true)
    // A pop-up shares its page process with its opener, so the crash takes both; Brain drops both windows.
    const crashing = views().find((wc) => /second/.test(wc.getURL()))!
    crashing.forcefullyCrashRenderer()
    await until(() => !views().some((wc) => /second/.test(wc.getURL())), 4000)
    await sleep(300)
    const crashFace = await face('chat:C')
    check('3 a crashed pop-up leaves no window behind and C no longer reports a pop-up', !views().some((wc) => /second|\/opener$/.test(wc.getURL()) && wc.id === crashing.id) && !crashFace?.popup, JSON.stringify(crashFace))
    await browser.goTo!(`${base}/opener`, 'chat:C')
    check('3 after the crash, the place opens again fresh', /\/opener$/.test((await face('chat:C'))?.url || '') && (await face('chat:C'))?.popup === false)
    await browser.goTo!(`${base}/schemes`, 'chat:C')
    const sch = wcAt('/schemes')!
    await click('chat:C', sch, '#go')
    await sleep(800)
    const schFace = await face('chat:C')
    check('3 file:, myapp: and data: pop-ups open nothing', schFace?.popup === false && /\/schemes$/.test(schFace?.url || ''), `${JSON.stringify({ popup: schFace?.popup, url: schFace?.url })} views ${views().map((wc) => wc.getURL()).join(' , ')}`)
    await click('chat:C', sch, '#late')
    await sleep(1200)
    const late = (await face('chat:C'))?.url || ''
    check('3 an empty pop-up sent to myapp: and file: stays on about:blank', (await face('chat:C'))?.popup === true && late === 'about:blank', late)
    await browser.closeOwner!('chat:C')
    await sleep(300)

    // 5. pop-up asks
    dialogAnswer = { canceled: false, filePaths: [join(ROOT, 'package.json')] }
    const d0 = dialogCalls.length
    await click('chat:A', opener, '#writer')
    await until(async () => (await face('chat:A'))?.popup === true)
    const writer = views().find((wc) => wc.getURL() === 'about:blank' && wc.getTitle() === 'Writer')!
    await sleep(300)
    await click('chat:A', writer, '#f')
    await until(() => dialogCalls.length > d0, 4000)
    await sleep(300)
    const fileName = await writer.executeJavaScript(`document.getElementById('f').files[0]?.name || ''`)
    check("5 a file input written into an empty pop-up asks Brain's panel and gets the file", dialogCalls.length === d0 + 1 && fileName === 'package.json', `${dialogCalls.length - d0} ${fileName}`)
    await call('browser:closePopup', 'chat:A')
    await until(async () => (await face('chat:A'))?.popup === false)
    const s0 = sent.length
    await click('chat:A', opener, '#attach')
    await until(() => sent.slice(s0).some((s) => s.channel === 'browser:download'), 6000)
    const dl = sent.slice(s0).filter((s) => s.channel === 'browser:download')
    check('5 a download from a pop-up that opened an attachment reaches chat A only', dl.length === 1 && dl[0].payload.owner === 'chat:A' && dl[0].payload.name === 'file.txt', JSON.stringify(dl.map((d) => d.payload)))
    await sleep(500)
    if ((await face('chat:A'))?.popup) await call('browser:closePopup', 'chat:A')

    // 6. AI targeting
    const readOpener = await tool('browser_read')
    const typedNo = /#(\d+) field Notes/.exec(readOpener)?.[1]
    await click('chat:A', opener, '#signin')
    await until(async () => (await face('chat:A'))?.popup === true)
    const refused = await tool('browser_type', { target: `#${typedNo}`, text: 'should not land' })
    const authWc = wcAt('/auth')!
    check("6 a step by number from the opener's read is refused once a pop-up is on top", /pop-up opened \(or closed\) since your last read/.test(refused) && (await authWc.executeJavaScript(`document.getElementById('user').value`)) === '', refused)
    const readAuth = await tool('browser_read')
    const userNo = /#(\d+) field User name/.exec(readAuth)?.[1]
    await tool('browser_type', { target: `#${userNo}`, text: 'joe' })
    check('6 after a new read, typing works in the pop-up', (await authWc.executeJavaScript(`document.getElementById('user').value`)) === 'joe')
    await until(async () => (await face('chat:A'))?.popup === false, 6000)
    await tool('browser_read')
    const readAgain = await tool('browser_read')
    const signNo = /#(\d+) button Sign in/.exec(readAgain)?.[1]
    const clickRes = await tool('browser_click', { target: `#${signNo}` })
    check("6 the AI's click that opens a pop-up says so and shows the pop-up", /A pop-up opened on top/.test(clickRes) && /Auth pop-up/.test(clickRes), clickRes.slice(0, 160))
    await until(async () => (await face('chat:A'))?.popup === false, 6000)

    // 4. WhatsApp
    await browser.goTo!('https://web.whatsapp.com/?link=1', 'chat:W')
    const wa = wcAt('web.whatsapp.com')!
    await until(async () => !!(await wa.executeJavaScript(`!!document.getElementById('walink')`)), 4000)
    await click('chat:W', wa, '#walink')
    await until(async () => (await face('chat:W'))?.popup === true, 4000)
    check('4 a link clicked in WhatsApp opens on top of it', /example\.test\/linked/.test((await face('chat:W'))?.url || ''))
    const sendCovered = await browser.whatsappSend!({ account: '', to: 'Sam Lee', body: 'hello from the check' })
    const sentNow = await wa.executeJavaScript(`localStorage.sent || '[]'`)
    check('4 a send while a pop-up covers WhatsApp is refused and types nothing', !sendCovered.ok && /pop-up is open over WhatsApp/.test((sendCovered as { note: string }).note) && sentNow === '[]', JSON.stringify(sendCovered))
    await call('browser:closePopup', 'chat:W')
    await until(async () => (await face('chat:W'))?.popup === false)
    await wa.loadURL('https://web.whatsapp.com/?link=1&popper=1')
    await sleep(800)
    const popped = await browser.whatsappSend!({ account: '', to: 'Sam Lee', body: 'hello mid send' })
    const poppedSent = await wa.executeJavaScript(`localStorage.sent || '[]'`)
    const popWc = wcAt('example.test/popped')
    const popKeys = popWc ? await popWc.executeJavaScript(`document.activeElement ? document.activeElement.tagName : ''`) : ''
    check('4b a pop-up that opens during the send stops it; nothing sent, nothing typed into the pop-up', !popped.ok && /during the send/.test((popped as { note: string }).note) && poppedSent === '[]' && !!popWc, `${JSON.stringify(popped)} ${poppedSent} ${popKeys}`)
    await call('browser:closePopup', 'chat:W')
    await until(async () => (await face('chat:W'))?.popup === false)
    await wa.loadURL('https://web.whatsapp.com/?link=1')
    await sleep(800)
    const okSend = await browser.whatsappSend!({ account: '', to: 'Sam Lee', body: 'hello after' })
    check('4b with the pop-up closed, the send goes through', okSend.ok === true, JSON.stringify(okSend))
    check('4 WhatsApp asking for notifications on load makes no card', !asks().some((a) => /whatsapp/.test(a.site)))

    // 7. permissions
    await browser.goTo!(`${base}/cam`, 'chat:A')
    await browser.goTo!(`${base}/b`, 'chat:B')
    const cam = wcAt('/cam')!
    await call('browser:watch', 'chat:A', true)
    await click('chat:A', cam, '#query')
    await until(async () => (await text(cam, '#q')) !== 'none')
    check('7 before any answer, permissions.query says denied', (await text(cam, '#q')) === 'denied', await text(cam, '#q'))
    await click('chat:A', cam, '#cam')
    await until(() => asks('chat:A').some((a) => a.kind === 'site'), 4000)
    const card = asks('chat:A').filter((a) => a.kind === 'site').pop()
    check('7 one site card for chat A only, naming the page and camera + microphone', !!card && card.site === base && JSON.stringify(card.uses) === '["camera","microphone"]' && !asks('chat:B').length, JSON.stringify(card))
    check('7 an answer from chat B is refused', 'refused' in (await call('browser:askAnswer', 'chat:B', card.id, 'allow')))
    await call('browser:askAnswer', 'chat:A', card.id, 'allow')
    await until(async () => /stream/.test(await text(cam, '#r')), 5000)
    check('7 Allow asks macOS for camera and microphone and the page gets its stream', /stream 2/.test(await text(cam, '#r')) && mediaAsked.join(',') === 'camera,microphone', `${await text(cam, '#r')} ${mediaAsked}`)
    check('7 a second answer to the same card is refused', 'refused' in (await call('browser:askAnswer', 'chat:A', card.id, 'allow')))
    await cam.reload()
    await sleep(800)
    const n0 = asks().length
    await click('chat:A', cam, '#cam')
    await until(async () => /stream|err/.test(await text(cam, '#r')), 4000)
    await click('chat:A', cam, '#query')
    await until(async () => (await text(cam, '#q')) !== 'none')
    check('7 after reload, live: granted with no card, and query says granted', /stream/.test(await text(cam, '#r')) && asks().length === n0 && (await text(cam, '#q')) === 'granted', `${await text(cam, '#r')} ${await text(cam, '#q')}`)
    await call('browser:watch', 'chat:A', false)
    await cam.reload()
    await sleep(800)
    await click('chat:A', cam, '#cam')
    await until(async () => /stream|err/.test(await text(cam, '#r')), 4000)
    await click('chat:A', cam, '#query')
    await until(async () => (await text(cam, '#q')) !== 'none')
    check('7 the same ask with A small: refused, no card, query says denied', /err NotAllowedError/.test(await text(cam, '#r')) && asks().length === n0 && (await text(cam, '#q')) === 'denied', `${await text(cam, '#r')} ${await text(cam, '#q')}`)
    await call('browser:watch', 'chat:A', true)
    const m0 = menus.length
    await click('chat:A', cam, '#r', 'right')
    await until(() => menus.length > m0)
    const forgetItem = menus.at(-1)?.find((i) => i.label === "Forget this site's permissions")
    forgetItem?.click?.()
    await sleep(300)
    await cam.reload()
    await sleep(800)
    await click('chat:A', cam, '#cam')
    await until(() => asks().length > n0, 4000)
    const again = asks().at(-1)
    check("7 Forget this site's permissions: the next ask shows a card again", !!forgetItem && again?.kind === 'site' && again.site === base)
    // Chromium sends one page's camera requests one at a time, so the second asker is another window of the same site.
    await browser.goTo!(`${base}/cam?two`, 'chat:B')
    const camB = wcAt('/cam?two')!
    await call('browser:watch', 'chat:B', true)
    await click('chat:B', camB, '#camonly')
    await until(() => asks().length > n0 + 1, 4000)
    const camOnly = asks().at(-1)
    check('7 a camera-only ask from another window of the site makes its own card next to the camera + microphone one', camOnly?.id !== again?.id && JSON.stringify(camOnly?.uses) === '["camera"]' && camOnly?.owner === 'chat:B', JSON.stringify(camOnly))
    await call('browser:askAnswer', 'chat:A', again.id, 'deny')
    await call('browser:askAnswer', 'chat:B', camOnly.id, 'deny')
    await call('browser:watch', 'chat:B', false)
    await until(async () => /err/.test(await text(cam, '#r')))
    const n1 = asks().length
    const sa = siteAsks.length
    await click('chat:A', cam, '#five')
    await until(async () => (await text(cam, '#errs')) === '5', 4000)
    check("7 after Don't allow, five repeats make no card and all five are refused", asks().length === n1 && (await text(cam, '#errs')) === '5', `${await text(cam, '#errs')} rejected; ${siteAsks.length - sa} reached Brain: ${siteAsks.slice(sa).join(' | ')}`)
    check("7 Don't allow left its note on the card", ends(again.id)[0]?.note === 'Not allowed.')
    await clipboard.writeText('clip-123')
    await click('chat:A', cam, '#clipb')
    await until(() => asks().length > n1, 4000)
    const clipCard = asks().at(-1)
    await call('browser:askAnswer', 'chat:A', clipCard.id, 'allow')
    await until(async () => (await text(cam, '#clip')) !== 'none')
    const n2 = asks().length
    await click('chat:A', cam, '#clipb')
    await until(() => asks().length > n2, 4000)
    check('7 clipboard read: a card, Allow gives the text, and the next read asks again', JSON.stringify(clipCard.uses) === '["clipboard"]' && (await text(cam, '#clip')) === 'text clip-123' && asks().length === n2 + 1, await text(cam, '#clip'))
    const clipAgain = asks().at(-1)
    await until(() => ends(clipAgain.id).length > 0, 10_000)
    check('7 a card nobody answers refuses and says it timed out', /No answer in time/.test(ends(clipAgain.id)[0]?.note || ''), JSON.stringify(ends(clipAgain.id)))
    const ifr = cam.mainFrame.frames[0]
    const n3 = asks().length
    await ifr.executeJavaScript(`document.getElementById('go').click()`, true).catch(() => {})
    await sleep(800)
    check('7 a cross-origin iframe asking for the camera is refused with no card', asks().length === n3 && /frame err/.test(await text(cam, '#r')), await text(cam, '#r'))
    await click('chat:A', cam, '#others')
    await until(async () => /midi/.test(await text(cam, '#r')), 6000)
    check('7 location, notifications and MIDI are refused with no card', asks().length === n3 && /geo 1/.test(await text(cam, '#r')) && /notif denied/.test(await text(cam, '#r')) && /midi NotAllowedError|midi SecurityError/.test(await text(cam, '#r')), await text(cam, '#r'))
    // A second site (127.0.0.1): localhost's camera asks are refused for this run after Don't allow.
    macSays = false
    await browser.goTo!(`${other()}/cam?mac`, 'chat:D')
    await call('browser:watch', 'chat:A', false)
    await call('browser:watch', 'chat:D', true)
    const camD = wcAt('/cam?mac')!
    const n4 = asks().length
    await click('chat:D', camD, '#cam')
    await until(() => asks().length > n4, 4000)
    const macCard = asks().at(-1)
    await call('browser:askAnswer', 'chat:D', macCard.id, 'allow')
    await until(async () => /err/.test(await text(camD, '#r')), 4000)
    check("7 macOS saying no: Allow refuses and the card names System Settings", /System Settings > Privacy & Security > Camera/.test(ends(macCard.id)[0]?.note || '') && /err NotAllowedError/.test(await text(camD, '#r')), JSON.stringify(ends(macCard.id)))
    macSays = true
    await call('browser:watch', 'chat:D', false)
    await browser.goTo!(`${other()}/cam?desk`, 'desk:bot')
    await call('browser:watch', 'desk:bot', true)
    const camDesk = wcAt('/cam?desk')!
    const n5 = asks().length
    await click('desk:bot', camDesk, '#cam')
    await until(async () => /err/.test(await text(camDesk, '#r')), 4000)
    check('7 a page only in a Desk tile (watched there) is refused with no card', asks().length === n5)
    await call('browser:watch', 'desk:bot', false)
    await call('browser:watch', 'chat:D', true)
    await click('chat:D', camD, '#camonly')
    await until(() => asks().length > n5, 4000)
    const gone = asks().at(-1)
    await browser.closeOwner!('chat:D')
    await until(() => ends(gone.id).length > 0, 4000)
    check('7 a window closed with a card open: the card ends', ends(gone.id).length === 1)
    await call('browser:watch', 'chat:D', false)
    // Logins: an Allow for WhatsApp main does not reach WhatsApp india.
    await call('browser:watch', 'chat:W', true)
    const n6 = asks().length
    await click('chat:W', wa, '#wacam')
    await until(() => asks().length > n6, 4000)
    await call('browser:askAnswer', 'chat:W', asks().at(-1).id, 'allow')
    await until(async () => (await text(wa, '#war')) === 'stream', 4000)
    await call('browser:watch', 'chat:W', false)
    await tool('browser_open', { url: 'https://web.whatsapp.com/?link=1', account: 'india' })
    await call('browser:watch', 'chat:A', true)
    const waIndia = views().find((wc) => wc.getURL().includes('web.whatsapp.com') && wc.id !== wa.id)!
    const n7 = asks().length
    await until(async () => !!(await waIndia.executeJavaScript(`!!document.getElementById('wacam')`)), 4000)
    await click('chat:A', waIndia, '#wacam')
    await until(() => asks().length > n7, 4000)
    check("7 WhatsApp main's camera Allow does not reach WhatsApp india: india asks", asks().length === n7 + 1 && asks().at(-1).site === 'https://web.whatsapp.com')
    await call('browser:askAnswer', 'chat:A', asks().at(-1).id, 'deny')
    await call('browser:watch', 'chat:A', false)

    // 8. page guard and passkeys
    await tool('browser_open', { url: `${base}/pk` })
    const pk = wcAt('/pk')!
    const pdfs = () => readdirSync(app.getPath('downloads')).filter((f) => f.endsWith('.pdf')).length
    const p0 = asks().length
    await click('chat:A', pk, '#get')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    const small = await text(pk, '#r')
    check('8 with A small, a passkey get is refused within 1 s and no card shows', /^NotAllowedError \d+$/.test(small) && Number(small.split(' ')[1]) < 1000 && asks().length === p0, small)
    await call('browser:watch', 'chat:A', true)
    await pk.executeJavaScript(`document.getElementById('r').textContent = 'none'`)
    await click('chat:A', pk, '#cond')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    check('8 a conditional (autofill) get is refused, no card', /^NotAllowedError/.test(await text(pk, '#r')) && asks().length === p0, await text(pk, '#r'))
    await pk.executeJavaScript(`document.getElementById('r').textContent = 'none'`)
    await click('chat:A', pk, '#get')
    await until(() => asks().length > p0, 3000)
    const pkCard = asks().at(-1)
    check('8 with A live, one passkey card for chat A', pkCard?.kind === 'passkey' && pkCard.owner === 'chat:A' && pkCard.site === base, JSON.stringify(pkCard))
    const tCancel = Date.now()
    await call('browser:askAnswer', 'chat:A', pkCard.id, 'cancel')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    check("8 Cancel ends the page's request (AbortError) within 1 s and the card ends", /^AbortError/.test(await text(pk, '#r')) && Date.now() - tCancel < 1500 && ends(pkCard.id).length === 1, await text(pk, '#r'))
    check('8 a second answer to the passkey card is refused', 'refused' in (await call('browser:askAnswer', 'chat:A', pkCard.id, 'cancel')))
    await pk.executeJavaScript(`document.getElementById('r').textContent = 'none'`)
    const p1 = asks().length
    await click('chat:A', pk, '#own')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    const ownCard = asks().at(-1)
    await until(() => ends(ownCard.id).length > 0, 2000)
    check("8 the page's own AbortSignal still aborts, and the card goes", asks().length === p1 + 1 && /^AbortError/.test(await text(pk, '#r')) && ends(ownCard.id)[0]?.note === '', `${await text(pk, '#r')} ${JSON.stringify(ends(ownCard.id))}`)
    await pk.executeJavaScript(`document.getElementById('r').textContent = 'none'; document.getElementById('r2').textContent = 'none'`)
    await click('chat:A', pk, '#two')
    await until(async () => (await text(pk, '#r2')) !== 'none', 3000)
    check('8 a second get while one waits is refused', /^NotAllowedError/.test(await text(pk, '#r2')), await text(pk, '#r2'))
    await call('browser:askAnswer', 'chat:A', asks().at(-1).id, 'cancel')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    await call('browser:watch', 'chat:A', false)
    await pk.executeJavaScript(`document.getElementById('r').textContent = 'none'`)
    const pdf0 = pdfs()
    await click('chat:A', pk, '#ifr')
    await until(async () => (await text(pk, '#r')) !== 'none', 3000)
    await sleep(800)
    check("8 a same-origin iframe's get and print go through the guard (small: refused, no PDF)", /^NotAllowedError/.test(await text(pk, '#r')) && pdfs() === pdf0, await text(pk, '#r'))
    await call('browser:watch', 'chat:A', true)
    await click('chat:A', pk, '#adhoc')
    await until(() => pdfs() > pdf0, 8000)
    const pageAnswers = await Promise.race([pk.executeJavaScript('1+1'), sleep(3000).then(() => 'stuck')])
    const adhocOk = pdfs() === pdf0 + 1 && pageAnswers === 2
    note(`ad-hoc iframe print (r2 #3): ${adhocOk ? 'went through the guard: one PDF of the iframe, the page still answers' : `pdfs ${pdfs() - pdf0}, page ${pageAnswers}`}`)
    check("8 an iframe made on the fly prints its own PDF and the page keeps answering", adhocOk, `${pdfs() - pdf0} ${pageAnswers}`)
    await call('browser:watch', 'chat:A', false)
    await browser.goTo!(`${base}/opener`, 'chat:A')
    const openerAgain = wcAt('/opener')!
    const pdf1 = pdfs()
    await click('chat:A', openerAgain, '#pkpop')
    await until(async () => (await face('chat:A'))?.popup === true, 4000)
    const pkpop = wcAt('/pkpop')!
    await until(async () => (await text(pkpop, '#r')) !== 'none', 3000)
    await sleep(500)
    check("8 a pop-up's first page with A small: its load-time print writes nothing and its get is refused", /NotAllowedError/.test(await text(pkpop, '#r')) && pdfs() === pdf1, await text(pkpop, '#r'))
    await call('browser:closePopup', 'chat:A')
    await until(async () => (await face('chat:A'))?.popup === false)
    await call('browser:watch', 'chat:A', true)
    const p2 = asks().length
    await click('chat:A', openerAgain, '#pkpop')
    await until(() => asks().length > p2, 4000)
    check("8 the same pop-up with A live: its first page's get makes a card (its key is known on the first document)", asks().at(-1)?.kind === 'passkey')
    await call('browser:askAnswer', 'chat:A', asks().at(-1).id, 'cancel')
    await call('browser:closePopup', 'chat:A')
    const guardHandler = handlers.get('page-guard:passkey')!
    const fromBrain = await guardHandler({ sender: { id: 987654, getURL: () => `${base}/pk` }, senderFrame: {} }, 'get')
    check("8 the guard's channel from a window Brain does not hold is refused", fromBrain === null)
    // select-webauthn-account: handler only (a real one needs a signed build with saved passkeys).
    const ses = (await import('electron')).session.fromPartition(BROWSER_PARTITION)
    const picks: (string | null | undefined)[][] = []
    const ev = () => ({ preventDefault() {} })
    const p3 = asks().length
    ses.emit('select-webauthn-account', ev(), { relyingPartyId: 'localhost', frame: openerAgain.mainFrame, accounts: [{ credentialId: 'c1', name: 'joe@plyntr.com', relyingPartyId: 'localhost' }, { credentialId: 'c2', displayName: 'Joe Two', relyingPartyId: 'localhost' }] }, (...a: (string | null | undefined)[]) => picks.push(a))
    await until(() => asks().length > p3)
    const acct = asks().at(-1)
    check('8 account picker (handler only): two accounts on the card', acct?.kind === 'account' && acct.accounts.map((a: { name: string }) => a.name).join(',') === 'joe@plyntr.com,Joe Two', JSON.stringify(acct))
    await call('browser:askAnswer', 'chat:A', acct.id, 'c2')
    check('8 picking calls back once with that account, and a second answer is refused', picks.length === 1 && picks[0][0] === 'c2' && 'refused' in (await call('browser:askAnswer', 'chat:A', acct.id, 'c1')))
    ses.emit('select-webauthn-account', ev(), { relyingPartyId: 'localhost', frame: null, accounts: [{ credentialId: 'c1', relyingPartyId: 'localhost' }] }, (...a: (string | null | undefined)[]) => picks.push(a))
    check('8 a request with no frame is cancelled at once', picks.length === 2 && picks[1][0] == null)
    const p4 = asks().length
    ses.emit('select-webauthn-account', ev(), { relyingPartyId: 'localhost', frame: openerAgain.mainFrame, accounts: [{ credentialId: 'c1', relyingPartyId: 'localhost' }] }, (...a: (string | null | undefined)[]) => picks.push(a))
    await until(() => asks().length > p4)
    await until(() => picks.length === 3, 10_000)
    check('8 an account card nobody answers cancels once', picks.length === 3 && picks[2][0] == null)

    // leaks
    await call('browser:watch', 'chat:A', false)
    for (const owner of ['chat:A', 'chat:B', 'chat:C', 'chat:D', 'desk:bot']) await browser.closeOwner!(owner)
    await tool('browser_close').catch(() => '')
    await sleep(800)
    const left = windowCount()
    note(`windows before ${before}, after closing every place ${left} (WhatsApp windows stay open by design)`)
    check('3 no pop-up outlives its window: only the two WhatsApp windows are left', left === before + 2, `${before} -> ${left}`)

    child.kill()
    log('BROWSER_POPUPS_PASS')
  } catch (e) {
    log(`FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    log('BROWSER_POPUPS_FAIL')
  } finally {
    server.close()
    app.exit(0)
  }
})
