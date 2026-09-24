'use strict'

const { app, BrowserWindow, shell } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}
function fail(message) {
  process.stderr.write(message + '\n')
  app.exit(1)
  throw new Error(message)
}

const opens = []
var guestSrc = ''
shell.openExternal = (url) => {
  opens.push(String(url))
  return Promise.resolve()
}
function count(url) {
  const want = String(url || '').replace(/\/$/, '')
  return opens.filter((item) => String(item).replace(/\/$/, '') === want).length
}

function page(body) {
  return `<!doctype html><html><body>${body}</body></html>`
}
function link(id, href, blank) {
  const target = blank ? ' target="_blank"' : ''
  return `<a id="${id}" href="${href}"${target}>${id}</a>`
}

function startServer(portWant) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const port = server.address().port
    const other = port + 1
    const hops = {
      '/go': 'https://example.com/hop',
      '/go-local-port': `http://localhost:${port}9/`,
      '/go-port': `http://127.0.0.1:${port}9/x`,
      '/go-user': `http://localhost:${port}@example.com`,
      '/go-ten': `http://127.0.0.10:${port}/`,
      '/go-other': `http://localhost:${other}/`,
      '/go-loop-other': `http://127.0.0.1:${other}/`,
      '/go-https': `https://localhost:${port}/stolen`
    }
    if (url.pathname === '/hop-local') {
      res.writeHead(302, { Location: '/next' })
      res.end()
      return
    }
    if (Object.prototype.hasOwnProperty.call(hops, url.pathname)) {
      res.writeHead(302, { Location: hops[url.pathname] })
      res.end()
      return
    }
    const guest = String(guestSrc || '')
    const body = page(
      [
        link('https', 'https://example.com/from-brain'),
        link('http', 'http://example.com/plain'),
        link('mail', 'mailto:ada@example.com'),
        link('js', 'javascript:void(0)'),
        link('data', 'data:text/html,hi'),
        link('file', 'file:///Users/joewine/brain-outside-preview.html'),
        link('bad-host', 'file://remotehost/tmp/x.html'),
        link('bad-slash', 'file:///tmp/a%2fb.html'),
        link('blank', 'https://example.com/blank', true),
        link('slash', 'https://example.com/slash', true),
        link('slash-b', 'https://example.com/slash/', true),
        link('blank-mail', 'mailto:ada@example.com', true),
        link('blank-port', `http://localhost:${port}9/`, true),
        link('blank-js', 'javascript:void(0)', true),
        link('blank-data', 'data:text/html,hi', true),
        link('blank-file', 'file:///tmp/brain-outside-file.html', true),
        link('blank-next', `http://localhost:${port}/next`, true),
        link('blank-loop-next', `http://127.0.0.1:${port}/next`, true),
        link('next', '/next'),
        link('local-port', `http://localhost:${port}9/`),
        link('port9', `http://127.0.0.1:${port}9/`),
        link('ten', `http://127.0.0.10:${port}/`),
        link('other', `http://localhost:${other}/`),
        link('loop-other', `http://127.0.0.1:${other}/`),
        link('https-dev', `https://localhost:${port}/`),
        link('userinfo', `http://localhost:${port}@example.com`),
        link('go', '/go'),
        link('go-local-port', '/go-local-port'),
        link('go-port', '/go-port'),
        link('go-user', '/go-user'),
        link('go-ten', '/go-ten'),
        link('go-other', '/go-other'),
        link('go-loop-other', '/go-loop-other'),
        link('go-https', '/go-https'),
        link('hop', '/hop-local'),
        `<span id="guest-marker">${guest ? 'yes' : 'no'}</span>`,
        guest ? `<webview id="guest" src="${guest}" allowpopups="true" style="width:10px;height:10px"></webview>` : ''
      ].join('')
    )
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  return new Promise((resolve) => {
    server.listen(portWant || 0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, port })
    })
  })
}

function waitQuiet(wc) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      wc.removeListener('did-navigate', finish)
      wc.removeListener('did-fail-load', finish)
      wc.removeListener('did-redirect-navigation', finish)
      setTimeout(resolve, 80)
    }
    wc.on('did-navigate', finish)
    wc.on('did-fail-load', finish)
    wc.on('did-redirect-navigation', finish)
    setTimeout(finish, 350)
  })
}

async function click(wc, id) {
  await wc.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`).catch(() => {})
  await waitQuiet(wc)
}
async function assign(wc, url) {
  await wc.executeJavaScript(`location.assign(${JSON.stringify(url)})`).catch(() => {})
  await waitQuiet(wc)
}

function wireCall(source, name) {
  const at = source.indexOf(`function createWindow`)
  const bodyStart = source.indexOf('{', at)
  let depth = 0
  let end = bodyStart
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(bodyStart, end + 1)
  const callAt = body.indexOf(name + '(')
  if (callAt < 0) return ''
  let i = callAt + name.length
  let parens = 0
  let arg = ''
  for (; i < body.length; i += 1) {
    arg += body[i]
    if (body[i] === '(') parens += 1
    else if (body[i] === ')') {
      parens -= 1
      if (parens === 0) break
    }
  }
  return arg
}

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const mainArgs = wireCall(source, 'attachMainLinks')
  const guestArgs = wireCall(source, 'installGuestLinkPolicy')
  const allowAt = mainArgs.indexOf('appAllowList(')
  const allowArgs = allowAt < 0 ? '' : mainArgs.slice(allowAt)
  if (
    !mainArgs.includes('shell.openExternal') ||
    allowAt < 0 ||
    !allowArgs.includes('ELECTRON_RENDERER_URL') ||
    !allowArgs.includes('renderer/index.html') ||
    source.slice(source.indexOf('function createWindow'), source.indexOf('function pushHealth')).split('setWindowOpenHandler').length > 2
  ) {
    fail('main window is not wired to attachMainLinks')
  }
  say('main-wired')
  if (!guestArgs.includes('win.webContents') || !guestArgs.includes('shell.openExternal')) {
    fail('guest policy is not wired to the host webContents')
  }
  say('guest-wired')

  const { port } = await startServer(4317)
  const other = port + 1
  const origin = `http://localhost:${port}`
  const loop = `http://127.0.0.1:${port}`
  process.env.ELECTRON_RENDERER_URL = origin + '/'
  process.env.BRAIN_CHECK_WINDOW = '1'
  const guestFile = path.join('/tmp', 'brain-stay-guest.html')
  fs.writeFileSync(
    guestFile,
    page(
      [
        link('https', 'https://example.com/from-brain'),
        link('http', 'http://example.com/plain'),
        link('mail', 'mailto:ada@example.com'),
        link('js', 'javascript:void(0)'),
        link('data', 'data:text/html,hi'),
        link('file', 'file:///Users/joewine/brain-outside-preview.html'),
        link('blank', 'https://example.com/blank', true),
        link('blank-mail', 'mailto:ada@example.com', true),
        link('blank-port', `http://localhost:${port}9/`, true),
        link('blank-js', 'javascript:void(0)', true),
        link('blank-data', 'data:text/html,hi', true),
        link('blank-file', 'file:///Users/joewine/brain-outside-preview.html', true),
        link('blank-next', `${origin}/next`, true),
        link('blank-loop-next', `${loop}/next`, true),
        link('next', `${origin}/next`),
        link('loop-next', `${loop}/next`)
      ].join('')
    )
  )
  guestSrc = pathToFileURL(guestFile)

  const outDir = path.join('/tmp', 'brain-stay-check')
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, 'main'), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(outDir, 'main/index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-native',
        setup(build) {
          build.onResolve({ filter: /^(node-pty|@vscode\/sudo-prompt)$/ }, (args) => ({
            path: args.path,
            namespace: 'stub-native'
          }))
          build.onLoad({ filter: /.*/, namespace: 'stub-native' }, () => ({
            contents: 'module.exports = { spawn() { throw new Error("stub") } }',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const bundled = require(path.join(outDir, 'main/index.js'))
  const win = bundled.createWindow()
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))

  const beforeBlank = BrowserWindow.getAllWindows().length
  const webBefore = require('electron').webContents.getAllWebContents().length
  await onceOpen(win, 'https://example.com/from-brain', () => click(win.webContents, 'https'))
  await onceOpen(win, 'https://example.com/from-brain', () => assign(win.webContents, 'https://example.com/from-brain'))
  say('host-stayed fixture')
  const slashBefore = count('https://example.com/slash')
  const slashWins = BrowserWindow.getAllWindows().length
  await win.webContents.executeJavaScript(`document.getElementById('slash').click(); document.getElementById('slash-b').click()`)
  await waitQuiet(win.webContents)
  if (count('https://example.com/slash') - slashBefore !== 1) {
    fail('slash variants opened ' + (count('https://example.com/slash') - slashBefore))
  }
  if (BrowserWindow.getAllWindows().length !== slashWins) fail('slash variants left a window')
  say('slash-once')
  await onceOpen(win, 'https://example.com/blank', () => click(win.webContents, 'blank'))
  if (BrowserWindow.getAllWindows().length !== beforeBlank) fail('blank click left a window')
  await onceOpen(win, 'mailto:ada@example.com', () => click(win.webContents, 'blank-mail'))
  if (BrowserWindow.getAllWindows().length !== beforeBlank) fail('blank mail left a window')
  await onceOpen(win, `http://localhost:${port}9/`, () => click(win.webContents, 'blank-port'))
  if (BrowserWindow.getAllWindows().length !== beforeBlank) fail('blank port left a window')
  await dropped(win, 'javascript:void(0)', () => click(win.webContents, 'blank-js'), 'blank-javascript dropped')
  await dropped(win, 'data:text/html,hi', () => click(win.webContents, 'blank-data'), 'blank-data dropped')
  await dropped(win, 'file:///tmp/brain-outside-file.html', () => click(win.webContents, 'blank-file'), 'blank-file dropped')
  const blankHere = win.webContents.getURL()
  const blankOpens = opens.length
  await click(win.webContents, 'blank-next')
  await click(win.webContents, 'blank-loop-next')
  if (win.webContents.getURL() !== blankHere) fail('blank dev link navigated to ' + win.webContents.getURL())
  if (opens.length !== blankOpens) fail('blank dev link opened')
  if (BrowserWindow.getAllWindows().length !== beforeBlank) fail('blank dev link left a window')
  say('blank-dev-stayed')
  await onceOpen(win, 'http://example.com/plain', () => click(win.webContents, 'http'))
  await onceOpen(win, 'http://example.com/plain', () => assign(win.webContents, 'http://example.com/plain'))
  await onceOpen(win, 'mailto:ada@example.com', () => click(win.webContents, 'mail'))
  await onceOpen(win, 'mailto:ada@example.com', () => assign(win.webContents, 'mailto:ada@example.com'))
  await dropped(win, 'javascript:void(0)', () => click(win.webContents, 'js'), 'javascript dropped')
  await dropped(win, 'javascript:void(0)', () => assign(win.webContents, 'javascript:void(0)'), 'javascript dropped')
  await dropped(win, 'data:text/html,hi', () => click(win.webContents, 'data'), 'data dropped')
  await dropped(win, 'data:text/html,hi', () => assign(win.webContents, 'data:text/html,hi'), 'data dropped')
  await dropped(win, 'file:///Users/joewine/brain-outside-preview.html', () => click(win.webContents, 'file'), 'outside-file dropped')
  await dropped(win, 'file:///Users/joewine/brain-outside-preview.html', () => assign(win.webContents, 'file:///Users/joewine/brain-outside-preview.html'), 'outside-file dropped')
  await dropped(win, 'file://remotehost/tmp/x.html', () => click(win.webContents, 'bad-host'), 'bad-file-host dropped')
  await dropped(win, 'file://remotehost/tmp/x.html', () => assign(win.webContents, 'file://remotehost/tmp/x.html'), 'bad-file-host dropped')
  await dropped(win, 'file:///tmp/a%2fb.html', () => click(win.webContents, 'bad-slash'), 'bad-file-slash dropped')
  await dropped(win, 'file:///tmp/a%2fb.html', () => assign(win.webContents, 'file:///tmp/a%2fb.html'), 'bad-file-slash dropped')

  await stayed(win, origin + '/next', () => click(win.webContents, 'next'), '/next')
  await stayed(win, origin + '/next', () => assign(win.webContents, origin + '/next'), '/next')
  say('localhost-stayed')
  const reloadOpens = opens.length
  await win.webContents.executeJavaScript('location.reload()')
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  if (!win.webContents.getURL().startsWith(origin)) fail('localhost reload left the origin')
  if (opens.length !== reloadOpens) fail('localhost reload opened a URL')
  say('localhost-reload stayed')

  await stayed(win, loop + '/next', () => assign(win.webContents, loop + '/next'), '/next')
  say('loopback-stayed')
  const loopReload = opens.length
  await win.webContents.executeJavaScript('location.reload()')
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  if (!win.webContents.getURL().includes('127.0.0.1')) fail('loopback reload left')
  if (opens.length !== loopReload) fail('loopback reload opened a URL')
  say('loopback-reload stayed')

  await openedStay(win, `http://localhost:${port}9/`, 'localhost-port-prefix opened')
  await openedStay(win, `http://127.0.0.1:${port}9/`, 'port-prefix opened')
  await openedStay(win, `http://127.0.0.10:${port}/`, 'loopback-prefix opened')
  await openedStay(win, `http://localhost:${other}/`, 'other-port opened')
  await openedStay(win, `http://127.0.0.1:${other}/`, 'loopback-other-port opened')
  await openedStay(win, `https://localhost:${port}/`, 'https-dev opened')
  await openedStay(win, `http://localhost:${port}@example.com`, 'userinfo opened', 'userinfo')

  await redirect(win, origin + '/go', 'https://example.com/hop')
  await redirect(win, origin + '/go-local-port', `http://localhost:${port}9/`)
  await redirect(win, origin + '/go-port', `http://127.0.0.1:${port}9/x`)
  await redirect(win, origin + '/go-user', `http://localhost:${port}@example.com`)
  await redirect(win, origin + '/go-ten', `http://127.0.0.10:${port}/`)
  await redirect(win, origin + '/go-other', `http://localhost:${other}/`)
  await redirect(win, origin + '/go-loop-other', `http://127.0.0.1:${other}/`)
  await redirect(win, origin + '/go-https', `https://localhost:${port}/stolen`)
  await assign(win.webContents, origin + '/stay')
  const hopBefore = opens.length
  await click(win.webContents, 'hop')
  await assign(win.webContents, origin + '/hop-local')
  if (!win.webContents.getURL().endsWith('/next')) fail('same-origin redirect did not land on /next: ' + win.webContents.getURL())
  if (opens.length !== hopBefore) fail('same-origin redirect opened a URL')
  say('same-origin-redirect stayed')

  const { webContents } = require('electron')
  let guest = null
  for (let i = 0; i < 40 && !guest; i += 1) {
    guest = webContents.getAllWebContents().find((item) => String(item.getURL()).startsWith('file:')) || null
    if (!guest) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!guest) {
    const urls = webContents.getAllWebContents().map((item) => item.getURL()).join(' | ')
    const info = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('webview')
      const mark = document.getElementById('guest-marker')
      return JSON.stringify({ has: !!el, src: el && el.getAttribute('src'), mark: mark && mark.textContent })
    })()`)
    fail('guest preview did not load. contents=' + urls + ' info=' + info)
  }
  const guestHome = guest.getURL()
  async function guestOpen(url, id) {
    const before = count(url)
    await guest.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`).catch(() => {})
    await waitQuiet(guest)
    if (guest.getURL() !== guestHome) fail('guest left ' + guest.getURL())
    if (count(url) - before !== 1) fail('guest open count for ' + url)
  }
  async function guestDrop(id, label) {
    const before = opens.length
    await guest.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`).catch(() => {})
    await guest.executeJavaScript(`location.assign(document.getElementById(${JSON.stringify(id)}).href)`).catch(() => {})
    await waitQuiet(guest)
    if (guest.getURL() !== guestHome) fail(label + ' navigated guest to ' + guest.getURL())
    if (opens.length !== before) fail(label + ' opened')
    say(label)
  }
  await guestOpen('https://example.com/from-brain', 'https')
  await guestOpen('http://example.com/plain', 'http')
  await guestOpen('mailto:ada@example.com', 'mail')
  await guestDrop('js', 'guest-javascript dropped')
  await guestDrop('data', 'guest-data dropped')
  await guestDrop('file', 'guest-file dropped')
  const guestBlankBefore = count('https://example.com/blank')
  const contentsBefore = webContents.getAllWebContents().length
  await guest.executeJavaScript(`document.getElementById('blank').click()`).catch(() => {})
  await waitQuiet(guest)
  if (count('https://example.com/blank') - guestBlankBefore !== 1) {
    fail('guest blank delta ' + (count('https://example.com/blank') - guestBlankBefore) + ' recent ' + opens.slice(-6).join(' | '))
  }
  if (webContents.getAllWebContents().length !== contentsBefore) fail('guest blank leaked a webContents')
  if (guest.getURL() !== guestHome) fail('guest blank left the file')
  say('guest-blank-opened-once')
  await guestOpen('mailto:ada@example.com', 'blank-mail')
  await guestOpen(`http://localhost:${port}9/`, 'blank-port')
  await guestDrop('blank-js', 'guest-blank-javascript dropped')
  await guestDrop('blank-data', 'guest-blank-data dropped')
  await guestDrop('blank-file', 'guest-blank-file dropped')
  await guestOpen(`http://localhost:${port}/next`, 'blank-next')
  await guestOpen(`http://127.0.0.1:${port}/next`, 'blank-loop-next')
  await guestOpen(`http://localhost:${port}/next`, 'next')
  await guestOpen(`http://127.0.0.1:${port}/next`, 'loop-next')
  say('guest-stayed')

  say('dev-window-done')
  win.destroy()

  delete process.env.ELECTRON_RENDERER_URL
  const fileRoot = path.join(outDir, 'renderer')
  fs.mkdirSync(path.join(fileRoot, 'nested'), { recursive: true })
  fs.mkdirSync(path.join(outDir, 'renderer-extra'), { recursive: true })
  fs.writeFileSync(
    path.join(fileRoot, 'index.html'),
    page([link('nested', 'nested/page.html'), link('blank-nested', 'nested/page.html', true), link('secret', '../secret.html'), link('extra', '../renderer-extra/index.html')].join(''))
  )
  fs.writeFileSync(
    path.join(fileRoot, 'nested/page.html'),
    page([link('secret', '../secret.html'), link('extra', '../renderer-extra/index.html'), 'nested'].join(''))
  )
  fs.writeFileSync(path.join(outDir, 'secret.html'), page('secret'))
  fs.writeFileSync(path.join(outDir, 'renderer-extra/index.html'), page('extra'))
  const fileWin = bundled.createWindow()
  await new Promise((resolve) => fileWin.webContents.once('did-finish-load', resolve))
  const fileHere = fileWin.webContents.getURL()
  const fileOpens = opens.length
  await click(fileWin.webContents, 'secret')
  await assign(fileWin.webContents, pathToFileURL(path.join(outDir, 'secret.html')))
  if (fileWin.webContents.getURL() !== fileHere) fail('secret file navigated to ' + fileWin.webContents.getURL())
  if (opens.length !== fileOpens) fail('secret file was opened')
  say('parent-file dropped')
  await click(fileWin.webContents, 'extra')
  await assign(fileWin.webContents, pathToFileURL(path.join(outDir, 'renderer-extra/index.html')))
  if (fileWin.webContents.getURL() !== fileHere) fail('prefix file navigated to ' + fileWin.webContents.getURL())
  if (opens.length !== fileOpens) fail('prefix file was opened')
  say('prefix-file dropped')
  const nestedWins = BrowserWindow.getAllWindows().length
  await click(fileWin.webContents, 'blank-nested')
  if (fileWin.webContents.getURL() !== fileHere) fail('blank nested navigated to ' + fileWin.webContents.getURL())
  if (opens.length !== fileOpens) fail('blank nested opened outside')
  if (BrowserWindow.getAllWindows().length !== nestedWins) fail('blank nested left a window')
  say('blank-nested stayed')
  await click(fileWin.webContents, 'nested')
  if (!fileWin.webContents.getURL().includes('/nested/page.html')) fail('nested file did not stay: ' + fileWin.webContents.getURL())
  if (opens.length !== fileOpens) fail('nested file opened outside')
  say('nested-file stayed')
  const reloadAt = opens.length
  await fileWin.webContents.executeJavaScript('location.reload()').catch(() => {})
  await new Promise((resolve) => fileWin.webContents.once('did-finish-load', resolve))
  if (opens.length !== reloadAt) fail('file reload opened a URL')
  say('file-reload stayed')
  fileWin.destroy()

  await runSettings()
  app.exit(0)
}

function pathToFileURL(file) {
  return require('node:url').pathToFileURL(file).href
}

async function runSettings() {
  const outFile = path.join('/tmp', 'brain-stay-check', 'panel.js')
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/src/settings-check-entry.tsx')],
    outfile: outFile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    alias: { '@shared': path.join(root, 'src/shared') }
  })
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: false, sandbox: false }
  })
  const html = `<!doctype html><html><body><div id="root"></div><script>${fs.readFileSync(outFile, 'utf8')}<\/script></body></html>`
  const file = path.join('/tmp', 'brain-stay-check', 'settings.html')
  fs.writeFileSync(file, html)
  await win.loadFile(file)
  const result = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const timer = setInterval(() => {
      if (window.__settingsResult) { clearInterval(timer); resolve(window.__settingsResult) }
    }, 30)
  })`)
  if (!result || !result.ok) fail('settings paint failed: ' + JSON.stringify(result))
  for (const line of result.lines) say(line)
  win.destroy()
}

async function onceOpen(win, url, run) {
  const before = count(url)
  const here = win.webContents.getURL()
  await run()
  const delta = count(url) - before
  if (delta !== 1) fail(url + ' opened ' + delta + ' times')
  if (url.startsWith('http') && win.webContents.getURL() !== here && !win.webContents.getURL().startsWith('http://localhost') && !win.webContents.getURL().startsWith('http://127.0.0.1')) {
    fail('left the chat for ' + url + ' at ' + win.webContents.getURL())
  }
}
async function dropped(win, url, run, label) {
  const before = opens.length
  const here = win.webContents.getURL()
  await run()
  if (opens.length !== before) fail(label + ' was opened')
  if (win.webContents.getURL() !== here) fail(label + ' navigated to ' + win.webContents.getURL())
  say(label)
}
async function stayed(win, url, run, suffix) {
  const before = opens.length
  await run()
  if (!win.webContents.getURL().endsWith(suffix) && win.webContents.getURL() !== url) {
    fail('did not stay on ' + url + ' got ' + win.webContents.getURL())
  }
  if (opens.length !== before) fail('opened while staying on ' + url)
}
async function openedStay(win, url, label, id) {
  const here = win.webContents.getURL()
  const run = id ? () => click(win.webContents, id) : () => assign(win.webContents, url)
  await onceOpen(win, url, run)
  if (win.webContents.isDestroyed()) fail(label + ' destroyed the page')
  if (win.webContents.getURL() !== here) fail(label + ' left ' + win.webContents.getURL())
  say(label)
}
async function redirect(win, via, hop) {
  await assign(win.webContents, new URL('/stay', via).href)
  const here = win.webContents.getURL()
  const beforeLen = opens.length
  const before = count(hop)
  await assign(win.webContents, via)
  const hopKey = String(hop).replace(/\/$/, '')
  const added = opens.slice(beforeLen).map((item) => String(item).replace(/\/$/, ''))
  if (!win.webContents.getURL().endsWith('/stay') && win.webContents.getURL() !== here) {
    fail('redirect left /stay for ' + hop + ' at ' + win.webContents.getURL())
  }
  if (added.length !== 1 || added[0] !== hopKey) fail('redirect opened ' + added.join(' | ') + ' for ' + hop)
  if (count(hop) - before !== 1) fail('redirect did not open once ' + hop)
  say('redirect-opened-once ' + hop)
}

app.whenReady().then(() => main()).catch((err) => {
  process.stderr.write(String(err && err.stack || err) + '\n')
  process.exit(1)
})
