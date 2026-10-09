// Runs under Electron (see scripts/check-in-app-browser.ts). Phase 1 is the whole check; phase 2 only proves
// the cookie phase 1 saved is still there after a restart on the same userData.
import './set-paths.ts'
import { app, BaseWindow, BrowserWindow, clipboard, nativeImage, session, type WebContents, type WebContentsView } from 'electron'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapClick } from '../../src/shared/page-picture.ts'
import { BROWSER_RULE } from '../../src/shared/chat-reach.ts'
import { clickShared, closeShared, faceShared, keyShared, openSharedPage, pointerShared, sharedDeskBrowser, typeShared, watchShared, wheelShared } from '../../src/main/shared-browser.ts'
import { BROWSER_PARTITION, VIEW } from '../../src/main/desk/inapp.ts'
import { bridgeAddress, bridgeScriptPath, browserServer, socketPath, startBrowserBridge, stopBrowserBridge } from '../../src/main/browser-bridge.ts'
import { claudeChatArgs, claudeKillAll, claudePrompt, claudeWarm } from '../../src/main/claude-stream.ts'
import { chatEnv, ensureChatShims } from '../../src/main/chat-env.ts'
import { ptyEnv } from '../../src/main/pty.ts'
import { ensureShims, factoryEnv } from '../../src/main/factory/gates.ts'
import { acpKillAll, acpPrompt, acpResume, acpWarm, sessionLoadParams, sessionNewParams } from '../../src/main/acp-session.ts'
import { codexKillAll, codexPrompt, codexWarm } from '../../src/main/codex-app.ts'
import { LineRpc } from '../../src/main/line-rpc.ts'
import { binEnv, projectBinEnv, resolveBin } from '../../src/main/ai-cli.ts'

const ROOT = process.env.BB_ROOT || process.cwd()
const PHASE = process.env.BB_PHASE || '1'
const TRACE = process.env.BB_TRACE || join(ROOT, 'plans', '20261008-inline-browser-check.txt')
const SHOTS = join(ROOT, 'plans', '20261008-inline-browser-shots')
const userData = app.getPath('userData')
mkdirSync(SHOTS, { recursive: true })
if (PHASE === '1') writeFileSync(TRACE, `in-app browser check ${new Date().toISOString()} userData ${userData}\n`)

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
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([work, new Promise<never>((_, no) => (t = setTimeout(() => no(new Fail(`${what} passed ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t))
}

const FORM = `<!doctype html><title>Form page</title><h1>Purple Walrus 42</h1>
<a id="next" href="/next" style="display:inline-block;margin:30px;padding:20px">Next page</a>
<a href="/next" target="_blank">New window link</a>
<button onclick="window.open('/next')">Pop window</button>
<div id="box" contenteditable="true" aria-label="Message box" style="border:1px solid #888;min-height:40px;width:400px"></div>
<p id="echo">nothing yet</p>
<button id="buy" onclick="document.getElementById('bought').textContent='purchased'">Buy now</button>
<p id="bought">not bought</p>
<a href="/file.txt">Download file</a>
<button onclick="Notification.requestPermission().then((r) => (document.getElementById('perm').textContent += ' notif:' + r))">Ask notifications</button>
<button onclick="navigator.geolocation.getCurrentPosition(() => (document.getElementById('perm').textContent += ' geo:granted'), (e) => (document.getElementById('perm').textContent += ' geo:denied' + e.code))">Ask location</button>
<p id="perm">perm:</p>
<script>
const box = document.getElementById('box')
box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('echo').textContent = 'echo: ' + box.innerText.trim() } })
</script>`

const PAGES: Record<string, string> = {
  '/form': FORM,
  '/next': '<!doctype html><title>Next</title><h1>Next page</h1><p>You arrived.</p>',
  '/tall': '<!doctype html><title>Tall</title><h1>Tall page</h1><div style="height:5000px"></div><p>bottom</p>',
  '/login': '<!doctype html><title>Log in</title><h1>Welcome back</h1><form><input name="u" placeholder="Email"><input type="password" name="p" placeholder="Password"><button>Log in</button></form>',
  '/checkout': `<!doctype html><title>Checkout</title><h1>Checkout</h1>
<form onsubmit="event.preventDefault(); document.getElementById('bought').textContent = 'purchased'"><input name="card" placeholder="Card"><button type="submit">Buy now</button></form>
<p id="bought">not bought</p>`,
  '/search': `<!doctype html><title>Search</title><h1>Search</h1>
<form onsubmit="event.preventDefault(); document.getElementById('found').textContent = 'searched'"><input name="q" placeholder="Query"><button type="submit">Search</button>
<button type="button" id="buyin" onclick="document.getElementById('bought').textContent = 'purchased'">Buy now</button></form>
<p id="found">no search</p><p id="bought">not bought</p>`,
  '/qr': '<!doctype html><title>WhatsApp</title><h1>Use WhatsApp on your computer</h1><canvas aria-label="Scan this QR code to link a device!" width="200" height="200"></canvas>',
  '/scantext': '<!doctype html><title>Help</title><h1>How to link</h1><p>Scan to log in with your phone.</p>',
  '/input': `<!doctype html><title>Input</title>
<input id="f1" value="hello world here" style="font-size:28px;width:520px;display:block;margin:20px">
<input id="f2" value="second" style="font-size:28px;width:520px;display:block;margin:20px">
<div id="hover" style="width:240px;height:90px;margin:20px;background:#ddd">hover me</div><p id="log"></p>
<script>document.getElementById('hover').addEventListener('mouseover', () => { document.getElementById('log').textContent += 'over;' })</script>`,
  '/setcookie': '<!doctype html><title>Set cookie</title><h1>Cookie set</h1><script>document.cookie = "brain=1; max-age=3600; path=/"</script>',
  '/cookie': '<!doctype html><title>Cookie</title><h1>Cookie page</h1><p id="c"></p><script>document.getElementById("c").textContent = "cookies: " + (document.cookie || "none")</script>'
}

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/hang') return
    if (path === '/file.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="file.txt"' })
      res.end('downloaded by the check')
      return
    }
    const body = PAGES[path]
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
type ToolOut = { text: string; isError: boolean; image: string | null }
async function tool(mcp: Mcp, name: string, args: Record<string, unknown> = {}, ms = 45_000): Promise<ToolOut> {
  const m = await deadline(mcp.call('tools/call', { name, arguments: args }), ms, name)
  const content = (m?.result?.content || []) as { type: string; text?: string; data?: string }[]
  return {
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    isError: !!m?.result?.isError,
    image: content.find((c) => c.type === 'image')?.data ?? null
  }
}

function views(): WebContents[] {
  return BaseWindow.getAllWindows()
    .flatMap((w) => (w.isDestroyed() ? [] : (w.contentView.children as WebContentsView[])))
    .map((v) => v.webContents)
    .filter((wc) => wc && !wc.isDestroyed())
}
const wcAt = (part: string) => views().filter((wc) => wc.getURL().includes(part))
const visible = () => BrowserWindow.getAllWindows().length + BaseWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length

function picture(b64: string | null) {
  const buf = Buffer.from(b64 || '', 'base64')
  const img = nativeImage.createFromBuffer(buf)
  const size = img.getSize()
  const bmp = img.toBitmap()
  const seen = new Set<number>()
  for (let i = 0; i + 4 <= bmp.length && seen.size < 50; i += 4 * 211) seen.add(bmp.readUInt32LE(i))
  return { buf, width: size.width, height: size.height, colours: seen.size }
}
const realPicture = (p: ReturnType<typeof picture>) => p.width === VIEW.width && p.height === VIEW.height && p.buf.length > 5000 && p.colours > 3

function rawCall(sock: string, body: unknown): Promise<any> {
  return new Promise((done) => {
    const s = connect(sock, () => s.write(JSON.stringify(body) + '\n'))
    let buf = ''
    s.on('data', (d) => (buf += d))
    s.on('close', () => done(buf ? JSON.parse(buf.split('\n')[0]) : null))
    s.on('error', () => done(null))
  })
}

/** Browser main processes by executable path (helpers end in "Helper…" and never match). */
function chromeMains(): string[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim())
  return rows.filter((l) => /\/MacOS\/(Google Chrome|Google Chrome for Testing|Chromium)$/.test(l)).map((l) => l.split(/\s+/)[0])
}

/** Google Chrome's window and tab counts, only when it is already running (asking a closed Chrome would start it). */
function chromeTabs(): string | null {
  const running = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some((l) => l.trim().endsWith('/Google Chrome.app/Contents/MacOS/Google Chrome'))
  if (!running) return null
  // A running Chrome sometimes answers one Apple Event with -600 (not running); ask again before calling it a failure.
  let last = ''
  for (let tries = 0; tries < 3; tries++) {
    try {
      return execFileSync('osascript', ['-e', 'tell application "Google Chrome"\nset n to 0\nrepeat with w in windows\nset n to n + (count of tabs of w)\nend repeat\nreturn ((count of windows) as text) & "/" & (n as text)\nend tell'], { encoding: 'utf8' }).trim()
    } catch (e) {
      last = String((e as Error).message).slice(0, 60)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
    }
  }
  return `osascript failed: ${last}`
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = binEnv()
  delete env.ANTHROPIC_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** One real CLI process, read as JSON lines. */
function cli(bin: string, args: string[], cwd: string, ms: number, feed: (child: ChildProcess, lines: AsyncIterable<any>) => Promise<string>): Promise<string> {
  const child = spawn(bin, args, { cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
  async function* lines() {
    let buf = ''
    for await (const d of child.stdout!) {
      buf += d
      let n
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n)
        buf = buf.slice(n + 1)
        try {
          yield JSON.parse(line)
        } catch {
          // a non-JSON line
        }
      }
    }
  }
  return deadline(feed(child, lines()), ms, `${bin} turn`).finally(() => child.kill())
}

async function readUntil(mcp: Mcp, test: RegExp, ms: number): Promise<string> {
  const end = Date.now() + ms
  let last = ''
  while (Date.now() < end) {
    last = (await tool(mcp, 'browser_read')).text
    if (test.test(last)) return last
    await sleep(1000)
  }
  return last
}

async function phaseTwo() {
  const { server, base } = await serve()
  await startBrowserBridge({ dir: userData, script: bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser: sharedDeskBrowser(), onOpened: () => {} })
  const p = await mcpFor('chat:P2')
  const got = await tool(p, 'browser_open', { url: `${base}/cookie` })
  check('5 the cookie saved in phase one is still there after a restart', /cookies: .*brain=1/.test(got.text), got.text)
  p.kill()
  stopBrowserBridge()
  server.close()
  log('PHASE_2_PASS')
}

const sent: { method: string; params: any }[] = []
const passOn = LineRpc.prototype.request
LineRpc.prototype.request = function (method: string, params: unknown, timeoutMs?: number) {
  sent.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) })
  return passOn.call(this, method, params, timeoutMs)
}

async function phaseOne() {
  const chromeBefore = new Set(chromeMains())
  const { server, base } = await serve()
  const opened: string[] = []
  const openedUrls: { owner: string; url: string }[] = []
  const onOpened = (o: string, u?: string) => {
    opened.push(o)
    if (u) openedUrls.push({ owner: o, url: u })
  }
  ensureChatShims(join(ROOT, 'src', 'main', 'open-guard.cjs'))
  const bridge = await startBrowserBridge({
    dir: userData,
    script: bridgeScriptPath({ appPath: ROOT }),
    exec: process.execPath,
    browser: sharedDeskBrowser(),
    onOpened
  })
  log(`bridge ${bridge.sock}`)

  const a = await mcpFor('chat:A')
  const listed = await a.call('tools/list')
  const names = ((listed?.result?.tools || []) as { name: string }[]).map((t) => t.name).sort()
  const want = ['browser_click', 'browser_close', 'browser_key', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_scroll', 'browser_type', 'whatsapp_send']
  check('1 tools/list has exactly the 9 tools', JSON.stringify(names) === JSON.stringify(want), names.join(','))
  const t0 = Date.now()
  const first = await tool(a, 'browser_open', { url: `${base}/form` })
  check('1 browser_open returns the heading and numbered controls (F2: under 45 s)', /Purple Walrus 42/.test(first.text) && /#1 link Next page/.test(first.text), `${Date.now() - t0} ms ${first.text}`)
  check('1 browser:opened went to chat:A only (F7)', opened.length > 0 && opened.every((o) => o === 'chat:A'), opened.join(','))

  const face1 = picture((await faceShared('chat:A')).src)
  const shot1 = picture((await tool(a, 'browser_screenshot')).image)
  writeFileSync(join(SHOTS, 'form.jpg'), face1.buf)
  check('2 the thread picture is 1100x800 and a real page (F1, F3)', realPicture(face1), `${face1.width}x${face1.height} ${face1.buf.length} B ${face1.colours} colours`)
  check('2 browser_screenshot is the same kind of picture', realPicture(shot1), `${shot1.width}x${shot1.height} ${shot1.buf.length} B`)

  const formWc = wcAt('/form')[0]
  const css = (await formWc.executeJavaScript(`(() => { const r = document.querySelector('#next').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)) as { x: number; y: number }
  const mapped = mapClick({ x: css.x / 2, y: css.y / 2 }, { width: 550, height: 400 }, { width: face1.width, height: face1.height })
  check('3 mapClick on a half-size picture returns the CSS centre', !!mapped && Math.abs(mapped.x - css.x) <= 1 && Math.abs(mapped.y - css.y) <= 1, `${JSON.stringify(css)} -> ${JSON.stringify(mapped)}`)
  await clickShared('chat:A', mapped!.x, mapped!.y)
  const afterClick = await readUntil(a, /URL: .*\/next/, 8000)
  check('3 the picture click navigated (F1)', /URL: .*\/next/.test(afterClick) && /Next page/.test(afterClick), afterClick)
  const face2 = picture((await faceShared('chat:A')).src)
  const shot2 = picture((await tool(a, 'browser_screenshot')).image)
  writeFileSync(join(SHOTS, 'next.jpg'), face2.buf)
  check('3 the picture is new after navigating (F3)', realPicture(face2) && realPicture(shot2) && !face2.buf.equals(face1.buf) && !shot2.buf.equals(shot1.buf))

  await tool(a, 'browser_open', { url: `${base}/form` })
  const b = await mcpFor('chat:B')
  await tool(b, 'browser_open', { url: `${base}/next` })
  const [ra, rb] = await Promise.all([tool(a, 'browser_read'), tool(b, 'browser_read')])
  const wa = wcAt('/form'), wb = wcAt('/next')
  check('4 two chats browse at once in their own windows', /Purple Walrus 42/.test(ra.text) && /Next page/.test(rb.text) && wa.length === 1 && wb.length === 1 && wa[0].id !== wb[0].id, `${wa.map((w) => w.id)} ${wb.map((w) => w.id)}`)

  await tool(a, 'browser_open', { url: `${base}/setcookie` })
  const cookieB = await tool(b, 'browser_open', { url: `${base}/cookie` })
  check('5 a cookie set in chat A is seen in chat B (one saved partition)', /cookies: .*brain=1/.test(cookieB.text), cookieB.text)

  await tool(a, 'browser_open', { url: `${base}/form` })
  await tool(a, 'browser_type', { target: 'Message box', text: 'hello from the check' })
  const keyed = await tool(a, 'browser_key', { key: 'enter' })
  check('6 typing into a contenteditable and Enter (asked as "enter") reach the page (F6)', /echo: hello from the check/.test(keyed.text), keyed.text)
  const badKey = await tool(a, 'browser_key', { key: 'Foo' })
  check('6 an unknown key name is an error, not a silent no-op', badKey.isError && /No key named "Foo"/.test(badKey.text), badKey.text)
  const boxAt = (await wcAt('/form')[0].executeJavaScript(`(() => { const r = document.getElementById('box').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 } })()`)) as { x: number; y: number }
  await clickShared('chat:A', boxAt.x, boxAt.y)
  await typeShared('chat:A', 'Z')
  await sleep(300)
  const boxText = (await wcAt('/form')[0].executeJavaScript(`document.getElementById('box').innerText`)) as string
  check('6 the picture typing path reaches the page', boxText.includes('Z'), JSON.stringify(boxText))
  await tool(a, 'browser_open', { url: `${base}/tall` })
  await wheelShared('chat:A', 600)
  await sleep(600)
  const scrolled = (await wcAt('/tall')[0].executeJavaScript('window.scrollY')) as number
  check('6 the picture wheel path scrolls the page', scrolled > 0, `scrollY ${scrolled}`)

  const vis0 = visible()
  await tool(a, 'browser_open', { url: `${base}/form` })
  await tool(a, 'browser_click', { target: 'New window link' })
  const blank = await readUntil(a, /URL: .*\/next/, 8000)
  await tool(a, 'browser_open', { url: `${base}/form` })
  await tool(a, 'browser_click', { target: 'Pop window' })
  const popped = await readUntil(a, /URL: .*\/next/, 8000)
  check('7 target=_blank and window.open load in the same window (F5)', /URL: .*\/next/.test(blank) && /URL: .*\/next/.test(popped), `${blank.slice(0, 80)} | ${popped.slice(0, 80)}`)
  check('7 no visible window and nothing in BrowserWindow.getAllWindows (F18)', vis0 === 0 && visible() === 0 && BrowserWindow.getAllWindows().length === 0, `${vis0} -> ${visible()}`)

  await tool(a, 'browser_open', { url: `${base}/form` })
  const buy = await tool(a, 'browser_click', { target: 'Buy now' })
  const bought = (await wcAt('/form')[0].executeJavaScript(`document.getElementById('bought').textContent`)) as string
  check('8 Buy now is not clicked by the agent (F13)', buy.isError && /can spend money/.test(buy.text) && /click it themselves/.test(buy.text) && bought !== 'purchased', `${buy.text} / ${bought}`)
  const boughtNow = async (part: string) => (await wcAt(part)[0].executeJavaScript(`document.getElementById('bought').textContent`)) as string
  const typeByName = await tool(a, 'browser_type', { target: 'Buy now', text: '' })
  const buyNumber = (/#(\d+) button Buy now/.exec((await tool(a, 'browser_read')).text) || [])[1]
  const typeByNumber = await tool(a, 'browser_type', { target: `#${buyNumber}`, text: 'x' })
  check('8 browser_type on Buy now, by name or number, does not press it', typeByName.isError && typeByNumber.isError && /can spend money/.test(typeByName.text + typeByNumber.text) && (await boughtNow('/form')) !== 'purchased', `${typeByName.text} | #${buyNumber} ${typeByNumber.text}`)
  await wcAt('/form')[0].executeJavaScript(`document.getElementById('buy').focus()`)
  const enterOnBuy = await tool(a, 'browser_key', { key: 'Enter' })
  const spaceOnBuy = await tool(a, 'browser_key', { key: 'Space' })
  check('8 Enter or Space on a focused Buy now outside a form is held', enterOnBuy.isError && spaceOnBuy.isError && /can spend money/.test(enterOnBuy.text + spaceOnBuy.text) && (await boughtNow('/form')) !== 'purchased', `${enterOnBuy.text} | ${spaceOnBuy.text}`)
  await tool(a, 'browser_open', { url: `${base}/search` })
  await wcAt('/search')[0].executeJavaScript(`document.getElementById('buyin').focus()`)
  const enterInForm = await tool(a, 'browser_key', { key: 'Enter' })
  check('8 Enter on a focused type=button Buy now, in a form whose submit is Search, is held', enterInForm.isError && /"Buy now"/.test(enterInForm.text) && (await boughtNow('/search')) !== 'purchased', enterInForm.text)
  await tool(a, 'browser_open', { url: `${base}/checkout` })
  await tool(a, 'browser_type', { target: 'Card', text: '4242' })
  const payEnter = await tool(a, 'browser_key', { key: 'Enter' })
  const paid = (await wcAt('/checkout')[0].executeJavaScript(`document.getElementById('bought').textContent`)) as string
  check('8 Enter in a pay form is held the same way (F13, F20)', payEnter.isError && /can spend money/.test(payEnter.text) && paid !== 'purchased', `${payEnter.text} / ${paid}`)

  const downloads = app.getPath('downloads')
  const ses = session.fromPartition(BROWSER_PARTITION)
  const saved: { state: string; path: string }[] = []
  ses.on('will-download', (_e, item) => item.once('done', (_d, state) => saved.push({ state, path: item.getSavePath() })))
  await tool(a, 'browser_open', { url: `${base}/form` })
  check('9 nothing visible before the download', visible() === 0 && BrowserWindow.getAllWindows().length === 0)
  await tool(a, 'browser_click', { target: 'Download file' })
  for (let i = 0; i < 50 && !saved.length; i++) await sleep(200)
  check('9 the download completed into the downloads folder with nobody answering anything', saved.length === 1 && saved[0].state === 'completed' && saved[0].path === join(downloads, 'file.txt') && existsSync(join(downloads, 'file.txt')), JSON.stringify(saved))
  check('9 nothing visible after the download', visible() === 0 && BrowserWindow.getAllWindows().length === 0)
  await tool(a, 'browser_click', { target: 'Ask notifications' })
  check('9 nothing visible after the notification request', visible() === 0 && BrowserWindow.getAllWindows().length === 0)
  await tool(a, 'browser_click', { target: 'Ask location' })
  const perm = await readUntil(a, /notif:\w+[\s\S]*geo:\w+|geo:\w+[\s\S]*notif:\w+/, 8000)
  check('9 nothing visible after the location request', visible() === 0 && BrowserWindow.getAllWindows().length === 0)
  check('9 notification and location requests are denied', /notif:denied/.test(perm) && /geo:denied1/.test(perm), perm.match(/perm:.*/)?.[0] || perm)

  const login = await tool(a, 'browser_open', { url: `${base}/login` })
  check('10 a sign-in page tells the agent to ask the person', /wants a sign-in/.test(login.text), login.text)
  // The person moves the page on (the bare-address path). The agent's next click starts a new session on it.
  await sharedDeskBrowser().goTo!(`${base}/form`, 'chat:A')
  await tool(a, 'browser_click', { target: 'Next page' })
  const afterLogin = await readUntil(a, /URL: .*\/next/, 8000)
  check('10 a click after a sign-in works on the page that is now shown (F19)', /Next page/.test(afterLogin), afterLogin)

  await openSharedPage(`${base}/next`, 'chat:Q')
  const q = await mcpFor('chat:Q')
  const qRead = await tool(q, 'browser_read')
  check('10 a page opened by a bare-address send is readable by that chat\'s tools without browser_open', !qRead.isError && /Next page/.test(qRead.text), qRead.text)
  q.kill()
  await closeShared('chat:Q')

  const hostsBefore = BaseWindow.getAllWindows().length
  const waA = await tool(a, 'browser_open', { url: 'https://web.whatsapp.com' })
  const waB = await tool(b, 'browser_open', { url: 'https://web.whatsapp.com' })
  const waSays = await readUntil(b, /wants a sign-in/, 25_000)
  writeFileSync(join(SHOTS, 'whatsapp.jpg'), picture((await faceShared('chat:B')).src).buf)
  const waText = String(await wcAt('web.whatsapp.com')[0].executeJavaScript('document.body.innerText'))
  check('11 WhatsApp is the scan-to-log-in page, not the unsupported-browser page', /Scan to log in|Log in with phone number/i.test(waText) && !/works with Google Chrome|update (Google Chrome|your browser)/i.test(waText), `${waA.text.slice(0, 60)} | ${waText.slice(0, 160)}`)
  check('5b WhatsApp\'s QR page is a sign-in for the tool and the thread picture (just works 5)', /wants a sign-in/.test(waSays) && (await faceShared('chat:B')).signIn, waSays.slice(0, 120))
  check('11 two chats share one WhatsApp window (F4)', BaseWindow.getAllWindows().length === hostsBefore + 1 && wcAt('web.whatsapp.com').length === 1, `${hostsBefore} -> ${BaseWindow.getAllWindows().length}, ${waB.isError}`)
  const waWc = wcAt('web.whatsapp.com')[0]
  await tool(a, 'browser_close')
  check('11 a chat closing leaves WhatsApp open (F4)', !waWc.isDestroyed())

  await tool(b, 'browser_open', { url: `${base}/form?b` })
  const bWc = wcAt('/form?b')[0]
  await tool(b, 'browser_close')
  check('12 browser_close destroys that chat\'s own window (F15)', !!bWc && bWc.isDestroyed())
  const c = await mcpFor('chat:C')
  await tool(c, 'browser_open', { url: `${base}/form?c` })
  const cWc = wcAt('/form?c')[0]
  await closeShared('chat:C')
  await sleep(200)
  check('12 the tab-close path destroys that chat\'s window (F15)', !!cWc && cWc.isDestroyed())
  check('12 WhatsApp is still open after both closes', !waWc.isDestroyed())

  const mode = statSync(bridge.sock).mode & 0o777
  check('13 the socket is owner-only (0600)', mode === 0o600, mode.toString(8))
  const before = views().map((wc) => wc.getURL()).sort().join(' ')
  const wrong = await rawCall(bridge.sock, { token: 'nope', owner: 'chat:A', tool: 'browser_open', args: { url: `${base}/next` } })
  const none = await rawCall(bridge.sock, { owner: 'chat:A', tool: 'browser_open', args: { url: `${base}/next` } })
  check('13 a wrong token and no token are refused and change nothing (F12)', wrong?.ok === false && none?.ok === false && views().map((wc) => wc.getURL()).sort().join(' ') === before, `${JSON.stringify(wrong)} ${JSON.stringify(none)}`)
  const tHang = Date.now()
  const hang = await tool(c, 'browser_open', { url: `${base}/hang` }, 45_000)
  check('13 a page that never answers returns inside 45 s (F14)', Date.now() - tHang < 45_000, `${Date.now() - tHang} ms ${hang.text.slice(0, 80)}`)
  const oldToken = bridge.token
  stopBrowserBridge()
  check('13 the socket file is gone after stop (F17)', !existsSync(bridge.sock))
  const cwd = mkdtempSync(join(tmpdir(), 'bb-cli-'))
  const baseArgs = claudeChatArgs({ tabId: 'base', model: 'sonnet', effort: 'low', plan: false })
  check('15 with the bridge stopped, Claude gets no browser args', !baseArgs.includes('--mcp-config'))
  const again = await startBrowserBridge({ dir: userData, script: bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser: sharedDeskBrowser(), onOpened })
  const stale = await rawCall(again.sock, { token: oldToken, owner: 'chat:A', tool: 'browser_open', args: { url: `${base}/next` } })
  check('13 a second start listens, and the first run\'s token is refused (F12, F17)', existsSync(again.sock) && again.token !== oldToken && stale?.ok === false, JSON.stringify(stale))
  a.kill()
  b.kill()
  c.kill()

  const owner = 'chat:Z'
  const grokNew = JSON.stringify(sessionNewParams('grok', cwd, 'chat', undefined, owner))
  const cursorNew = JSON.stringify(sessionNewParams('cursor', cwd, 'chat', undefined, owner))
  const grokLoad = JSON.stringify(sessionLoadParams('grok', 'sid', cwd, 'chat', owner))
  const cursorLoad = JSON.stringify(sessionLoadParams('cursor', 'sid', cwd, 'chat', owner))
  check('14 chat session/new and session/load carry the server for that owner', [grokNew, cursorNew, grokLoad, cursorLoad].every((p) => p.includes('"brain-browser"') && p.includes(owner)))
  check('14 factory session/new and session/load still send no MCP servers', [
    sessionNewParams('grok', cwd, 'factory'),
    sessionNewParams('cursor', cwd, 'factory'),
    sessionLoadParams('grok', 'sid', cwd, 'factory'),
    sessionLoadParams('cursor', 'sid', cwd, 'factory')
  ].every((p) => JSON.stringify(p.mcpServers) === '[]'))
  const grokRules = String((sessionNewParams('grok', cwd, 'chat', undefined, owner)._meta as { rules?: string }).rules)
  const cArgs = claudeChatArgs({ tabId: 'Z', model: 'sonnet', effort: 'low', plan: false })
  const appended = cArgs[cArgs.indexOf('--append-system-prompt') + 1] || ''
  const configFile = cArgs[cArgs.indexOf('--mcp-config') + 1] || ''
  const configText = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  check('14 the browser rule is in Grok\'s chat rules and Claude\'s system prompt', grokRules.includes(BROWSER_RULE) && appended.includes(BROWSER_RULE))
  check('14 Claude gets its config as an owner-only file; the token is in the file and on no command line', configFile.startsWith(userData) && (statSync(configFile).mode & 0o777) === 0o600 && configText.includes(again.token) && configText.includes('chat:Z') && !cArgs.join(' ').includes(again.token), `${configFile} ${(statSync(configFile).mode & 0o777).toString(8)}`)

  const ask = `Use the browser tools to open ${base}/form and reply with only the page's main heading.`
  const claudeBin = resolveBin('claude') || 'claude'
  const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with only OK.' }] } }) + '\n'
  let baseServers: string[] = []
  // Claude lists MCP servers when the first message arrives. Both runs wait until the claude.ai connectors
  // have loaded, because Claude then hides plugin servers they replace (the Twilio docs plugin), in any session.
  const settled = 25_000
  await cli(claudeBin, baseArgs, cwd, 240_000, async (child, lines) => {
    await sleep(settled)
    child.stdin!.write(userLine)
    for await (const m of lines) {
      if (m.type === 'system' && m.subtype === 'init') baseServers = (m.mcp_servers || []).map((s: { name: string }) => s.name)
      if (m.type === 'result') return ''
    }
    return ''
  })
  let tools: string[] = []
  let servers: string[] = []
  const claudeAnswer = await cli(claudeBin, claudeChatArgs({ tabId: 'D', model: 'sonnet', effort: 'low', plan: false }), cwd, 240_000, async (child, lines) => {
    await sleep(settled)
    child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: ask }] } }) + '\n')
    for await (const m of lines) {
      if (m.type === 'system' && m.subtype === 'init') {
        tools = m.tools || []
        servers = (m.mcp_servers || []).map((s: { name: string }) => s.name)
      }
      if (m.type === 'result') return String(m.result || '')
    }
    return ''
  })
  const missing = baseServers.filter((s) => s !== 'control-chrome' && !servers.includes(s))
  check('15 Claude has browser_open and no control-chrome tool (F10)', tools.includes('mcp__brain-browser__browser_open') && !tools.some((t) => t.startsWith('mcp__control-chrome__')), `${tools.length} tools`)
  check('15 Claude keeps every other baseline MCP server (F10)', baseServers.length > 0 && missing.length === 0, `baseline ${baseServers.length}, missing ${missing.join(',')}`)
  check('15 real Claude answered with the heading through the in-app browser', /Purple Walrus 42/.test(claudeAnswer) && opened.includes('chat:D'), claudeAnswer)

  const noop = () => {}
  const prompt = (kind: 'grok' | 'cursor', tabId: string, text = ask) => acpPrompt({ kind, tabId, cwd, text, alwaysApprove: true, onEvent: noop })
  const sentFor = (method: string, owner: string) => sent.filter((m) => m.method === method && JSON.stringify(m.params).includes(`"${owner}"`))

  const e1 = await acpWarm({ kind: 'grok', tabId: 'E1', cwd })
  const e2 = await acpWarm({ kind: 'grok', tabId: 'E2', cwd })
  const [g1, g2] = await deadline(Promise.all([prompt('grok', 'E1'), prompt('grok', 'E2')]), 300_000, 'Grok turns')
  check('16 Grok session/new carried each tab\'s owner', sentFor('session/new', 'chat:E1').length === 1 && sentFor('session/new', 'chat:E2').length === 1)
  check('16 one Grok process, two sessions, each answered through the in-app browser as its own owner (F11)', /Purple Walrus 42/.test(g1) && /Purple Walrus 42/.test(g2) && opened.includes('chat:E1') && opened.includes('chat:E2'), `${g1.slice(0, 80)} | ${g2.slice(0, 80)}`)
  const e3 = await acpWarm({ kind: 'grok', tabId: 'E3', cwd })
  await deadline(prompt('grok', 'E3', 'Reply with only OK.'), 180_000, 'Grok OK turn')

  const f1 = await acpWarm({ kind: 'cursor', tabId: 'F1', cwd })
  const c1 = await deadline(prompt('cursor', 'F1'), 300_000, 'Cursor turn')
  check('17 Cursor session/new carried chat:F1, and real Cursor answered through the in-app browser (F11)', sentFor('session/new', 'chat:F1').length === 1 && /Purple Walrus 42/.test(c1) && opened.includes('chat:F1'), c1.slice(0, 120))
  const f2 = await acpWarm({ kind: 'cursor', tabId: 'F2', cwd })
  await deadline(prompt('cursor', 'F2', 'Reply with only OK.'), 180_000, 'Cursor OK turn')
  const f3 = await acpWarm({ kind: 'cursor', tabId: 'F3', cwd })
  await deadline(prompt('cursor', 'F3', 'Reply with only OK.'), 180_000, 'Cursor OK turn')

  // Fresh processes, so each load really reads the saved session and starts its own MCP server.
  acpKillAll()
  const ids = { grok: [e1.sessionId, e2.sessionId, e3.sessionId], cursor: [f1.sessionId, f2.sessionId, f3.sessionId] }
  for (const kind of ['grok', 'cursor'] as const) {
    const [r1, r2, r3] = ids[kind].map(String)
    check(`17b ${kind} has three saved sessions to load`, !!r1 && !!r2 && !!r3 && new Set([r1, r2, r3]).size === 3, `${r1} ${r2} ${r3}`)
    await acpWarm({ kind, tabId: `W1-${kind}`, cwd, resumeId: r1 })
    await acpWarm({ kind, tabId: `W2-${kind}`, cwd })
    await acpWarm({ kind, tabId: `W2-${kind}`, cwd, resumeId: r2 })
    await acpResume({ kind, tabId: `W3-${kind}`, cwd, sessionId: r3 })
    const loads = [1, 2, 3].map((n) => sentFor('session/load', `chat:W${n}-${kind}`).length)
    check(`17b every chat session/load for ${kind} carries the server with that tab's owner (item 7)`, loads.every((n) => n === 1), loads.join(','))
    const resumed = await deadline(prompt(kind, `W3-${kind}`), 300_000, `${kind} resumed turn`)
    check(`17b a resumed ${kind} tab browses as its own owner`, /Purple Walrus 42/.test(resumed) && opened.includes(`chat:W3-${kind}`), resumed.slice(0, 120))
  }
  acpKillAll()

  const g = await codexWarm({ tabId: 'G', cwd })
  const gx = await deadline(codexPrompt({ tabId: 'G', cwd, text: ask, onEvent: noop }), 300_000, 'Codex turn')
  const started = sentFor('thread/start', 'chat:G')
  check('18 Codex thread/start carried brain_browser for chat:G', started.length === 1 && !!started[0].params?.config?.mcp_servers?.brain_browser, JSON.stringify(started[0]?.params?.config || null))
  check('18 real Codex answered through the in-app browser', /Purple Walrus 42/.test(gx) && opened.includes('chat:G'), gx.slice(0, 120))
  codexKillAll()
  const g2r = await codexWarm({ tabId: 'G2', cwd, resumeId: String(g.sessionId) })
  const resumedCodex = sentFor('thread/resume', 'chat:G2')
  check('18 Codex thread/resume carried the same config for chat:G2 and returned that thread (item 16)', resumedCodex.length === 1 && !!resumedCodex[0].params?.config?.mcp_servers?.brain_browser && g2r.sessionId === g.sessionId, `${JSON.stringify(resumedCodex[0]?.params?.config || null).slice(0, 120)} ${g2r.sessionId} ${g.sessionId}`)
  const gr = await deadline(codexPrompt({ tabId: 'G2', cwd, text: ask, onEvent: noop }), 300_000, 'Codex resumed turn')
  check('18 the resumed Codex tab browses as chat:G2', /Purple Walrus 42/.test(gr) && opened.includes('chat:G2'), gr.slice(0, 120))
  codexKillAll()

  // ── 0.1.136: just works ──────────────────────────────────────────────────────────────────────
  const brainDir = join(homedir(), 'Projects', 'agency-brain')
  const recorder = join(userData, 'open-recorder.sh')
  const recorded = join(userData, 'open-recorded.txt')
  writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${recorded}'\n`)
  chmodSync(recorder, 0o755)
  const openVia = (args: string[]) => {
    rmSync(recorded, { force: true })
    const ran = spawnSync('open', args, { env: { ...chatEnv(), BRAIN_OPEN_BIN: recorder }, encoding: 'utf8' })
    return { code: ran.status, err: ran.stderr || '', rec: existsSync(recorded) ? readFileSync(recorded, 'utf8').trim() : null }
  }
  const refused = [
    ['https://example.com'], ['-a', 'Google Chrome', 'https://example.com'], ['README.md', 'https://example.com'],
    ['https://example.com/sample'], ['https://example.com/devices'], ['https://example.com/association'], ['https://example.com/?callback=x'],
    ['https://example.com/login/devicex'], ['https://example.com/?redirect_uri=x'], ['http://localhost:3000'],
    ['https://example.com/device'], ['https://example.com/login/device'], ['https://example.com/?client_id=a&response_type=code'],
    ['https://github.com/pulls'], ['https://github.com/login/devicex'], ['https://github.com/devices'], ['https://accounts.google.com/o/oauth2/auth?client_id=a'],
    ['https://not.github.com/login/device'], ['https://github.com.evil.com/login/device'], ['https://github.com/login/device', 'https://example.com']
  ]
  const badRefuse = refused.map((args) => ({ args, r: openVia(args) })).filter(({ r }) => !(r.code === 1 && /do not open web pages in Chrome/.test(r.err) && r.rec === null))
  check('J1 the open shim refuses every web page, near-miss and mixed call, and opens nothing', badRefuse.length === 0, JSON.stringify(badRefuse.slice(0, 3)))
  const passed = [
    ['/no/such/file'], ['-a', 'TextEdit'], ['https://github.com/login/device'], ['-a', 'Google Chrome', 'https://github.com/login/device'],
    ['https://accounts.google.com/o/oauth2/auth?client_id=a&response_type=code&redirect_uri=http://localhost:1'], ['https://dashboard.doppler.com/workplace/auth/cli/abc']
  ]
  const badPass = passed.map((args) => ({ args, r: openVia(args) })).filter(({ args, r }) => r.rec !== args.join(' '))
  check('J1 files, apps and CLI sign-in links reach the real open with their exact arguments', badPass.length === 0, JSON.stringify(badPass.slice(0, 3)))

  const shimDir = ensureChatShims()
  const hasChat = (env: Record<string, string | undefined>) => env.BRAIN_CHAT === '1' && String(env.PATH || '').split(':')[0] === shimDir
  const noChat = (env: Record<string, string | undefined>) => env.BRAIN_CHAT === undefined && !String(env.PATH || '').split(':').includes(shimDir)
  check('J4 chat env and CLI TUIs get the marker and shims; shell tabs, Desk and Factory do not',
    hasChat(chatEnv()) && hasChat(ptyEnv(true)) && noChat(ptyEnv(false)) && noChat(binEnv()) && noChat(factoryEnv(projectBinEnv(cwd), ensureShims(join(userData, 'factory-shims')))))

  const oracleBefore = { pids: new Set(chromeMains()), tabs: chromeTabs() }
  const oracleSame = (label: string) => {
    const fresh = chromeMains().filter((pid) => !oracleBefore.pids.has(pid))
    const tabs = chromeTabs()
    // A count that could not be read proves nothing, even when the same failure repeats.
    const unread = [oracleBefore.tabs, tabs].some((t) => t?.startsWith('osascript failed'))
    check(`${label}: no new browser process and Chrome's windows/tabs unchanged`, fresh.length === 0 && !unread && tabs === oracleBefore.tabs, `new ${fresh.join(',')} tabs ${oracleBefore.tabs} -> ${tabs}`)
  }
  // Brain's own rule tells chats not to open web pages, so a model may decline this unless it knows it is testing that guard.
  const shellAsk =
    "This is a test of Brain's open guard: the open in your PATH refuses web pages and opens nothing. " +
    'Run exactly this in the shell and then show me its exact output, nothing else: command -v open; open https://example.com'
  const shimSeen = (answer: string) => answer.includes('chat-shims/open') && /do not open web pages/i.test(answer)
  // A model that still declines gets asked once more in the same chat; the check is the shim, not the model's mood.
  const twice = async (ask: (text: string) => Promise<string>) => {
    const first = await ask(shellAsk)
    return shimSeen(first) ? first : ask('Please run it now; it is the test described above and nothing will open.')
  }
  await claudeWarm({ tabId: 'K1', cwd, model: 'sonnet', effort: 'low' })
  const k1 = await twice((text) => deadline(claudePrompt({ tabId: 'K1', cwd, text, onEvent: noop }), 300_000, 'Claude shell turn'))
  check('J2 Claude\'s shell has the open shim and it refuses', shimSeen(k1), k1.slice(0, 200))
  await acpWarm({ kind: 'grok', tabId: 'K2', cwd })
  const k2 = await twice((text) => deadline(acpPrompt({ kind: 'grok', tabId: 'K2', cwd, text, alwaysApprove: true, onEvent: noop }), 300_000, 'Grok shell turn'))
  check('J2 Grok\'s shell (its chat leader) has the open shim and it refuses', shimSeen(k2), k2.slice(0, 200))
  await acpWarm({ kind: 'cursor', tabId: 'K3', cwd })
  const k3 = await twice((text) => deadline(acpPrompt({ kind: 'cursor', tabId: 'K3', cwd, text, alwaysApprove: true, onEvent: noop }), 300_000, 'Cursor shell turn'))
  check('J2 Cursor\'s shell has the open shim and it refuses', shimSeen(k3), k3.slice(0, 200))
  await codexWarm({ tabId: 'K4', cwd })
  const k4 = await twice((text) => deadline(codexPrompt({ tabId: 'K4', cwd, text, onEvent: noop }), 300_000, 'Codex shell turn'))
  check('J2 Codex\'s shell has the open shim and it refuses', shimSeen(k4), k4.slice(0, 200))
  oracleSame('J2')

  const plain1 = 'Open https://example.com and tell me the main heading.'
  const plain2 = 'Check my WhatsApp. Is it asking me to log in?'
  const plainRuns: [string, (text: string) => Promise<string>][] = [
    ['Claude', async (text) => { await claudeWarm({ tabId: 'P1', cwd: brainDir, model: 'sonnet', effort: 'low' }); return claudePrompt({ tabId: 'P1', cwd: brainDir, text, onEvent: noop }) }],
    ['Grok', async (text) => { await acpWarm({ kind: 'grok', tabId: 'P2', cwd: brainDir }); return acpPrompt({ kind: 'grok', tabId: 'P2', cwd: brainDir, text, alwaysApprove: true, onEvent: noop }) }],
    ['Cursor', async (text) => { await acpWarm({ kind: 'cursor', tabId: 'P3', cwd: brainDir }); return acpPrompt({ kind: 'cursor', tabId: 'P3', cwd: brainDir, text, alwaysApprove: true, onEvent: noop }) }],
    ['Codex', async (text) => { await codexWarm({ tabId: 'P4', cwd: brainDir }); return codexPrompt({ tabId: 'P4', cwd: brainDir, text, onEvent: noop }) }]
  ]
  for (const [i, [name, run]] of plainRuns.entries()) {
    const owner = `chat:P${i + 1}`
    const first = await deadline(run(plain1), 300_000, `${name} plain turn 1`)
    const second = await deadline(run(plain2), 300_000, `${name} plain turn 2`)
    const urls = openedUrls.filter((r) => r.owner === owner).map((r) => r.url)
    check(`J3 ${name}, asked in plain words in the agency brain, used the in-app browser for both`,
      urls.some((u) => /example\.com/.test(u)) && urls.some((u) => /web\.whatsapp\.com/.test(u)) && /Example Domain/i.test(first) && /scan|QR|log ?in|sign ?in|link/i.test(second),
      `${urls.join(' ')} | ${first.slice(0, 80)} | ${second.slice(0, 80)}`)
  }
  oracleSame('J3')
  claudeKillAll()
  acpKillAll()
  codexKillAll()

  const waDir = join(brainDir, 'code', 'whatsapp')
  const stub = join(userData, 'stub-playwright.cjs')
  writeFileSync(stub, `const Module = require('module')
const load = Module._load
Module._load = function (request) {
  const m = load.apply(this, arguments)
  if (request !== 'playwright') return m
  return { ...m, chromium: { launchPersistentContext: async () => { console.log('STUB-LAUNCH'); process.exit(0) } } }
}
`)
  const label = 'bbcheck-throwaway'
  const waRun = (args: string[], chat: boolean) => {
    const env: NodeJS.ProcessEnv = { ...cliEnv() }
    delete env.BRAIN_CHAT
    if (chat) env.BRAIN_CHAT = '1'
    const t = Date.now()
    const ran = spawnSync('node', ['--require', stub, 'wa.cjs', ...args], { cwd: waDir, env, encoding: 'utf8', timeout: 20_000 })
    return { code: ran.status, out: `${ran.stdout}${ran.stderr}`, ms: Date.now() - t }
  }
  const fileForSend = join(userData, 'note.txt')
  writeFileSync(fileForSend, 'x')
  const launching = [['link', label], ['status', label], ['read', label], ['voices', label, '--chat', 'X'], ['reply', label, '--chat', 'X', '--text', 't'], ['send', label, '--chat', 'X', '--file', fileForSend], ['batch', label, '--steps', '[{"action":"read","chat":"X"}]'], ['stay', label]]
  const waOracle = new Set(chromeMains())
  const waBad = launching.map((args) => ({ args, r: waRun(args, true) })).filter(({ r }) => !(r.code === 2 && /use the brain-browser tools on https:\/\/web\.whatsapp\.com/.test(r.out) && !r.out.includes('STUB-LAUNCH') && r.ms < 2000))
  check('J4 every wa.cjs command that would open Chrome stops inside Brain, before launching', waBad.length === 0 && chromeMains().every((pid) => waOracle.has(pid)), JSON.stringify(waBad.slice(0, 2)))
  const selfTest = waRun(['self-test'], true)
  check('J4 wa.cjs self-test still runs inside Brain', /\bok\b/.test(selfTest.out) && !selfTest.out.includes('STUB-LAUNCH'), selfTest.out.slice(-120))
  const withWindow = waRun(['status', label, '--window'], true)
  const outside = waRun(['status', label], false)
  rmSync(join(waDir, 'profiles', label), { recursive: true, force: true })
  check('J4 --window, or running outside Brain, gets past the guard to the launch', withWindow.out.includes('STUB-LAUNCH') && outside.out.includes('STUB-LAUNCH'), `${withWindow.out.slice(-80)} | ${outside.out.slice(-80)}`)

  const v = await mcpFor('chat:V')
  const qr = await tool(v, 'browser_open', { url: `${base}/qr` })
  const qrFace = await faceShared('chat:V')
  const scan = await tool(v, 'browser_open', { url: `${base}/scantext` })
  const scanFace = await faceShared('chat:V')
  check('J5 a QR login canvas is a sign-in; a page that only mentions scanning is not', /wants a sign-in/.test(qr.text) && qrFace.signIn && !/wants a sign-in/.test(scan.text) && !scanFace.signIn, `${qr.text.slice(0, 60)} | ${scan.text.slice(0, 60)}`)

  const u = await mcpFor('chat:U')
  await tool(u, 'browser_open', { url: `${base}/tall` })
  const uFrames: { url: string; src: string }[] = []
  const stopU = watchShared('chat:U', (f) => uFrames.push(f))
  await tool(v, 'browser_open', { url: `${base}/form` })
  const vFrames: { url: string; src: string }[] = []
  const stopV = watchShared('chat:V', (f) => vFrames.push(f))
  const tw = Date.now()
  while (!vFrames.length && Date.now() - tw < 2000) await sleep(50)
  const formFrame = vFrames[vFrames.length - 1]
  check('J6 a watch sends a frame within 2 s (1100x800, this page)', !!formFrame && /\/form$/.test(formFrame.url) && picture(formFrame.src).width === 1100, formFrame?.url)
  await sleep(300)
  const quietFrom = vFrames.length
  await sleep(1000)
  check('J6 a quiet page sends no frame for a second', vFrames.length === quietFrom, `${vFrames.length - quietFrom} frames`)
  const uBefore = uFrames.length
  await tool(v, 'browser_open', { url: `${base}/next` })
  const t1 = Date.now()
  while (!vFrames.some((f) => /\/next$/.test(f.url)) && Date.now() - t1 < 2000) await sleep(50)
  const nextFrame = [...vFrames].reverse().find((f) => /\/next$/.test(f.url))
  check('J6 after navigating, a new frame of the new page arrives within 2 s', !!nextFrame && nextFrame.src !== formFrame?.src, nextFrame?.url)
  check('J6 another place\'s watcher got none of these frames', uFrames.slice(uBefore).every((f) => !/\/(form|next)$/.test(f.url)))
  await tool(v, 'browser_open', { url: 'https://web.whatsapp.com' })
  const t2 = Date.now()
  while (!vFrames.some((f) => /web\.whatsapp\.com/.test(f.url)) && Date.now() - t2 < 5000) await sleep(50)
  const waFrame = [...vFrames].reverse().find((f) => /web\.whatsapp\.com/.test(f.url))
  check('J6 when the place switches to WhatsApp, its frames come from the WhatsApp window', !!waFrame && waFrame.src !== nextFrame?.src, waFrame?.url)
  stopV()
  stopU()
  await tool(v, 'browser_open', { url: `${base}/form` })
  const afterStop = vFrames.length
  await sleep(2000)
  check('J6 after unwatch, a navigation sends nothing', vFrames.length === afterStop)

  await tool(v, 'browser_open', { url: `${base}/input` })
  const inputWc = wcAt('/input')[0]
  const rectOf = async (sel: string) => (await inputWc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom } })()`)) as { l: number; r: number; t: number; b: number }
  const js = (code: string) => inputWc.executeJavaScript(code)
  const box1 = await rectOf('#f1')
  const midY = (box1.t + box1.b) / 2
  const press = (type: 'down' | 'up' | 'move', x: number, y: number, clickCount = 1, buttons = 1) => pointerShared('chat:V', { type, x, y, button: 'left', buttons, clickCount })
  await press('down', box1.l + 6, midY)
  for (let i = 1; i <= 4; i++) await press('move', box1.l + 6 + ((box1.r - box1.l - 12) * i) / 4, midY, 0, 1)
  await press('up', box1.r - 6, midY, 1, 0)
  const sel = (await js('[document.activeElement.id, f1.selectionStart, f1.selectionEnd]')) as [string, number, number]
  check('J7 a drag across the field selects text', sel[0] === 'f1' && sel[2] > sel[1], JSON.stringify(sel))
  const wordX = box1.l + 30
  await press('down', wordX, midY, 1)
  await press('up', wordX, midY, 1, 0)
  await press('down', wordX, midY, 2)
  await press('up', wordX, midY, 2, 0)
  const word = await js('f1.value.slice(f1.selectionStart, f1.selectionEnd)')
  check('J7 a double-click selects one word', word === 'hello', JSON.stringify(word))
  const hv = await rectOf('#hover')
  await pointerShared('chat:V', { type: 'move', x: (hv.l + hv.r) / 2, y: (hv.t + hv.b) / 2, button: 'none', buttons: 0, clickCount: 0 })
  await sleep(100)
  check('J7 moving the mouse over a box fires its mouseover', /over;/.test(String(await js('document.getElementById("log").textContent'))))
  const K = (key: string, code: string, modifiers = 0, extra: Record<string, string> = {}) => keyShared('chat:V', { key, code, modifiers, ...extra })
  await K('Tab', 'Tab')
  const afterTab = await js('document.activeElement.id')
  await K('Tab', 'Tab', 8)
  const afterShiftTab = await js('document.activeElement.id')
  check('J7 Tab moves to the next field and Shift+Tab back', afterTab === 'f2' && afterShiftTab === 'f1', `${afterTab} ${afterShiftTab}`)
  await K('Home', 'Home')
  await K('Delete', 'Delete')
  check('J7 Delete removes a character', (await js('f1.value')) === 'ello world here', JSON.stringify(await js('f1.value')))
  await clipboard.writeText('pasted 7')
  await K('a', 'KeyA', 4, { command: 'selectAll' })
  await K('v', 'KeyV', 4, { command: 'paste' })
  check('J7 Cmd+V pastes the Mac clipboard into the field', (await js('f1.value')) === 'pasted 7', JSON.stringify(await js('f1.value')))
  await K('a', 'KeyA', 4, { command: 'selectAll' })
  await K('x', 'KeyX', 4, { command: 'cut' })
  const cutValue = await js('f1.value')
  const board = await clipboard.readText()
  await K('z', 'KeyZ', 4, { command: 'undo' })
  check('J7 Cmd+A, Cmd+X empties the field into the clipboard and Cmd+Z brings it back', cutValue === '' && board === 'pasted 7' && (await js('f1.value')) === 'pasted 7', `${JSON.stringify(cutValue)} ${JSON.stringify(board)}`)
  await js(`f1.value = 'alpha beta gamma'; f1.focus(); f1.setSelectionRange(16, 16)`)
  await K('ArrowLeft', 'ArrowLeft', 4)
  const atStart = await js('[f1.selectionStart, f1.selectionEnd]')
  await K('ArrowRight', 'ArrowRight', 12)
  const toEnd = await js('f1.value.slice(f1.selectionStart, f1.selectionEnd)')
  await K('ArrowRight', 'ArrowRight')
  await K('ArrowLeft', 'ArrowLeft', 1)
  const wordLeft = await js('f1.selectionStart')
  await K('Backspace', 'Backspace', 1)
  const afterWordDelete = await js('f1.value')
  await K('End', 'End')
  await K('Backspace', 'Backspace', 4)
  const afterLineDelete = await js('f1.value')
  check('J7 Cmd+Left, Cmd+Shift+Right, Option+Left, Option+Backspace and Cmd+Backspace move and delete like a Mac field',
    JSON.stringify(atStart) === '[0,0]' && toEnd === 'alpha beta gamma' && wordLeft === 11 && afterWordDelete === 'alpha gamma' && afterLineDelete === '',
    JSON.stringify({ atStart, toEnd, wordLeft, afterWordDelete, afterLineDelete }))
  u.kill()
  v.kill()

  const macAt = bridgeAddress()
  check('J8 the bridge listens on socketPath for this platform, owner-only', macAt === socketPath(process.platform, userData, process.pid) && (statSync(macAt!).mode & 0o777) === 0o600, String(macAt))
  const winPath = socketPath('win32', userData, process.pid)
  const pipePrefix = String.raw`\\.\pipe\brain-browser-` + `${process.pid}-`
  check('J8 on Windows the path is a named pipe', winPath.startsWith(pipePrefix) && /^[0-9a-f]{8,}$/.test(winPath.slice(pipePrefix.length)), winPath)
  stopBrowserBridge()
  const winCwd = mkdtempSync(join(tmpdir(), 'bb-win-'))
  const sentinel = join(userData, 'browser-999999.sock')
  writeFileSync(sentinel, '')
  const home = process.cwd()
  process.chdir(winCwd)
  try {
    await startBrowserBridge({ dir: userData, script: bridgeScriptPath({ appPath: ROOT }), exec: process.execPath, browser: sharedDeskBrowser(), onOpened, platform: 'win32' })
    const winAt = bridgeAddress()
    const made = winAt ? join(winCwd, winAt) : ''
    check('J8 a win32 start listens on the pipe path, sweeps nothing and chmods nothing', !!winAt && winAt.startsWith(pipePrefix) && existsSync(sentinel) && existsSync(made) && (statSync(made).mode & 0o777) !== 0o600, `${winAt} sentinel ${existsSync(sentinel)}`)
    stopBrowserBridge()
  } finally {
    process.chdir(home)
    rmSync(winCwd, { recursive: true, force: true })
    rmSync(sentinel, { force: true })
  }

  const newChrome = chromeMains().filter((p) => !chromeBefore.has(p))
  check('19 no new Google Chrome main process (F16)', newChrome.length === 0, newChrome.join(','))

  stopBrowserBridge()
  check('19 stopping the bridge removes this run\'s Claude config files', !existsSync(configFile))
  server.close()
  const leaderSock = process.env.BRAIN_GROK_LEADER_SOCK || ''
  // A pool that exits after acpKillAll can start the leader again; it must not outlive the check.
  if (leaderSock) spawnSync('pkill', ['-f', leaderSock])
  for (const f of [leaderSock, leaderSock.replace(/\.sock$/, '.lock')]) if (f) rmSync(f, { force: true })
  log('PHASE_1_PASS')
}

app.whenReady().then(async () => {
  try {
    if (PHASE === '2') await phaseTwo()
    else await phaseOne()
    // quit, not exit, so the saved partition is written to disk before phase two reads it
    app.quit()
  } catch (e) {
    log(`IN_APP_BROWSER_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    app.exit(1)
  }
})
app.on('window-all-closed', () => {})
