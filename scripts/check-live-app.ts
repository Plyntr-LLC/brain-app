// The packed Brain.app, end to end, beside Joe's running Brain without touching it.
// node --experimental-strip-types scripts/check-live-app.ts      (after npm run pack:mac)
// Launches dist/mac-arm64/Brain.app under sandbox-exec (no writes to Joe's brain, Brain userData, Agency Brain
// config, /Applications/Brain.app or his CLI homes), with a temp HOME, temp userData, a scratch local brain, its own
// Grok leader socket and no auto-update. Drives the real window over CDP, and once with a real macOS Cmd+V.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const real = homedir()
const app = join(root, 'dist', 'mac-arm64', 'Brain.app')
const exe = join(app, 'Contents', 'MacOS', 'Brain')
const trace = join(root, 'plans', '20261009-inline-browser-live-app.txt')
const shots = join(root, 'plans', '20261009-inline-browser-shots')
mkdirSync(shots, { recursive: true })
writeFileSync(trace, `live app check ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(trace, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 220)})` : ''}`)
  if (!ok) throw new Fail(name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > end) throw new Fail(`${what} (waited ${ms / 1000} s)`)
    await sleep(250)
  }
}

const joeBrain = join(real, 'Projects', 'agency-brain')
const joeUserData = join(real, 'Library', 'Application Support', 'brain-app')
const abConfigDir = join(real, 'Library', 'Application Support', 'Agency Brain')
const watched = [
  '/Applications/Brain.app/Contents/MacOS/Brain',
  join(abConfigDir, 'config.json'),
  join(joeUserData, 'account.json'),
  join(joeUserData, 'brains.json'),
  join(joeUserData, 'settings.json')
]
const mtimes = () => watched.map((f) => (existsSync(f) ? statSync(f).mtimeMs : -1))

// The fixture: pages report what happened to the server, so the check sees the page from outside Brain.
const events: string[] = []
const rects = new Map<string, { x: number; y: number; w: number; h: number }>()
const report = `<script>
const say = (k, v) => fetch('/log?' + new URLSearchParams({ k, v: String(v) }))
const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(',') }
addEventListener('load', () => { for (const id of ['next', 'back', 'f1', 'box']) if (document.getElementById(id)) say('rect:' + id, box(id)) })
</script>`
const FORM = `<!doctype html><title>Form page</title><h1>Purple Walrus 42</h1>
<a id="next" href="/next" style="display:inline-block;margin:24px;padding:18px;font-size:24px">Next page</a>
<input id="f1" value="hello world here" style="display:block;margin:24px;font-size:28px;width:520px">
<div id="box" contenteditable="true" aria-label="Message box" style="margin:24px;border:1px solid #888;min-height:40px;width:420px"></div>
<script>
f1.addEventListener('mouseup', () => setTimeout(() => say('sel', f1.selectionEnd - f1.selectionStart), 30))
f1.addEventListener('dblclick', () => setTimeout(() => say('word', f1.value.slice(f1.selectionStart, f1.selectionEnd)), 30))
f1.addEventListener('input', () => say('val', f1.value))
document.getElementById('box').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); say('echo', e.target.innerText.trim()) } })
</script>${report}`
const NEXT = `<!doctype html><title>Next</title><h1>Next page</h1><a id="back" href="/form" style="display:inline-block;margin:24px;padding:18px;font-size:24px">Back to form</a>${report}`
const server = createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x')
  if (u.pathname === '/log') {
    const k = u.searchParams.get('k') || ''
    const v = u.searchParams.get('v') || ''
    if (k.startsWith('rect:')) {
      const [x, y, w, h] = v.split(',').map(Number)
      rects.set(k.slice(5), { x, y, w, h })
    } else events.push(`${k}=${v}`)
    res.end('ok')
    return
  }
  events.push(`GET ${u.pathname}`)
  const body = u.pathname === '/form' ? FORM : u.pathname === '/next' ? NEXT : ''
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
  res.end(body || 'not found')
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const work = mkdtempSync(join(tmpdir(), 'bb-live-'))
const home = join(work, 'home')
const userData = join(work, 'userData')
const scratch = join(work, 'scratch-brain')
for (const d of [home, userData, scratch, join(home, '.grok')]) mkdirSync(d, { recursive: true })
writeFileSync(join(scratch, 'AGENTS.md'), '# Scratch brain for the live app check\n')
spawnSync('git', ['init', '-q'], { cwd: scratch })
copyFileSync(join(real, '.grok', 'auth.json'), join(home, '.grok', 'auth.json'))
writeFileSync(join(userData, 'account.json'), JSON.stringify({ email: 'live-check@plyntr.com', token: 'live-check', name: 'Live Check', role: 'owner', source: 'local', folder: scratch, brains: [] }))
writeFileSync(join(userData, 'brains.json'), JSON.stringify({ active: scratch, rows: [{ path: scratch, name: 'Scratch', slug: 'scratch', watching: false, syncMode: 'local' }] }))

const profile = join(work, 'deny.sb')
const deny = [joeBrain, joeUserData, abConfigDir, '/Applications/Brain.app', join(real, '.grok'), join(real, '.claude'), join(real, '.codex'), join(real, '.cursor')]
writeFileSync(profile, `(version 1)\n(allow default)\n${deny.map((d) => `(deny file-write* (subpath ${JSON.stringify(d)}))`).join('\n')}\n`)

let child: ReturnType<typeof spawn> | null = null
let joePid = ''
const before = mtimes()
try {
  check('the packed app exists', existsSync(exe), exe)
  const probe = join(joeBrain, '.bb-sandbox-probe')
  const touched = spawnSync('sandbox-exec', ['-f', profile, '/usr/bin/touch', probe])
  check('the sandbox profile refuses a write in Joe\'s brain', touched.status !== 0 && !existsSync(probe), String(touched.stderr).trim())
  check('the temp HOME has no Agency Brain config', !existsSync(join(home, 'Library', 'Application Support', 'Agency Brain', 'config.json')))
  const seeded = JSON.parse(readFileSync(join(userData, 'brains.json'), 'utf8')) as { rows: { path: string }[] }
  check('the seeded account and brains point only at the scratch folder', seeded.rows.every((r) => r.path === scratch) && JSON.parse(readFileSync(join(userData, 'account.json'), 'utf8')).folder === scratch)
  joePid = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).find((l) => l.endsWith(' /Applications/Brain.app/Contents/MacOS/Brain'))?.split(/\s+/)[0] || ''
  const joeLeader = join(real, '.grok', 'leader-brain-app.sock')
  const leaderBefore = existsSync(joeLeader)
  log(`Joe's Brain pid ${joePid || 'none'}, leader socket ${leaderBefore}`)

  const port = 9560 + Math.floor(Math.random() * 30)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    BRAIN_GROK_LEADER_SOCK: join(home, '.grok', 'leader-live.sock'),
    BRAIN_APP_NO_AUTO_UPDATE: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BRAIN_CHAT
  child = spawn('sandbox-exec', ['-f', profile, exe, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-sandbox'], { env, stdio: 'ignore' })
  // sandbox-exec applies the profile and then execs Brain, so the child's pid is Brain's main process.
  const brainPid = String(child.pid)
  const target = await until(async () => {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      return list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || null
    } catch {
      return null
    }
  }, 'the Brain window over CDP', 30_000)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const waiting = new Map<number, (v: any) => void>()
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data))
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)!(d.result ?? d)
      waiting.delete(d.id)
    }
  }
  const cdp = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((r) => {
      const i = ++id
      waiting.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const js = async <T>(expr: string): Promise<T> => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value as T
  const click = async (x: number, y: number, clickCount = 1) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
  }
  const key = async (k: string, code: string, modifiers = 0, text?: string) => {
    await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === 'Enter' ? 13 : k === 'Backspace' ? 8 : 0, ...(text ? { text } : {}) })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers })
  }

  await until(() => js<boolean>(`!!document.querySelector('.composer textarea')`), 'the chat opened (not setup)', 90_000)
  const ask = `Open ${base}/form with the browser tools and tell me the page's main heading.`
  const composer = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('.composer textarea').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
  await click(composer.x, composer.y)
  await cdp('Input.insertText', { text: ask })
  await key('Enter', 'Enter', 0, '\r')
  const answered = await until(() => js<string>(`(() => { const t = document.body.innerText; return t.includes('Purple Walrus 42') && t.lastIndexOf('Purple Walrus 42') > t.lastIndexOf(${JSON.stringify(ask.slice(0, 30))}) ? t : '' })()`), 'the answer with the heading', 300_000)
  check('a real Grok chat in the packed app answered with the heading', !!answered)
  const underMessage = await until(
    () => js<boolean>(`(() => { const t = document.querySelector('.page-turn'); if (!t || !t.querySelector('img')) return false; let n = t; for (let i = 0; i < 6 && n; i++, n = n.parentElement) { if ((n.textContent || '').includes(${JSON.stringify(ask.slice(0, 30))})) return true } return false })()`),
    'the picture under the message that asked',
    20_000
  )
  check('the thread picture sits under the message that asked', underMessage)

  const pic = () => js<{ x: number; y: number; w: number; h: number; nw: number; nh: number; src: string; wide: boolean }>(`(() => { const i = document.querySelector('.page-turn img'); const r = i.getBoundingClientRect(); return { x: r.left + 1, y: r.top + 1, w: i.clientWidth, h: i.clientHeight, nw: i.naturalWidth, nh: i.naturalHeight, src: i.src.slice(-80), wide: i.classList.contains('wide') } })()`)
  const small = await pic()
  await click(small.x + small.w / 2, small.y + small.h / 2)
  const wide = await until(async () => {
    const p = await pic()
    return p.wide ? p : null
  }, 'the picture going wide', 5000)
  check('the wide picture is not 1100x800 on screen', wide.w !== 1100 && wide.nw === 1100, `${wide.w}x${wide.h}`)
  /** Where a page pixel shows on Brain's screen right now, inside the wide picture (object-fit contain). The thread can scroll, so it is measured each time. */
  const onPicture = async (px: number, py: number) => {
    const now = await pic()
    const scale = Math.min(now.w / now.nw, now.h / now.nh)
    return { x: now.x + (now.w - now.nw * scale) / 2 + px * scale, y: now.y + (now.h - now.nh * scale) / 2 + py * scale }
  }
  const centre = (name: string) => {
    const r = rects.get(name)
    if (!r) throw new Fail(`the fixture never reported where ${name} is`)
    return onPicture(r.x + r.w / 2, r.y + r.h / 2)
  }

  const srcBefore = (await pic()).src
  const nextAt = await centre('next')
  const gets = events.filter((e) => e === 'GET /next').length
  await click(nextAt.x, nextAt.y)
  await until(() => events.filter((e) => e === 'GET /next').length > gets, 'GET /next after the picture click', 8000)
  check('a click on the wide picture at the link\'s mapped point opens /next', true)
  await until(async () => (await pic()).src !== srcBefore, 'a new frame in the wide picture within 2 s', 2000)
  check('the wide picture changed within 2 s of the navigation (live frames)', true)
  await until(() => rects.has('back'), 'the /next page reporting its link', 5000)
  await sleep(500)
  const backAt = await centre('back')
  const gotForm = events.filter((e) => e === 'GET /form').length
  await click(backAt.x, backAt.y)
  await until(() => events.filter((e) => e === 'GET /form').length > gotForm, 'back to /form through the picture', 8000)
  await sleep(800)

  const f1 = rects.get('f1')!
  const from = await onPicture(f1.x + 8, f1.y + f1.h / 2)
  const to = await onPicture(f1.x + f1.w - 8, f1.y + f1.h / 2)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 5; i++) {
    await sleep(45)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 5, y: from.y, button: 'left', buttons: 1 })
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  const sel = await until(() => [...events].reverse().find((e) => e.startsWith('sel=')) || null, 'the drag selection report', 5000)
  check('a real drag across the field selects text in the page', Number(sel.slice(4)) > 3, sel)
  const word = await onPicture(f1.x + 30, f1.y + f1.h / 2)
  await click(word.x, word.y, 1)
  await click(word.x, word.y, 2)
  const w = await until(() => [...events].reverse().find((e) => e.startsWith('word=')) || null, 'the double-click word report', 5000)
  check('a real double-click selects one word', w === 'word=hello', w)

  const clear = async () => {
    await key('a', 'KeyA', 4)
    await key('Backspace', 'Backspace')
    await until(() => events.includes('val='), 'the field emptied', 5000)
  }
  const composerValue = () => js<string>(`document.querySelector('.composer textarea').value`)
  await clear()
  const first = `cdp-${Math.random().toString(36).slice(2, 8)}`
  execFileSync('pbcopy', { input: first })
  await key('v', 'KeyV', 4)
  await until(() => events.includes(`val=${first}`), 'the CDP Cmd+V paste in the page', 5000)
  check('Cmd+V (CDP key) pastes the Mac clipboard into the page field, not the composer', (await composerValue()) === '', first)

  events.splice(0, events.length, ...events.filter((e) => !e.startsWith('val=')))
  await clear()
  const second = `mac-${Math.random().toString(36).slice(2, 8)}`
  execFileSync('pbcopy', { input: second })
  let front = ''
  for (let i = 0; i < 3 && front !== brainPid; i++) {
    spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${brainPid}) to true`])
    await sleep(600)
    front = execFileSync('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'], { encoding: 'utf8' }).trim()
  }
  check('the test Brain is frontmost before a real keystroke', front === brainPid, `front ${front}, test ${brainPid}`)
  spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'])
  await until(() => events.includes(`val=${second}`), 'the real macOS Cmd+V paste in the page', 5000)
  check('a real macOS Cmd+V (through the Edit menu path) pastes into the page field, not the composer', (await composerValue()) === '', second)

  const boxAt = await centre('box')
  await click(boxAt.x, boxAt.y)
  for (const ch of 'hi') await key(ch, `Key${ch.toUpperCase()}`, 0, ch)
  await key('Enter', 'Enter', 0, '\r')
  await until(() => events.includes('echo=hi'), 'the message box echo', 5000)
  check('typed keys and Enter reach the page\'s message box', true)

  const png = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, 'live-app.png'), Buffer.from(png.data, 'base64'))
  log('screenshot plans/20261009-inline-browser-shots/live-app.png')

  const shot = async (file: string) => {
    const p = await cdp('Page.captureScreenshot', { format: 'png' })
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), Buffer.from(p.data, 'base64'))
    log(`screenshot ${file}`)
  }
  const press = (label: string, scope: string) =>
    js<boolean>(`(() => { const s = ${scope}; const b = s && [...s.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  const say = async (text: string) => {
    const at = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('.composer textarea').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
    await click(at.x, at.y)
    await cdp('Input.insertText', { text })
    await key('Enter', 'Enter', 0, '\r')
  }
  const saidAfter = (marker: string, re: RegExp) => js<boolean>(`(() => { const t = document.body.innerText; const i = t.lastIndexOf(${JSON.stringify(marker)}); return i >= 0 && ${re.toString()}.test(t.slice(i + ${marker.length})) })()`)

  check('Large is a button under the picture', await press('Large', `document.querySelector('.page-turn')`))
  await until(() => js<boolean>(`!!document.querySelector('.chatpane.on > .page-dock img.large')`), 'the large dock', 5000)
  await sleep(600)
  const dock = await js<{ dock: number; pane: number; hit: boolean; imgs: number }>(
    `(() => { const p = document.querySelector('.chatpane.on'); const d = p.querySelector(':scope > .page-dock').getBoundingClientRect(); const t = p.querySelector('.composer textarea'); const r = t.getBoundingClientRect(); return { dock: d.height, pane: p.getBoundingClientRect().height, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === t, imgs: p.querySelectorAll('.desk-browser-shot img').length } })()`
  )
  check('Large docks one picture above the conversation and the message box stays usable', dock.dock / dock.pane > 0.5 && dock.hit && dock.imgs === 1, JSON.stringify(dock))
  await shot('plans/20261009-browser-sizes-shots/live-large.png')

  const waAsk = 'Open https://web.whatsapp.com with the browser tools, using the WhatsApp account named india. Then reply with the account line from the tool reply.'
  await say(waAsk)
  await until(() => saidAfter(waAsk, /account on screen: india|\bindia\b/i), 'the answer naming india', 300_000)
  check('a real chat opened WhatsApp account india through the packaged tools', existsSync(join(userData, 'Partitions', 'brain-wa-india')), String(existsSync(join(userData, 'Partitions'))))
  await sleep(4000)
  await shot('plans/20261009-whatsapp-accounts-shots/live-india.png')

  const sendAsk = 'Use whatsapp_send to send the text "hello from the check" to Raj Patel from the WhatsApp account india. Do nothing else.'
  await say(sendAsk)
  await until(() => js<boolean>(`!!document.querySelector('.wa-send-card')`), 'the Send card', 300_000)
  const card = await js<string>(`document.querySelector('.wa-send-card').innerText`)
  check('the packaged whatsapp_send puts a Send card in the thread and sends nothing', /WhatsApp \(india\) to Raj Patel/.test(card) && /hello from the check/.test(card) && /Don't send/.test(card), card)
  await shot('plans/20261009-whatsapp-send-shots/live-card.png')
  check("Don't send is a button on the card", await press("Don't send", `document.querySelector('.wa-send-card')`))
  await until(() => js<boolean>(`document.querySelector('.wa-send-card .wa-send-outcome')?.textContent === 'Not sent.'`), 'the card saying Not sent.', 10_000)
  check("Don't send leaves the card saying Not sent.", true)
  ws.close()

  process.kill(Number(brainPid), 'SIGTERM')
  await until(() => {
    try {
      execFileSync('kill', ['-0', brainPid])
      return false
    } catch {
      return true
    }
  }, 'the test Brain quit', 20_000)
  spawnSync('pkill', ['-f', join(home, '.grok', 'leader-live.sock')])
  const joeStill = joePid ? spawnSync('kill', ['-0', joePid]).status === 0 : true
  check('Joe\'s Brain is still running with the same pid, and its Grok leader socket is still there', joeStill && existsSync(joeLeader) === leaderBefore, `pid ${joePid}`)
  const after = mtimes()
  check('the five watched files are untouched', after.every((m, i) => m === before[i]), JSON.stringify(watched.filter((_, i) => after[i] !== before[i])))
  const cache = join(home, 'Library', 'Caches', 'brain-app-updater')
  check('the test launch downloaded no update', !existsSync(cache) || !spawnSync('find', [cache, '-name', '*.zip']).stdout.toString().trim(), cache)
  log('LIVE_APP_PASS')
} catch (e) {
  log(`LIVE_APP_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null) {
    try {
      execFileSync('pkill', ['-f', `user-data-dir=${userData}`])
    } catch {
      // already gone
    }
  }
  spawnSync('pkill', ['-f', join(home, '.grok', 'leader-live.sock')])
  server.close()
  rmSync(work, { recursive: true, force: true })
  check('the temp folders are removed', !existsSync(work))
}
