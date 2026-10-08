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

type Fake = {
  launches: Array<Record<string, unknown>>
  actions: string[]
  pages: Array<{ screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array> }>
  url: string
  jpeg: Uint8Array
  device: Uint8Array
  shots: unknown[]
}
type WarmCall = Record<string, unknown>
type SendHandler = (e: unknown, payload: { text?: string; tabId?: string; kind?: string; cwd?: string }) => Promise<unknown>

const g = globalThis as typeof globalThis & {
  __deskUserData?: string
  __browserFake?: Fake
  __warmCalls?: WarmCall[]
  __ipcHandlers?: Map<string, SendHandler>
}
g.__deskUserData = userData
g.__browserFake = { launches: [], actions: [], pages: [], url: '', jpeg, device, shots: [] }
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
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = { openExternal() {}, openPath: async () => '' }
export const clipboard = { readText: () => '', writeText() {} }
export const nativeImage = { createEmpty: () => ({}) }
export const protocol = { handle() {}, registerFileProtocol() {} }
export const safeStorage = { isEncryptionAvailable: () => false }
const api = { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, protocol, safeStorage }
export default api
`

const puppeteerSource = `
const fake = globalThis.__browserFake
function makePage() {
  const page = {
    _url: 'about:blank',
    goto(url) { fake.actions.push('goto ' + url); page._url = url; fake.url = url; return Promise.resolve() },
    url() { return page._url },
    click(sel) { fake.actions.push('click ' + sel); return Promise.resolve() },
    type() { return Promise.resolve() },
    bringToFront() { return Promise.resolve() },
    screenshot(options) {
      fake.shots.push(options || null)
      const clip = options && options.clip
      const css = options
        && options.type === 'jpeg'
        && options.quality === 40
        && options.fromSurface === false
        && options.captureBeyondViewport === false
        && clip && clip.x === 0 && clip.y === 0 && clip.width === 1100 && clip.height === 800 && clip.scale === 1
      return Promise.resolve(css ? fake.jpeg : fake.device)
    },
    isClosed() { return false },
    setViewport() { return Promise.resolve() },
    waitForNetworkIdle() { return Promise.resolve() },
    evaluate(fn) {
      if (fn && fn.name === 'pageSnapshot') {
        return Promise.resolve({ title: 'Example', text: 'hello', controls: ['link Pricing'], hasPassword: false })
      }
      return Promise.resolve(null)
    },
    createCDPSession() {
      return Promise.resolve({
        send(method) {
          if (method === 'Browser.getWindowForTarget') return Promise.resolve({ windowId: 1 })
          return Promise.resolve({})
        },
        detach() { return Promise.resolve() }
      })
    },
    mouse: {
      click(x, y) { fake.actions.push('mouse ' + x + ' ' + y); return Promise.resolve() },
      wheel(o) { fake.actions.push('wheel ' + (o && o.deltaY)); return Promise.resolve() }
    },
    keyboard: {
      type(t) { fake.actions.push('type ' + t); return Promise.resolve() },
      press(k) { fake.actions.push('press ' + k); return Promise.resolve() }
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

test('one chat address and one desk browser share one Chrome', { timeout: 120_000 }, async () => {
  registerStubIpc()
  const send = g.__ipcHandlers?.get('chat:send')
  assert.equal(typeof send, 'function')
  const fake = g.__browserFake!
  const warm = g.__warmCalls!
  const payload = { tabId: 't', kind: 'grok' as const, cwd: brains[0] }

  await send!(null, { ...payload, text: 'https://example.com' })
  assert.equal(fake.url, 'https://example.com')
  assert.equal(fake.pages.length, 1)
  assert.equal(fake.launches.length, 1)
  const opts = fake.launches[0]
  assert.equal(opts.pipe, true)
  assert.equal(opts.headless, false)
  assert.equal('args' in opts, false)
  assert.deepEqual(
    Object.keys(opts).sort(),
    ['executablePath', 'headless', 'pipe', 'userDataDir']
  )
  assert.equal(opts.userDataDir, join(homedir(), '.brain-sessions', 'desk'))

  const a = openDeskController(brains[0])
  const b = openDeskController(brains[1])
  const shotsBefore = fake.shots.length
  const shotA = await a.picture()
  const shotB = await b.picture()
  const expected = Buffer.from(jpeg).toString('base64')
  const cssShot = {
    type: 'jpeg',
    quality: 40,
    fromSurface: false,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1100, height: 800, scale: 1 }
  }
  assert.deepEqual(fake.shots.slice(shotsBefore), [cssShot, cssShot])
  assert.equal(shotA, expected)
  assert.equal(shotB, expected)
  const wrong = Buffer.from(await fake.pages[0].screenshot({ type: 'jpeg', quality: 40 })).toString('base64')
  assert.notEqual(wrong, expected)
  assert.equal(fake.launches.length, 1)
  assert.equal(fake.pages.length, 1)

  await send!(null, { ...payload, text: 'hello' })
  await send!(null, { ...payload, text: 'see https://example.com' })
  assert.equal(fake.url, 'https://example.com')
  assert.deepEqual(
    warm.map((c) => c.text),
    ['https://example.com', 'hello', 'see https://example.com']
  )
  for (const call of warm) {
    assert.equal('tools' in call, false)
    assert.equal('browse' in call, false)
    assert.equal('jpeg' in call, false)
    assert.equal(/jpeg|data:image|browse/i.test(JSON.stringify(call)), false)
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

  const browser = sharedDeskBrowser()
  await browser.open!('b_1')
  await browser.runStep!('b_1', { action: 'url', url: 'https://example.com/start' })
  assert.equal(fake.launches.length, 1)
  fake.actions = []
  const click = browser.runStep!('b_1', { action: 'click', detail: 'Pricing' })
  const chat = send!(null, { ...payload, text: 'https://example.com' })
  const [clickResult] = await Promise.all([click, chat])
  assert.deepEqual(fake.actions, ['goto https://example.com'])
  assert.equal((clickResult as { refused?: string }).refused, 'missing')
  assert.equal(fake.launches.length, 1)
  assert.equal(fake.pages.length, 1)
  assert.equal(fake.url, 'https://example.com')
})
