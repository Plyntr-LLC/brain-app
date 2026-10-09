import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import type { DeskCli } from '../../shared/desk.ts'
import { argvFor } from './runner.ts'

const userData = mkdtempSync(join(tmpdir(), 'desk-shared-user-'))
const brains = [mkdtempSync(join(tmpdir(), 'desk-shared-a-')), mkdtempSync(join(tmpdir(), 'desk-shared-b-'))]
const jpeg = Uint8Array.from([9, 8, 7, 6])

type FakePage = { windowId: number; _url: string; _closed: boolean }
type Fake = {
  views: Array<{ webPreferences?: { offscreen?: boolean; partition?: string } }>
  hosts: Array<{ show?: boolean }>
  partitions: string[]
  resized: Array<{ from: { width: number; height: number }; to: { width: number; height: number } }>
  captureSize: { width: number; height: number } | null
  actions: string[]
  pages: FakePage[]
  url: string
  jpeg: Uint8Array
  shotIds: number[]
  entered: string[]
  holds: Array<{ url: string; release: () => void }>
  nextId: number
  holdGoto: boolean
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
// Electron sets this; the in-app browser builds its Chrome user agent from it.
if (!process.versions.chrome) Object.defineProperty(process.versions, 'chrome', { value: '138.0.0.0' })
g.__browserFake = {
  views: [],
  hosts: [],
  partitions: [],
  resized: [],
  captureSize: null,
  actions: [],
  pages: [],
  url: '',
  jpeg,
  shotIds: [],
  entered: [],
  holds: [],
  nextId: 1,
  holdGoto: false,
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
` + readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'fakes', 'electron-browser.js'), 'utf8')

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
      url === 'stub:electron' ? electronSource : url === 'stub:warm' ? warmSource : url === 'stub:updater' ? 'export const autoUpdater = { on() {}, checkForUpdates: async () => null, quitAndInstall() {} }\nexport default { autoUpdater }\n' : url === 'stub:line-rpc' ? lineRpc : ''
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

test('chats and desk bots share the in-app browser, and WhatsApp is the one shared window', { timeout: 120_000 }, async () => {
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
  assert.equal(fake.views.length, 3)
  assert.ok(fake.views.every((v) => v.webPreferences?.offscreen === true && v.webPreferences?.partition === 'persist:brain-browser'))
  assert.ok(fake.hosts.length === 3 && fake.hosts.every((h) => h.show === false))
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])
  for (const hold of fake.holds) hold.release()
  fake.holds = []
  fake.holdGoto = false
  await Promise.all(opened)
  assert.equal(live().length, 3)
  assert.deepEqual(urls(), ['https://a.example', 'https://b.example', 'https://w.example'])
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])

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
  assert.equal(await browser.picture!('chat:chat-a'), expected)
  assert.equal(await browser.picture!('desk:writer'), expected)
  assert.deepEqual(fake.shotIds.slice(shotsBefore), [wa!.windowId, wa!.windowId])
  assert.deepEqual(fake.resized, [])
  fake.captureSize = { width: 2200, height: 1600 }
  assert.equal(await browser.picture!('chat:chat-a'), expected)
  fake.captureSize = null
  assert.deepEqual(fake.resized, [{ from: { width: 2200, height: 1600 }, to: { width: 1100, height: 800 } }])

  await close!(null, 'chat-a')
  assert.equal(live().some((p) => p._url === 'https://a.example'), false)
  assert.equal(wa!._closed, false)
  assert.ok(live().some((p) => p._url === 'https://b.example'))
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])
  await browser.goTo!('https://web.whatsapp.com', 'chat:chat-a')
  assert.equal(wa!._closed, false)
  assert.equal(openDeskController(brains[0]).removeBot('writer'), null)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(live().some((p) => p._url === 'https://w.example'), false)
  assert.equal(wa!._closed, false)
  assert.ok(live().some((p) => p._url === 'https://b.example'))
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])

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
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])

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
  assert.equal(fake.actions.some((row) => row === 'show' || row === 'focus'), false)
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])

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
  assert.equal(waForClick!._closed, false)
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])

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
  assert.equal(waForClick!._closed, false)
  assert.deepEqual(fake.partitions, ['persist:brain-browser'])
  assert.equal(fake.actions.some((row) => row === 'show' || row === 'focus'), false)
  assert.ok(fake.hosts.every((h) => h.show === false))

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
