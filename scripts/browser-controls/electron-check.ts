// Runs under Electron 44 (see scripts/check-browser-controls.ts): the picture's controls end to end, on the real
// browser modules, with recorders standing in for the Open panel, the native menu and the system's browser.
import '../in-app-browser/set-paths.ts'
import { app, BaseWindow, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type Session, type WebContents, type WebContentsView } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.env.BB_ROOT || process.cwd()
const TRACE = join(ROOT, 'plans', '20261009-browser-controls-check.txt')
writeFileSync(TRACE, `browser controls check ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 220)})` : ''}`)
  if (!ok) throw new Fail(name)
}
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
type Held = { resolve: (r: { canceled: boolean; filePaths: string[] }) => void }
const dialogCalls: { win: unknown; properties: string[]; message?: string }[] = []
let answers: ({ canceled: boolean; filePaths: string[] } | 'hold')[] = []
const heldAnswers: Held[] = []
;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = (a: unknown, b?: unknown) => {
  const opts = (b ?? a) as { properties?: string[]; message?: string }
  dialogCalls.push({ win: b ? a : null, properties: opts.properties ?? [], message: opts.message })
  const next = answers.shift() ?? { canceled: true, filePaths: [] }
  if (next === 'hold') return new Promise((resolve) => heldAnswers.push({ resolve }))
  return Promise.resolve(next)
}
const opened: string[] = []
const external: string[] = []
;(shell as unknown as { openPath: unknown }).openPath = async (p: string) => {
  opened.push(p)
  return ''
}
;(shell as unknown as { openExternal: unknown }).openExternal = async (u: string) => {
  external.push(u)
}
;(shell as unknown as { showItemInFolder: unknown }).showItemInFolder = (p: string) => opened.push(`show:${p}`)
type Item = { label?: string; type?: string; click?: () => void }
const menus: Item[][] = []
// A real menu, so Electron's own application menu still builds; only popup is silenced, and each template is kept.
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
const sent: { channel: string; payload: unknown }[] = []
const fakeWin = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }
;(BrowserWindow as unknown as { getAllWindows: unknown }).getAllWindows = () => [fakeWin]
const sender = { once() {}, isDestroyed: () => false, send() {} }
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({ sender }, ...args) as Promise<unknown>

// ---- fixtures ----
const hits: string[] = []
const PAGES: Record<string, (q: URLSearchParams) => string> = {
  '/a': () => `<!doctype html><title>A</title><h1>Heading A</h1><a id="tob" href="/b">to b</a>
<input id="one" type="file"><input id="many" type="file" multiple>
<a id="dl" href="/file.txt">Download</a><div id="box" contenteditable="true" style="width:300px;height:40px;border:1px solid">x</div>
<p id="sel">Select this sentence</p><p id="keys"></p>
<script>addEventListener('keydown', (e) => { document.getElementById('keys').textContent += e.key })</script>`,
  '/b': () => '<!doctype html><title>B</title><h1>Heading B</h1>',
  '/c': () => '<!doctype html><title>C</title><h1>Heading C</h1>',
  '/up': () => '<!doctype html><title>Up</title><input id="f" type="file">',
  '/links': () => `<!doctype html><title>Links</title><a id="web" href="https://example.test/x" style="display:block;padding:20px">web</a>
<a id="file" href="file:///Applications/Calculator.app" style="display:block;padding:20px">file</a><a id="app" href="myapp://x" style="display:block;padding:20px">app</a>`,
  '/print': (q) => `<!doctype html><title>a/b: c</title><button id="p">print</button><p id="after"></p><p id="n">0</p><script>
let n = 0
document.getElementById('p').onclick = () => { ${q.has('loop') ? "const t = setInterval(() => { print(); document.getElementById('n').textContent = String(++n) }, 100); setTimeout(() => clearInterval(t), 3000)" : 'print()'}; document.getElementById('after').textContent = 'after-print' }
</script>`
}
function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    hits.push(u.pathname + (u.search || ''))
    if (u.pathname === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' })
      res.end('downloaded')
      return
    }
    if (u.pathname === '/broken') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="broken.bin"', 'content-length': '100000' })
      res.write(Buffer.alloc(30000))
      setTimeout(() => res.destroy(), 300)
      return
    }
    const page = PAGES[u.pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' })
    res.end(page ? page(u.searchParams) : 'not found')
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })))
}
const waHits: string[] = []
const searched: string[] = []
app.on('session-created', (ses: Session) => {
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url)
    if (u.hostname === 'web.whatsapp.com') {
      waHits.push(u.pathname + u.search)
      if (u.pathname === '/wa.txt') return new Response('wa file', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="wa.txt"' } })
      return new Response('<!doctype html><title>WhatsApp</title><h1>WA stand-in</h1><a id="wadl" href="/wa.txt">wa download</a>', { headers: { 'content-type': 'text/html' } })
    }
    if (u.hostname === 'example.test') return new Response(`<!doctype html><title>Example</title><h1>Example test ${u.pathname}</h1>`, { headers: { 'content-type': 'text/html' } })
    if (u.hostname === 'www.google.com') {
      searched.push(req.url)
      return new Response('<!doctype html><title>Search</title><h1>search stand-in</h1>', { headers: { 'content-type': 'text/html' } })
    }
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
  (await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)) as { x: number; y: number }

app.whenReady().then(async () => {
  const savedClip = await clipboard.readText()
  try {
    const { sharedDeskBrowser, faceShared } = await import('../../src/main/shared-browser.ts')
    const { registerBrowserIpc } = await import('../../src/main/browser-ipc.ts')
    const { startBrowserUi } = await import('../../src/main/browser-ui.ts')
    const { startPageTurn } = await import('../../src/main/desk/page-lane.ts')
    const { pageAsks } = await import('../../src/main/desk/inapp.ts')
    const fileAsks: string[] = []
    pageAsks.on('ask', (ask) => {
      if (ask.kind === 'file') fileAsks.push(ask.key)
    })
    const bridge = await import('../../src/main/browser-bridge.ts')
    registerBrowserIpc()
    const browser = sharedDeskBrowser()
    startBrowserUi({ browser, window: () => fakeWin as unknown as BrowserWindow })
    const { server, base } = await serve()
    const go = (owner: string, text: string) => call('browser:go', owner, text) as Promise<boolean>
    const nav = (owner: string, a: string) => call('browser:nav', owner, a) as Promise<boolean>
    const head = async (owner: string) => (await (browser.facts?.(owner) ?? null))?.url ?? ''
    const click = async (owner: string, wc: WebContents, sel: string, button = 'left') => {
      const at = await centre(wc, sel)
      for (const type of ['down', 'up']) await call('browser:pointer', owner, { type, x: at.x, y: at.y, button, buttons: type === 'down' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 })
    }

    // 1. navigation
    await browser.goTo!(`${base}/a`, 'chat:A')
    await browser.goTo!(`${base}/c`, 'chat:B')
    check('1 the address field opens /b for A', (await go('chat:A', `${base}/b`)) && (await head('chat:A')).endsWith('/b'))
    check('1 Back shows A', (await nav('chat:A', 'back')) && (await head('chat:A')).endsWith('/a'))
    check('1 Forward shows B', (await nav('chat:A', 'forward')) && (await head('chat:A')).endsWith('/b'))
    const bHits = hits.filter((h) => h === '/b').length
    await nav('chat:A', 'reload')
    check('1 Reload asks the server again', hits.filter((h) => h === '/b').length === bHits + 1)
    const fa = await faceShared('chat:A')
    check('1 the face says A can go back, not forward', fa.canGoBack === true && fa.canGoForward === false && fa.shared === false, JSON.stringify({ ...fa, src: undefined }))
    check('1 chat B is untouched (F1)', (await head('chat:B')).endsWith('/c'))
    const turn = startPageTurn('chat:A')
    await turn.promise
    let backDone = false
    const backing = nav('chat:A', 'back').then(() => (backDone = true))
    await sleep(800)
    const waited = !backDone
    turn.release()
    await backing
    check('1 Back waits for a held step on that window (F1)', waited && (await head('chat:A')).endsWith('/a'))

    // 1b. shared WhatsApp
    await browser.goTo!('https://web.whatsapp.com/?first=1', 'chat:A')
    await browser.goTo!('https://web.whatsapp.com/', 'chat:A')
    await browser.goTo!('https://web.whatsapp.com/', 'chat:B')
    const fw = await faceShared('chat:A')
    check('1b A on WhatsApp: Back and Forward unavailable, shared', fw.shared === true && fw.canGoBack === false && fw.canGoForward === false, JSON.stringify({ ...fw, src: undefined }))
    check('1b Back for A on WhatsApp is refused, the window stays (F10)', (await nav('chat:A', 'back')) === false && (await head('chat:B')).startsWith('https://web.whatsapp.com/') && !(await head('chat:B')).includes('first'))
    const waBefore = waHits.length
    await nav('chat:A', 'reload')
    check('1b Reload on WhatsApp reloads it, B still on WhatsApp', waHits.length === waBefore + 1 && (await head('chat:B')).startsWith('https://web.whatsapp.com/'))
    await go('chat:A', `${base}/c`)
    check("1b an address typed while A shows WhatsApp loads in A's own window", (await head('chat:A')).endsWith('/c') && (await head('chat:B')).startsWith('https://web.whatsapp.com/'))

    // 2. address field
    check('2 example.test opens https://example.test', (await go('chat:A', 'example.test')) && (await head('chat:A')) === 'https://example.test/')
    check('2 plain words search', (await go('chat:A', 'plain words here')) && searched.some((u) => u.includes('q=plain%20words%20here')))
    const before2 = await head('chat:A')
    const refused = [await go('chat:A', 'javascript:alert(1)'), await go('chat:A', 'file:///etc/hosts'), await go('chat:A', 'myapp://x')]
    check('2 javascript:, file: and custom schemes open nothing (F2)', refused.every((r) => r === false) && (await head('chat:A')) === before2)
    const ownWc = wcAt('www.google.com')!
    const waBefore2 = waHits.length
    await go('chat:A', 'web.whatsapp.com')
    check("2 web.whatsapp.com from A lands in the WhatsApp window, not A's own", waHits.length > waBefore2 && (await head('chat:A')).startsWith('https://web.whatsapp.com/') && ownWc.getURL().includes('www.google.com'))

    // 3. upload
    const dir = mkdtempSync(join(tmpdir(), 'bc-up-'))
    const one = join(dir, 'one.txt')
    const two = join(dir, 'two.txt')
    writeFileSync(one, 'one')
    writeFileSync(two, 'two!')
    await browser.goTo!(`${base}/a`, 'chat:A')
    const a = wcAt('/a')!
    answers = [{ canceled: false, filePaths: [one] }]
    await click('chat:A', a, '#one')
    await until(() => dialogCalls.length === 1)
    await sleep(300)
    const oneName = await a.executeJavaScript(`[document.getElementById('one').files[0]?.name, document.getElementById('one').files[0]?.size, document.getElementById('many').files.length].join(',')`)
    check('3 the panel names the site that asks', dialogCalls[0]?.message === `${new URL(base).host} wants a file.`, dialogCalls[0]?.message)
    check('3 one panel, single file, on the Brain window; the file lands in #one only', dialogCalls.length === 1 && !dialogCalls[0].properties.includes('multiSelections') && dialogCalls[0].win === fakeWin && oneName === 'one.txt,3,0', `${JSON.stringify(dialogCalls)} ${oneName}`)
    answers = [{ canceled: false, filePaths: [one, two] }]
    await click('chat:A', a, '#many')
    await until(() => dialogCalls.length === 2)
    await sleep(300)
    const many = await a.executeJavaScript(`Array.from(document.getElementById('many').files).map((f) => f.name).join(',')`)
    check('3 multiple asks for multiple, both land', dialogCalls[1].properties.includes('multiSelections') && many === 'one.txt,two.txt', many)
    answers = [{ canceled: true, filePaths: [] }]
    await click('chat:A', a, '#one')
    await until(() => dialogCalls.length === 3)
    await sleep(300)
    const still = await a.executeJavaScript(`document.getElementById('one').files[0]?.name`)
    check('3 cancel leaves the input and the page answers (F3)', still === 'one.txt' && (await head('chat:A')).endsWith('/a'))
    await bridge.startBrowserBridge({ dir: app.getPath('userData'), script: bridge.bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser, onOpened: () => {} })
    const spec = bridge.browserServer('chat:A')!
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
      }
    })
    const mcp = (method: string, params?: unknown) => new Promise<any>((done) => { const i = ++id; waiting.set(i, done); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
    await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const tools = ((await mcp('tools/list'))?.result?.tools || []) as { inputSchema: { properties?: Record<string, unknown> } }[]
    check('3 no tool takes a file path', tools.every((t) => !Object.keys(t.inputSchema?.properties ?? {}).some((k) => /path|file/i.test(k))))
    const read = (await mcp('tools/call', { name: 'browser_read', arguments: {} }))?.result?.content?.[0]?.text as string
    const field = /#(\d+) button Choose file/.exec(read || '')
    answers = [{ canceled: true, filePaths: [] }]
    const calls3 = dialogCalls.length
    await mcp('tools/call', { name: 'browser_click', arguments: { target: `#${field?.[1] ?? '0'}` } })
    await until(() => dialogCalls.length === calls3 + 1)
    check("3 the AI's click on an upload control opens the panel for the person", dialogCalls.length === calls3 + 1)

    // 3b. asks at once
    await browser.goTo!(`${base}/up`, 'chat:B')
    const bUp = wcAt('/up')!
    answers = ['hold', { canceled: false, filePaths: [two] }]
    const c0 = dialogCalls.length
    await click('chat:A', a, '#one')
    await until(() => dialogCalls.length === c0 + 1)
    await click('chat:B', bUp, '#f')
    await click('chat:A', a, '#many')
    await sleep(600)
    check('3b one panel open; A asking again is refused; B waits (F11)', dialogCalls.length === c0 + 1)
    heldAnswers.shift()!.resolve({ canceled: false, filePaths: [one] })
    await until(() => dialogCalls.length === c0 + 2)
    await sleep(400)
    const aFile = await a.executeJavaScript(`document.getElementById('one').files[0]?.name`)
    const bFile = await bUp.executeJavaScript(`document.getElementById('f').files[0]?.name`)
    check("3b each set of files lands in the input that asked", dialogCalls.length === c0 + 2 && aFile === 'one.txt' && bFile === 'two.txt', `${aFile} ${bFile}`)

    // 3c. (review) a page closed while its ask waits does not hold the queue for every later ask
    answers = ['hold']
    const c1 = dialogCalls.length
    await click('chat:A', a, '#one')
    await until(() => dialogCalls.length === c1 + 1)
    const asked = fileAsks.length
    await click('chat:B', bUp, '#f')
    const queued = await until(() => fileAsks.length === asked + 1)
    await browser.closeOwner!('chat:B')
    await until(() => bUp.isDestroyed())
    heldAnswers.shift()!.resolve({ canceled: true, filePaths: [] })
    await sleep(300)
    answers = [{ canceled: true, filePaths: [] }]
    await click('chat:A', a, '#one')
    const freed = await until(() => dialogCalls.length === c1 + 2, 4000)
    check('3c B closed while its ask waited: no panel for it, and A\'s next ask opens one', queued && bUp.isDestroyed() && freed && dialogCalls.length === c1 + 2, `queued ${queued}, ${dialogCalls.length - c1} panels`)

    // 4. sound
    await browser.goTo!(`${base}/c`, 'chat:B')
    const ownA = wcAt('/a')!
    check('4 a page nobody watches is muted', ownA.isAudioMuted() === true)
    await call('browser:watch', 'chat:A', true)
    check('4 the watched page plays', ownA.isAudioMuted() === false)
    await call('browser:watch', 'chat:A', false)
    check('4 muted again when the watch stops (F4)', ownA.isAudioMuted() === true)
    await browser.goTo!('https://web.whatsapp.com/', 'chat:B')
    await call('browser:watch', 'chat:B', true)
    await call('browser:watch', 'chat:A', true)
    await browser.goTo!('https://web.whatsapp.com/', 'chat:A')
    await sleep(200)
    const wa = wcAt('web.whatsapp.com')!
    check('4 A moving to WhatsApp: its own window goes muted, WhatsApp plays (F13)', ownA.isAudioMuted() === true && wa.isAudioMuted() === false)
    await call('browser:watch', 'chat:A', false)
    check('4 A stopping does not mute WhatsApp while B watches', wa.isAudioMuted() === false)
    await call('browser:watch', 'chat:A', true)
    await browser.goTo!(`${base}/a`, 'chat:A')
    await sleep(200)
    check('4 A moving back: /a plays again', ownA.isAudioMuted() === false)
    await call('browser:watch', 'chat:B', false)
    check('4 nobody on WhatsApp: muted', wa.isAudioMuted() === true)

    // 5. menu
    const m0 = menus.length
    await click('chat:A', ownA, '#tob', 'right')
    await until(() => menus.length > m0)
    const linkMenu = menus[menus.length - 1]
    const copyLink = linkMenu.find((i) => i.label === 'Copy link address')
    copyLink?.click?.()
    await sleep(200)
    check('5 a link menu copies that link', !!copyLink && (await clipboard.readText()) === `${base}/b`, (await clipboard.readText()))
    await clipboard.writeText('pasted-here')
    const m1 = menus.length
    await click('chat:A', ownA, '#box', 'right')
    await until(() => menus.length > m1)
    menus[menus.length - 1].find((i) => i.label === 'Paste')?.click?.()
    await sleep(300)
    check("5 Paste goes into the page's box (F5)", ((await ownA.executeJavaScript(`document.getElementById('box').innerText`)) as string).includes('pasted-here'))
    await ownA.executeJavaScript(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('sel')); getSelection().removeAllRanges(); getSelection().addRange(r) })()`)
    const m2 = menus.length
    await click('chat:A', ownA, '#sel', 'right')
    await until(() => menus.length > m2)
    menus[menus.length - 1].find((i) => i.label === 'Copy')?.click?.()
    await sleep(200)
    check('5 Copy copies the selection', (await clipboard.readText()) === 'Select this sentence', await clipboard.readText())
    await browser.goTo!(`${base}/c`, 'chat:B')
    await call('browser:watch', 'chat:B', true)
    const bWc = wcAt('/c')!
    const cHits = hits.filter((h) => h === '/c').length
    const aHits = hits.filter((h) => h === '/a').length
    const m3 = menus.length
    await click('chat:B', bWc, 'h1', 'right')
    await until(() => menus.length > m3)
    menus[menus.length - 1].find((i) => i.label === 'Reload')?.click?.()
    await until(() => hits.filter((h) => h === '/c').length === cHits + 1)
    check("5 B's menu Reload reloads B, not A (F5)", hits.filter((h) => h === '/c').length === cHits + 1 && hits.filter((h) => h === '/a').length === aHits)
    await browser.goTo!(`${base}/links`, 'chat:A')
    const links = wcAt('/links')!
    const menuAt = async (sel: string) => {
      const n = menus.length
      await click('chat:A', links, sel, 'right')
      await until(() => menus.length > n)
      return menus[menus.length - 1].map((i) => i.label || '')
    }
    const webMenu = await menuAt('#web')
    const fileMenu = await menuAt('#file')
    const appMenu = await menuAt('#app')
    const e0 = external.length
    const webItem = menus[menus.length - 3].find((i) => i.label === 'Open link in your browser')
    webItem?.click?.()
    await sleep(200)
    check('5 an http link can open in your browser (openExternal with it)', webMenu.includes('Open link in your browser') && external[e0] === 'https://example.test/x', JSON.stringify(external))
    check('5 file: and custom-scheme links cannot (F9)', !fileMenu.includes('Open link in your browser') && !appMenu.includes('Open link in your browser') && !external.some((u) => /^(file|myapp):/.test(u)))
    const fpage = join(dir, 'page.html')
    writeFileSync(fpage, '<!doctype html><title>F</title><h1>file page</h1>')
    await browser.goTo!(`file://${fpage}`, 'chat:A')
    const fwc = wcAt('page.html')!
    const n4 = menus.length
    await click('chat:A', fwc, 'h1', 'right')
    await until(() => menus.length > n4)
    check('5 a file: page has no Open page in your browser (F9)', !menus[menus.length - 1].some((i) => i.label === 'Open page in your browser'))
    await call('browser:watch', 'chat:A', false)
    const n5 = menus.length
    await click('chat:A', fwc, 'h1', 'right')
    await sleep(600)
    check('5 a right-click on a small picture builds no menu (F8)', menus.length === n5)

    // 6. print
    const dl = app.getPath('downloads')
    await browser.goTo!(`${base}/a`, 'chat:A')
    const o0 = opened.length
    await call('browser:print', 'chat:A')
    await call('browser:print', 'chat:A')
    const pdfA = join(dl, 'A.pdf')
    const pdfA2 = join(dl, 'A (2).pdf')
    check('6 print writes A.pdf then A (2).pdf and opens each (F6)', existsSync(pdfA) && existsSync(pdfA2) && statSync(pdfA).size > 1000 && readFileSync(pdfA).subarray(0, 4).toString() === '%PDF' && opened.slice(o0).filter((p) => p.endsWith('.pdf')).length === 2)
    check('6 the page never saw a key', (await ownA.executeJavaScript(`document.getElementById('keys').textContent`)) === '')
    await browser.goTo!(`${base}/print`, 'chat:A')
    const pw = wcAt('/print')!
    const o1 = opened.length
    await click('chat:A', pw, '#p')
    await sleep(1200)
    check('6 a small picture: the page print() writes nothing and the page goes on', !existsSync(join(dl, 'a-b- c.pdf')) && opened.length === o1 && (await pw.executeJavaScript(`document.getElementById('after').textContent`)) === 'after-print')
    await call('browser:watch', 'chat:A', true)
    await pw.executeJavaScript(`document.getElementById('after').textContent = ''`)
    await click('chat:A', pw, '#p')
    await until(() => existsSync(join(dl, 'a-b- c.pdf')), 8000)
    await sleep(500)
    check('6 live: a-b- c.pdf, opened once, no dialog, page goes on (F12)', existsSync(join(dl, 'a-b- c.pdf')) && opened.slice(o1).length === 1 && (await pw.executeJavaScript(`document.getElementById('after').textContent`)) === 'after-print')
    await call('browser:watch', 'chat:A', false)
    await browser.goTo!(`${base}/print?loop`, 'chat:D')
    await call('browser:watch', 'chat:D', true)
    const lw = wcAt('/print?loop')!
    const pdfsBefore = readdirSync(dl).filter((f) => f.startsWith('a-b- c')).length
    const o2 = opened.length
    await click('chat:D', lw, '#p')
    await sleep(4000)
    const pdfsAfter = readdirSync(dl).filter((f) => f.startsWith('a-b- c')).length
    const counted = Number(await lw.executeJavaScript(`document.getElementById('n').textContent`))
    check('6 print() in a loop while live: one PDF, opened once, the page kept running (F12)', pdfsAfter === pdfsBefore + 1 && opened.slice(o2).length === 1 && counted >= 20, `${pdfsAfter - pdfsBefore} pdfs, ${opened.slice(o2).length} opens, counter ${counted}`)
    // (review) The cooldown is the page's own print(); a person's Print to PDF inside it still writes one.
    const mp = menus.length
    await click('chat:D', lw, '#p', 'right')
    await until(() => menus.length > mp)
    menus.at(-1)?.find((i) => i.label === 'Print to PDF')?.click?.()
    const menuPdf = await until(() => readdirSync(dl).filter((f) => f.startsWith('a-b- c')).length === pdfsAfter + 1, 8000)
    check('6 Print to PDF from the menu inside the page cooldown still writes one', menuPdf)
    await call('browser:watch', 'chat:D', false)

    // 7. downloads
    await browser.goTo!(`${base}/a`, 'chat:A')
    await browser.goTo!(`${base}/c`, 'chat:B')
    const s0 = sent.length
    await click('chat:A', wcAt('/a')!, '#dl')
    await until(() => sent.slice(s0).some((s) => s.channel === 'browser:download'), 8000)
    const d1 = sent.slice(s0).filter((s) => s.channel === 'browser:download').map((s) => s.payload as { owner: string; state: string; name: string })
    check('7 a download reaches chat A only, completed (F7)', d1.length === 1 && d1[0].owner === 'chat:A' && d1[0].state === 'completed' && d1[0].name === 'file.txt', JSON.stringify(d1))
    const s1 = sent.length
    await browser.goTo!(`${base}/broken`, 'chat:A')
    await until(() => sent.slice(s1).some((s) => s.channel === 'browser:download'), 10000)
    const d2 = sent.slice(s1).filter((s) => s.channel === 'browser:download').map((s) => s.payload as { owner: string; state: string })
    check('7 a broken download reports interrupted to A', d2.length === 1 && d2[0].owner === 'chat:A' && d2[0].state === 'interrupted', JSON.stringify(d2))
    await browser.goTo!('https://web.whatsapp.com/', 'chat:A')
    await browser.goTo!('https://web.whatsapp.com/', 'chat:B')
    await browser.goTo!(`${base}/c`, 'chat:C')
    const s2 = sent.length
    await click('chat:A', wcAt('web.whatsapp.com')!, '#wadl')
    await until(() => sent.slice(s2).filter((s) => s.channel === 'browser:download').length >= 2, 8000)
    await sleep(300)
    const d3 = sent.slice(s2).filter((s) => s.channel === 'browser:download').map((s) => (s.payload as { owner: string }).owner).sort()
    check('7 a WhatsApp download reaches A and B, not C', JSON.stringify(d3) === JSON.stringify(['chat:A', 'chat:B']), JSON.stringify(d3))

    child.kill()
    bridge.stopBrowserBridge()
    server.close()
    log('BROWSER_CONTROLS_PASS')
    await clipboard.writeText(savedClip)
    app.exit(0)
  } catch (e) {
    log(`BROWSER_CONTROLS_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    await clipboard.writeText(savedClip)
    app.exit(1)
  }
})
app.on('window-all-closed', () => {})
