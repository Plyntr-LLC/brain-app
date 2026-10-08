import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DeskCli } from '../../shared/desk.ts'
import { createDeskController } from './controller.ts'
import type { DeskController } from './controller.ts'
import type { DeskHostDeps } from './ipc.ts'
import type { RunResult } from './runner.ts'
import { seedDesk } from './seed.ts'
import { buildWelcome } from './welcome.ts'

const userData = mkdtempSync(join(tmpdir(), 'desk-ipc-user-'))
;(globalThis as { __deskUserData?: string }).__deskUserData = userData

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json|node)$/.test(spec)) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url !== 'stub:electron') return next(url, ctx)
    return {
      format: 'module',
      shortCircuit: true,
      source: `export const app = { getVersion: () => '0.0.0', getPath: () => globalThis.__deskUserData, getAppPath: () => globalThis.__deskUserData, isPackaged: false, on() {} }
export const BrowserWindow = { getAllWindows: () => [] }
export const ipcMain = { handle() {}, on() {} }
export const shell = {}
export default { app, BrowserWindow, ipcMain, shell }`
    }
  }
})

const { createDeskHost, openDeskController } = await import('./ipc.ts')

after(() => rmSync(userData, { recursive: true, force: true }))

const DETECT: Record<DeskCli, boolean> = { grok: true, claude: false, gpt: false, cursor: false }
const CLOSED = 'Stopped when you closed Desk.'
const QUIT = 'Stopped when Brain quit.'

function hangRunner() {
  const pending = new Map<string, Array<(r: RunResult) => void>>()
  return {
    run(opts: { bot: { id: string } }) {
      return new Promise<RunResult>((resolve) => {
        const list = pending.get(opts.bot.id) || []
        list.push(resolve)
        pending.set(opts.bot.id, list)
      })
    },
    stop(id: string) {
      const list = pending.get(id) || []
      pending.set(id, [])
      for (const resolve of list) resolve({ status: 'stopped', lastTry: { cli: 'grok', model: 'default' }, tries: [] })
      return list.length > 0
    },
    stopAll() {
      const ids = [...pending.keys()]
      for (const id of ids) this.stop(id)
      return ids
    },
    keepWaiting() {
      return false
    }
  }
}

function quietBrowser() {
  return {
    open: async () => undefined,
    cancel() {},
    release() {},
    focus() {},
    windowOpen: () => false,
    async clickApproved() {
      return { ok: true as const, url: 'https://example.com', title: 'Example', text: '', controls: [] }
    },
    async runStep() {
      return { ok: true as const, url: 'https://example.com', title: 'Example', text: '', controls: [] }
    }
  }
}

function quietSenders() {
  return {
    gmailFrom: async () => 'joe@example.com',
    check: async () => 'ok' as const,
    sendEmail: async () => ({ ok: true }),
    lookupText: async () => ({ sendable: true, label: 'Brent' }),
    sendText: async () => ({ ok: true }),
    sendWhatsApp: () => ({ ok: false, sendable: false })
  }
}

function boot(emit?: DeskHostDeps['emit']) {
  const brain = mkdtempSync(join(tmpdir(), 'desk-ipc-'))
  seedDesk({ brain, role: 'owner', detect: () => DETECT })
  const runner = hangRunner()
  const desk = createDeskController({
    brain,
    role: 'owner',
    runner,
    browser: quietBrowser(),
    senders: quietSenders(),
    detect: () => DETECT,
    tokenReady: () => true
  })
  let opened = 0
  const deps: DeskHostDeps = {
    open() {
      opened++
      return desk
    },
    detect: () => DETECT,
    greetingName: () => null,
    ...(emit ? { emit } : {})
  }
  const host = createDeskHost(deps)
  return {
    brain,
    desk,
    host,
    opened: () => opened,
    cleanup: () => rmSync(brain, { recursive: true, force: true })
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(check(), 'condition never became true')
}

function stoppedText(desk: DeskController, text: string): boolean {
  return desk.store.readMail().some((m) => m.kind === 'stopped' && m.text === text)
}

test('two Desk tabs share one controller, and only the last close with stop writes the close sentence', async () => {
  const { brain, desk, host, opened, cleanup } = boot()
  try {
    const a = host.attach('tab-a', brain)
    const b = host.attach('tab-b', `${brain}/`)
    assert.equal(a.brain, b.brain)
    assert.equal(opened(), 1)
    assert.equal(host.opened(), 1)
    const other = mkdtempSync(join(tmpdir(), 'desk-ipc-b-'))
    try {
      host.attach('tab-c', other)
      assert.equal(host.opened(), 2)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }

    const working = host.say('tab-a', 'Draft it.', 'writer')
    await until(() => host.list('tab-a').states.some((s) => s.id === 'writer' && s.state === 'working'))
    const mid = host.closeCheck('tab-a')
    assert.equal(mid.last, false)
    assert.deepEqual(mid.busyNames, ['Writer'])
    assert.equal(stoppedText(desk, CLOSED), false)
    await host.detach('tab-b', { stop: true })
    assert.equal(stoppedText(desk, CLOSED), false)
    assert.equal(host.list('tab-a').states.some((s) => s.id === 'writer' && s.state === 'working'), true)

    const last = host.closeCheck('tab-a')
    assert.equal(last.last, true)
    assert.deepEqual(last.busyNames, ['Writer'])
    assert.equal(stoppedText(desk, CLOSED), false)
    assert.equal(host.remove('tab-a', 'writer'), 'Writer is in the middle of something. Finish or stop that first.')
    assert.equal(existsSync(join(brain, 'desk/bots/writer.md')), true)
    assert.equal(host.remove('tab-a', 'checker'), null)
    assert.equal(host.list('tab-a').removedNames.checker, 'Checker')

    const welcome = host.welcome('tab-a', 'writer')
    assert.deepEqual(
      welcome,
      buildWelcome({ brain: a.brain, bots: host.list('tab-a').bots, detect: () => DETECT, greetingName: null, thread: 'writer' })
    )
    assert.equal(welcome.composerPlaceholder, 'Message Writer')

    await host.detach('tab-a', { stop: false })
    host.attach('tab-d', brain)
    assert.equal(opened(), 2)
    await host.detach('tab-d', { stop: true })
    await working
    assert.equal(stoppedText(desk, CLOSED), true)
    assert.equal(stoppedText(desk, QUIT), false)
    assert.throws(() => host.list('missing'), /Desk isn't open/)
    assert.deepEqual(host.closeCheck('missing'), { last: false, busyNames: [] })
  } finally {
    await host.quitAll()
    cleanup()
  }
})

test('before-quit stops busy bots and writes the quit sentence', async () => {
  const seen: string[] = []
  const { brain, desk, host, cleanup } = boot((snap) => {
    if (snap.messages.some((m) => m.kind === 'stopped' && m.text === QUIT)) seen.push('quit')
  })
  try {
    host.attach('tab-a', brain)
    const working = host.say('tab-a', 'Draft it.', 'writer')
    await until(() => host.list('tab-a').states.some((s) => s.id === 'writer' && s.state === 'working'))
    await host.quitAll()
    await working
    assert.equal(stoppedText(desk, QUIT), true)
    assert.equal(stoppedText(desk, CLOSED), false)
    assert.equal(seen.length > 0, true)
  } finally {
    await host.quitAll()
    cleanup()
  }
})

test('the live wiring uses one shared desk Chrome launch and the dry-run env', () => {
  const src = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
  const shared = readFileSync(new URL('../shared-browser.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function openDeskController'), src.indexOf('export function createDeskHost'))
  assert.equal(fn.includes('makeDeskLaunch'), false)
  assert.match(fn, /sharedDeskBrowser\(\)/)
  assert.equal(shared.match(/makeDeskLaunch\(\s*puppeteer\.launch\s*\)/g)?.length, 1)
  assert.doesNotMatch(src, /launch:\s*puppeteer\.launch\b/)
  assert.match(src, /process\.env\.BRAIN_APP_DRY_RUN === '1'/)
  assert.match(src, /roleForBrainWrite/)
  assert.match(src, /roleForKeylessWrite/)
  assert.match(src, /brainIdForFolder/)
  assert.match(src, /before-quit/)
  assert.equal(src.includes(CLOSED), false)
  assert.equal(src.includes(QUIT), false)
})

test('openDeskController seeds the bots without sending or browsing', () => {
  const brain = mkdtempSync(join(tmpdir(), 'desk-ipc-live-'))
  try {
    const desk = openDeskController(brain)
    assert.equal(existsSync(join(brain, 'desk/bots/writer.md')), true)
    assert.equal(desk.list().bots.some((b) => b.id === 'conductor'), true)
    assert.equal(desk.store.readMail().length, 0)
  } finally {
    rmSync(brain, { recursive: true, force: true })
  }
})
