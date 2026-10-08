import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import type { DeskCli } from '../../shared/desk.ts'
import { argvFor } from './runner.ts'

const userData = mkdtempSync(join(tmpdir(), 'desk-shared-user-'))
const brains = [mkdtempSync(join(tmpdir(), 'desk-shared-a-')), mkdtempSync(join(tmpdir(), 'desk-shared-b-'))]
const jpeg = Uint8Array.from([9, 8, 7, 6])
const device = Uint8Array.from([2, 2, 0, 0])

type FakePage = {
  windowId: number
  viewport: { width: number; height: number; deviceScaleFactor: number } | null
  windowState: string
  _url: string
  _closed: boolean
  isClosed: () => boolean
  screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>
}
type Fake = {
  launches: Array<Record<string, unknown>>
  actions: string[]
  pages: FakePage[]
  url: string
  jpeg: Uint8Array
  device: Uint8Array
  shots: unknown[]
  shotIds: number[]
  entered: string[]
  holds: Array<{ url: string; release: () => void }>
  nextId: number
  holdGoto: boolean
  bounds: Array<{ windowId: number; bounds: { left?: number; windowState?: string } }>
  holdClick: boolean
  clickEntered: number
  clickWaiters: Array<() => void>
  holdPrepare: boolean
  prepareEntered: number
  prepareWaiters: Array<() => void>
  title: string
}
type WarmCall = Record<string, unknown>
type SendHandler = (e: unknown, ...args: any[]) => Promise<unknown>

const g = globalThis as typeof globalThis & {
  __deskUserData?: string
  __browserFake?: Fake
  __warmCalls?: WarmCall[]
  __ipcHandlers?: Map<string, SendHandler>
  __brainApi?: {
    browser: {
      clickAt: (owner: string, x: number, y: number) => Promise<void>
      typeText: (owner: string, text: string) => Promise<void>
      pressKey: (owner: string, key: string) => Promise<void>
      wheel: (owner: string, deltaY: number) => Promise<void>
      face: (owner: string) => Promise<{ src: string | null; signIn: boolean }>
      showWindow: () => Promise<void>
    }
  }
}
g.__deskUserData = userData
g.__browserFake = {
  launches: [],
  actions: [],
  pages: [],
  url: '',
  jpeg,
  device,
  shots: [],
  shotIds: [],
  entered: [],
  holds: [],
  nextId: 1,
  holdGoto: false,
  bounds: [],
  holdClick: false,
  clickEntered: 0,
  clickWaiters: [],
  holdPrepare: false,
  prepareEntered: 0,
  prepareWaiters: [],
  title: 'Example'
}
g.__warmCalls = []
g.__ipcHandlers = new Map()

const electronSource = `
export const app = {
  getVersion: () => '0.0.0',
  getName: () => 'Brain',
  getPath: () => globalThis.__deskUserData,
  getAppPath: () => globalThis.__deskUserData,
  isPackaged: false,
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  on() {},
  once() {},
  quit() {},
  exit() {},
  dock: { show() {}, hide() {} },
  commandLine: { appendSwitch() {} }
}
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
export const ipcMain = {
  handle(channel, fn) { globalThis.__ipcHandlers.set(channel, fn) },
  on() {}
}
export const ipcRenderer = {
  invoke(channel, ...args) {
    const fn = globalThis.__ipcHandlers.get(channel)
    return fn ? Promise.resolve(fn(null, ...args)) : Promise.resolve(undefined)
  },
  on() {},
  removeListener() {},
  send() {}
}
export const contextBridge = {
  exposeInMainWorld(_name, api) { globalThis.__brainApi = api }
}
export const webUtils = { getPathForFile() { return '' } }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = { openExternal() {}, openPath: async () => '' }
export const clipboard = { readText: () => '', writeText() {} }
export const nativeImage = { createEmpty: () => ({}) }
export const protocol = { handle() {}, registerFileProtocol() {} }
export const safeStorage = { isEncryptionAvailable: () => false }
const api = { app, BrowserWindow, ipcMain, ipcRenderer, contextBridge, webUtils, dialog, shell, clipboard, nativeImage, protocol, safeStorage }
export default api
`

const puppeteerSource = `
const fake = globalThis.__browserFake
const PAGE_VIEW = { width: 1100, height: 800, deviceScaleFactor: 1 }
function clipOk(options) {
  const clip = options && options.clip
  return options
    && options.type === 'jpeg'
    && options.quality === 40
    && options.fromSurface === false
    && options.captureBeyondViewport === false
    && clip && clip.x === 0 && clip.y === 0 && clip.width === 1100 && clip.height === 800 && clip.scale === 1
}
function viewOk(page) {
  const v = page.viewport
  return !!v && v.width === PAGE_VIEW.width && v.height === PAGE_VIEW.height && v.deviceScaleFactor === 1
}
function makePage() {
  const page = {
    windowId: fake.nextId++,
    viewport: null,
    windowState: 'normal',
    _url: 'about:blank',
    _closed: false,
    goto(url) {
      fake.entered.push(url)
      const finish = () => { page._url = url; fake.url = url }
      if (!fake.holdGoto) { finish(); return Promise.resolve() }
      return new Promise((resolve) => {
        fake.holds.push({ url, page, release() { finish(); resolve() } })
      })
    },
    url() { return page._url },
    click(sel) { fake.actions.push('click ' + sel); return Promise.resolve() },
    type() { return Promise.resolve() },
    bringToFront() { fake.actions.push('bringToFront'); return Promise.resolve() },
    close() { page._closed = true; return Promise.resolve() },
    screenshot(options) {
      fake.shots.push(options || null)
      fake.shotIds.push(page.windowId)
      const ok = clipOk(options) && viewOk(page) && page.windowState === 'minimized'
      return Promise.resolve(ok ? fake.jpeg : new Uint8Array())
    },
    isClosed() { return page._closed },
    target() { return { _targetId: page._targetId } },
    setViewport(v) {
      page.viewport = v
      if (!fake.holdPrepare) return Promise.resolve()
      fake.prepareEntered += 1
      return new Promise((resolve) => { fake.prepareWaiters.push(resolve) })
    },
    waitForNetworkIdle() { return Promise.resolve() },
    evaluate(fn) {
      if (fn && fn.name === 'pageSnapshot') {
        return Promise.resolve({ title: fake.title || 'Example', text: 'hello', controls: ['link Pricing'], hasPassword: false })
      }
      return Promise.resolve(null)
    },
    createCDPSession() {
      return Promise.resolve({
        send(method, params) {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: page.windowId })
          if (method === 'Browser.setWindowBounds' && params && params.bounds) {
            page.windowState = params.bounds.windowState
            fake.bounds.push({ windowId: params.windowId, bounds: params.bounds })
            return Promise.resolve({})
          }
          if (method === 'Target.createTarget') {
            // The new page shows up on a later turn. Two opens that both read pages() first
            // must still receive two windows, and each page keeps the id createTarget returned.
            const id = 't' + fake.nextId
            return Promise.resolve().then(() => {
              const created = makePage()
              created._targetId = id
              return { targetId: id }
            })
          }
          return Promise.resolve({})
        },
        detach() { return Promise.resolve() }
      })
    },
    mouse: {
      click(x, y) {
        fake.actions.push('mouse ' + x + ' ' + y + ' ' + page.windowId)
        if (!fake.holdClick) return Promise.resolve()
        fake.clickEntered += 1
        return new Promise((resolve) => { fake.clickWaiters.push(resolve) })
      },
      wheel(o) { fake.actions.push('wheel ' + (o && o.deltaY) + ' ' + page.windowId); return Promise.resolve() }
    },
    keyboard: {
      type(t) { fake.actions.push('type ' + t + ' ' + page.windowId); return Promise.resolve() },
      press(k) { fake.actions.push('press ' + k + ' ' + page.windowId); return Promise.resolve() }
    }
  }
  fake.pages.push(page)
  return page
}
const browser = {
  connected: true,
  pages() { return Promise.resolve(fake.pages.filter((p) => !p.isClosed())) },
  newPage() { return Promise.resolve(makePage()) }
}
function launch(options) {
  fake.launches.push(options)
  return Promise.resolve(browser)
}
export { launch }
export default { launch }
`

const warmSource = `
export async function promptWarm(opts) {
  globalThis.__warmCalls.push(opts)
  return 'ok'
}
export function cancelWarm() { return false }
export function closeWarm() {}
export async function forkSession() { return {} }
export async function planModeWarm() { return {} }
export async function resetWarm() { return {} }
export async function resumeSession() { return {} }
export async function warmSession() { return {} }
`

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'puppeteer-core') return { url: 'stub:puppeteer', shortCircuit: true }
    if (spec === 'electron-updater') return { url: 'stub:updater', shortCircuit: true }
    if (spec === './warm' || spec === './warm.ts') return { url: 'stub:warm', shortCircuit: true }
    if (spec === './line-rpc' || spec === '../line-rpc' || spec.endsWith('/line-rpc')) return { url: 'stub:line-rpc', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json|node)$/.test(spec)) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    const lineRpc = 'export function asRecord() { return {} }\nexport function asText() { return "" }\nexport function fileHits() { return [] }\nexport function spawnBin() { return null }\nexport class LineRpc { constructor() {} on() {} send() {} kill() {} }\n'
    const source =
      url === 'stub:electron' ? electronSource : url === 'stub:puppeteer' ? puppeteerSource : url === 'stub:warm' ? warmSource : url === 'stub:updater' ? 'export const autoUpdater = { on() {}, checkForUpdates: async () => null, quitAndInstall() {} }\nexport default { autoUpdater }\n' : url === 'stub:line-rpc' ? lineRpc : ''
    if (!source) return next(url, ctx)
    return { format: 'module', shortCircuit: true, source }
  }
})

const { registerStubIpc } = await import('../ipc-stubs.ts')
const { openDeskController } = await import('./ipc.ts')
const { sharedDeskBrowser } = await import('../shared-browser.ts')
const { createSenders } = await import('./senders.ts')
const { registerBrowserIpc } = await import('../browser-ipc.ts')
await import('../../preload/index.ts')

after(() => {
  rmSync(userData, { recursive: true, force: true })
  for (const brain of brains) rmSync(brain, { recursive: true, force: true })
})

/** The deny list as it ships. This test does not read GROK_DENY. */
const DENY = [
  'MCPTool(*)',
  'mcp__*',
  'Bash(sudo *)',
  'Bash(su *)',
  'Bash(rm -rf /*)',
  'Bash(rm -r /*)',
  'Bash(curl *|*bash*)',
  'Bash(curl *|*sh*)',
  'Bash(wget *|*bash*)',
  'Bash(wget *|*sh*)',
  'Bash(mkfs*)',
  'Bash(dd if=/dev/*)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(halt*)',
  'Bash(poweroff*)',
  'Write(~/.ssh/authorized_keys)',
  'Edit(~/.ssh/authorized_keys)',
  'Write(/etc/**)',
  'Edit(/etc/**)',
  'Write(/usr/**)',
  'Write(/boot/**)',
  'Edit(/usr/**)',
  'Edit(/boot/**)'
]

const NEVER = [
  '--always-approve',
  '--bare',
  '--dangerously-skip-permissions',
  '--fallback-model',
  '--tools',
  '--dangerously-bypass-approvals-and-sandbox',
  '--force',
  '--yolo',
  '--approve-mcps',
  '--mode=ask',
  'read-only',
  'danger-full-access'
]

function seat(cli: DeskCli) {
  return argvFor({ cli, model: 'default', effort: 'default' }, 'p', '/b')
}

test('chats and desk bots share one Chrome, and WhatsApp is the one shared window', { timeout: 120_000 }, async () => {
  registerStubIpc()
  registerBrowserIpc()
  const send = g.__ipcHandlers?.get('chat:send')
  const close = g.__ipcHandlers?.get('chat:close')
  assert.equal(typeof send, 'function')
  assert.equal(typeof close, 'function')
  const fake = g.__browserFake!
  const warm = g.__warmCalls!
  const browser = sharedDeskBrowser()
  const live = () => fake.pages.filter((p) => !p._closed)
  const urls = () => live().map((p) => p._url).sort()
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 2000
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  fake.holdGoto = true
  const opened = [
    browser.goTo!('https://a.example', 'chat:chat-a'),
    browser.goTo!('https://b.example', 'chat:chat-b'),
    browser.goTo!('https://w.example', 'desk:writer')
  ]
  await until(() => fake.entered.length === 3)
  assert.deepEqual(fake.entered, ['https://a.example', 'https://b.example', 'https://w.example'])
  assert.ok(live().every((p) => p._url === 'about:blank'))
  assert.equal(fake.launches.length, 1)
  const opts = fake.launches[0]
  assert.equal(opts.pipe, true)
  assert.equal(opts.headless, false)
  assert.equal('args' in opts, false)
  assert.deepEqual(Object.keys(opts).sort(), ['executablePath', 'headless', 'pipe', 'userDataDir'])
  assert.equal(opts.userDataDir, join(homedir(), '.brain-sessions', 'desk'))
  for (const hold of fake.holds) hold.release()
  fake.holds = []
  fake.holdGoto = false
  await Promise.all(opened)
  assert.equal(live().length, 3)
  assert.deepEqual(urls(), ['https://a.example', 'https://b.example', 'https://w.example'])
  assert.equal(fake.launches.length, 1)

  await browser.goTo!('https://web.whatsapp.com', 'chat:chat-a')
  assert.equal(live().length, 4)
  assert.ok(urls().includes('https://w.example'))
  assert.ok(urls().includes('https://a.example'))
  const wa = live().find((p) => p._url.includes('web.whatsapp.com'))
  assert.ok(wa)
  await browser.goTo!('https://web.whatsapp.com/', 'desk:writer')
  await browser.goTo!('https://web.whatsapp.com/send?phone=15551212', 'chat:chat-b')
  assert.equal(live().length, 4)
  assert.ok(urls().includes('https://w.example'))
  assert.equal(wa!._closed, false)
  const expected = Buffer.from(jpeg).toString('base64')
  const shotsBefore = fake.shotIds.length
  const cssShot = {
    type: 'jpeg',
    quality: 40,
    fromSurface: false,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1100, height: 800, scale: 1 }
  }
  const shotAt = fake.shots.length
  assert.equal(await browser.picture!('chat:chat-a'), expected)
  assert.equal(await browser.picture!('desk:writer'), expected)
  assert.deepEqual(fake.shotIds.slice(shotsBefore), [wa!.windowId, wa!.windowId])
  assert.deepEqual(fake.shots.slice(shotAt), [cssShot, cssShot])
  const wrong = Buffer.from(await wa!.screenshot({ type: 'jpeg', quality: 40 })).toString('base64')
  assert.equal(wrong, '')
  assert.notEqual(wrong, expected)

  await close!(null, 'chat-a')
  assert.equal(live().some((p) => p._url === 'https://a.example'), false)
  assert.equal(wa!._closed, false)
  assert.ok(live().some((p) => p._url === 'https://b.example'))
  assert.equal(fake.launches.length, 1)
  await browser.goTo!('https://web.whatsapp.com', 'chat:chat-a')
  assert.equal(wa!._closed, false)
  assert.equal(openDeskController(brains[0]).removeBot('writer'), null)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(live().some((p) => p._url === 'https://w.example'), false)
  assert.equal(wa!._closed, false)
  assert.ok(live().some((p) => p._url === 'https://b.example'))
  assert.equal(fake.launches.length, 1)

  await browser.goTo!('https://w.example', 'desk:writer')
  const writer = live().find((p) => p._url === 'https://w.example')
  assert.ok(writer)
  await browser.open!('b_hold', 'desk:writer')
  const raced = await Promise.race([
    browser.goTo!('https://c.example', 'chat:chat-c').then(() => 'ok'),
    new Promise((r) => setTimeout(() => r('stuck'), 800))
  ])
  assert.equal(raced, 'ok')
  assert.equal(writer!._url, 'https://w.example')
  assert.equal(writer!._closed, false)
  browser.release!('b_hold')

  const warmAt = warm.length
  await send!(null, { tabId: 'pad', kind: 'grok', cwd: brains[0], text: '  https://c.example  ' })
  const afterPad = urls()
  await send!(null, { tabId: 'pad', kind: 'grok', cwd: brains[0], text: 'hello' })
  await send!(null, { tabId: 'pad', kind: 'grok', cwd: brains[0], text: 'see https://example.com' })
  assert.deepEqual(urls(), afterPad)
  assert.deepEqual(
    warm.slice(warmAt).map((c) => c.text),
    ['https://c.example', 'hello', 'see https://example.com']
  )
  for (const call of warm) {
    assert.equal('tools' in call, false)
    assert.equal('browse' in call, false)
    assert.equal('jpeg' in call, false)
    assert.equal(/jpeg|data:image|browse/i.test(JSON.stringify(call)), false)
  }
  assert.equal(fake.launches.length, 1)

  const api = g.__brainApi
  assert.ok(api)
  await browser.goTo!('https://a.example', 'chat:chat-a')
  const again = live().find((p) => p._url === 'https://a.example')
  assert.ok(again)
  fake.actions = []
  await api!.browser.clickAt('chat:chat-a', 300, 100)
  await api!.browser.typeText('chat:chat-a', 'hi')
  await api!.browser.pressKey('chat:chat-a', 'Enter')
  await api!.browser.wheel('chat:chat-a', 40)
  assert.deepEqual(fake.actions, [
    `mouse 300 100 ${again!.windowId}`,
    `type hi ${again!.windowId}`,
    `press Enter ${again!.windowId}`,
    `wheel 40 ${again!.windowId}`
  ])

  // A click queued on this chat's window stays there when WhatsApp opens on the other lane.
  fake.holdClick = true
  fake.clickEntered = 0
  fake.clickWaiters = []
  const aWindow = again!.windowId
  const heldClick = api!.browser.clickAt('chat:chat-a', 7, 7)
  await until(() => fake.clickEntered === 1)
  const queuedClick = api!.browser.clickAt('chat:chat-a', 9, 8)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.clickEntered, 1)
  await browser.goTo!('https://web.whatsapp.com', 'chat:chat-a')
  const waForClick = live().find((p) => p._url.includes('web.whatsapp.com'))
  assert.ok(waForClick)
  assert.notEqual(waForClick!.windowId, aWindow)
  fake.clickWaiters.shift()?.()
  await until(() => fake.clickEntered === 2)
  fake.clickWaiters.shift()?.()
  fake.holdClick = false
  await Promise.all([heldClick, queuedClick])
  assert.equal(fake.actions.includes(`mouse 9 8 ${aWindow}`), true)
  assert.equal(fake.actions.includes(`mouse 9 8 ${waForClick!.windowId}`), false)

  await browser.goTo!('https://web.whatsapp.com', 'chat:chat-a')
  await browser.goTo!('https://web.whatsapp.com', 'desk:writer')
  fake.holdClick = true
  fake.clickEntered = 0
  fake.clickWaiters = []
  const first = api!.browser.clickAt('chat:chat-a', 1, 2)
  const second = api!.browser.clickAt('desk:writer', 3, 4)
  await until(() => fake.clickEntered === 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fake.clickEntered, 1)
  fake.clickWaiters.shift()?.()
  await until(() => fake.clickEntered === 2)
  fake.clickWaiters.shift()?.()
  fake.holdClick = false
  await Promise.all([first, second])
  assert.equal(fake.actions.filter((row) => row.startsWith('mouse 1 2')).length, 1)
  assert.equal(fake.actions.filter((row) => row.startsWith('mouse 3 4')).length, 1)
  assert.equal(fake.actions.includes('bringToFront'), false)
  assert.equal(fake.launches.length, 1)

  // Closing a chat while its window is still opening drops that window. It does not navigate.
  fake.holdPrepare = true
  fake.prepareEntered = 0
  fake.prepareWaiters = []
  const enteredBeforeClose = fake.entered.length
  const idsBeforeClose = new Set(fake.pages.map((p) => p.windowId))
  const openingChat = browser.goTo!('https://z.example', 'chat:chat-z')
  await until(() => fake.prepareEntered === 1)
  const zPage = fake.pages.find((p) => !idsBeforeClose.has(p.windowId))
  assert.ok(zPage)
  assert.equal(zPage!._url, 'about:blank')
  await close!(null, 'chat-z')
  fake.prepareWaiters.shift()?.()
  fake.holdPrepare = false
  await openingChat
  assert.equal(fake.entered.length, enteredBeforeClose)
  assert.equal(zPage!._closed, true)
  assert.equal(await browser.picture!('chat:chat-z'), null)
  assert.equal(live().some((p) => p._url === 'https://a.example'), true)
  assert.equal(fake.launches.length, 1)

  fake.holdPrepare = true
  fake.prepareEntered = 0
  fake.prepareWaiters = []
  const enteredBeforeBot = fake.entered.length
  const idsBeforeBot = new Set(fake.pages.map((p) => p.windowId))
  const openingBot = browser.goTo!('https://d.example', 'desk:late')
  await until(() => fake.prepareEntered === 1)
  const dPage = fake.pages.find((p) => !idsBeforeBot.has(p.windowId))
  assert.ok(dPage)
  await browser.closeOwner!('desk:late')
  fake.prepareWaiters.shift()?.()
  fake.holdPrepare = false
  await openingBot
  assert.equal(fake.entered.length, enteredBeforeBot)
  assert.equal(dPage!._closed, true)
  assert.equal(await browser.picture!('desk:late'), null)
  assert.equal(fake.launches.length, 1)
  for (const row of fake.bounds) {
    assert.ok((row.bounds.left ?? 1) <= 0, JSON.stringify(row.bounds))
    assert.ok(row.bounds.windowState === 'normal' || row.bounds.windowState === 'minimized')
  }

  assert.equal(createSenders().sendWhatsApp().sendable, false)
  const grok = [
    '-p',
    'p',
    '--cwd',
    '/b',
    '--permission-mode',
    'bypassPermissions',
    '--no-subagents',
    '--disable-web-search',
    '--output-format',
    'plain',
    ...DENY.flatMap((rule) => ['--deny', rule])
  ]
  const claude = ['-p', 'p', '--permission-mode', 'bypassPermissions', '--permission-prompts', 'none', '--strict-mcp-config', '--output-format', 'text']
  const gpt = ['exec', '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-C', '/b', 'p']
  const cursor = ['-p', '--sandbox', 'enabled', '--trust', '--workspace', '/b', '--output-format', 'text', 'p']
  assert.deepEqual(seat('grok'), grok)
  assert.deepEqual(seat('claude'), claude)
  assert.deepEqual(seat('gpt'), gpt)
  assert.deepEqual(seat('cursor'), cursor)
  for (const argv of [grok, claude, gpt, cursor]) {
    assert.equal(argv.includes('--model'), false)
    for (const flag of NEVER) assert.equal(argv.includes(flag), false, flag)
  }
})
