import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS } from '../../shared/desk.ts'
import type { PageAdapter } from '../../shared/desk.ts'
import { deskProfileDir, makeDeskLaunch, pageScroll, pageSnapshot, pageSubmitFor } from './chrome.ts'
import type { ChromeBrowser, ChromeLaunchOptions, ChromePage, DeskPage, PageDoc } from './chrome.ts'

/** 400 numbered lines, about 18,000 characters. */
const BODY = Array.from({ length: 400 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} of the Summit page, plain words.`).join('\n')
const CONTROLS = ['link Pricing', 'field Search', 'button Search', 'button Pay now']

function fakeChromeExe(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'desk-chrome-')), 'Google Chrome')
  writeFileSync(file, '')
  return file
}

/** One fake Browser with one fake Page. The page's evaluate runs the real bodies against a fake document. */
function fakePuppeteer() {
  const doc: PageDoc = { bodyText: BODY, controls: [...CONTROLS], hasPassword: false, scrollY: 0, title: 'Summit' }
  const calls: unknown[][] = []
  const launches: ChromeLaunchOptions[] = []
  let closed = false
  const page: ChromePage = {
    goto: async (url, options) => {
      calls.push(['goto', url, options])
    },
    evaluate: async (fn, ...args) => {
      calls.push(['evaluate', fn, ...args])
      if (fn === pageSnapshot) return pageSnapshot(doc, args[1], args[2])
      if (fn === pageScroll) doc.scrollY += args[0] === 'up' ? -6000 : 6000
      if (fn === pageSubmitFor) return { index: 2, name: 'Search' }
      return undefined
    },
    url: () => 'https://summit.example/',
    click: async (selector, options) => {
      calls.push(options ? ['click', selector, options] : ['click', selector])
    },
    type: async (selector, text) => {
      calls.push(['type', selector, text])
    },
    bringToFront: async () => {
      calls.push(['bringToFront'])
    },
    isClosed: () => closed,
    setViewport: async (v) => {
      calls.push(['setViewport', v])
    }
  }
  const browser: ChromeBrowser = {
    pages: async () => (closed ? [] : [page]),
    newPage: async () => {
      calls.push(['newPage'])
      closed = false
      return page
    },
    connected: true
  }
  const puppeteerLaunch = async (options: ChromeLaunchOptions) => {
    launches.push(options)
    return browser
  }
  return { doc, calls, launches, puppeteerLaunch, closePage: () => (closed = true), page }
}

async function launched(fake: ReturnType<typeof fakePuppeteer>, chromePath = fakeChromeExe()): Promise<DeskPage> {
  const got = await makeDeskLaunch(fake.puppeteerLaunch)({ chromePath, profileDir: deskProfileDir() })
  assert.ok(!('noChrome' in got))
  return got
}

test('launch passes exactly pipe, headless false, the Chrome path, and the desk profile', async () => {
  const fake = fakePuppeteer()
  const chromePath = fakeChromeExe()
  await launched(fake, chromePath)
  assert.deepEqual(fake.launches, [
    { pipe: true, headless: false, executablePath: chromePath, userDataDir: join(homedir(), '.brain-sessions', 'desk') }
  ])
  assert.notEqual(fake.launches[0].userDataDir, join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'))
  assert.ok(!('args' in fake.launches[0]), 'no --remote-debugging-port or other args')
})

test('a missing chromePath returns noChrome without calling puppeteerLaunch', async () => {
  const fake = fakePuppeteer()
  const got = await makeDeskLaunch(fake.puppeteerLaunch)({ chromePath: join(tmpdir(), 'no-such-dir', 'Google Chrome'), profileDir: deskProfileDir() })
  assert.deepEqual(got, { noChrome: true })
  assert.equal(fake.launches.length, 0)
  assert.deepEqual(await makeDeskLaunch(fake.puppeteerLaunch)({ chromePath: '', profileDir: deskProfileDir() }), { noChrome: true })
  assert.equal(fake.launches.length, 0)
})

test('goto, snapshot, click, type, submit, submitFor, and scroll reach the Page', async () => {
  const fake = fakePuppeteer()
  const a: PageAdapter = await launched(fake)
  fake.calls.length = 0

  await a.goto('https://summit.example/')
  assert.deepEqual(fake.calls.shift(), ['goto', 'https://summit.example/', { waitUntil: 'domcontentloaded', timeout: 30_000 }])

  const snap = await a.snapshot()
  assert.deepEqual(fake.calls.shift(), ['evaluate', pageSnapshot, null, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS])
  assert.equal(snap.url, 'https://summit.example/')
  assert.equal(snap.title, 'Summit')
  assert.deepEqual(snap.controls, CONTROLS)
  assert.ok(snap.text.startsWith('Line 001 of the Summit page'))

  await a.click(0)
  assert.deepEqual(fake.calls.shift(), ['click', '[data-desk-n="0"]'])

  await a.type(1, 'september numbers')
  assert.deepEqual(fake.calls.splice(0, 2), [
    ['click', '[data-desk-n="1"]', { count: 3 }],
    ['type', '[data-desk-n="1"]', 'september numbers']
  ])

  assert.deepEqual(await a.submitFor(1), { index: 2, name: 'Search' })
  assert.deepEqual(fake.calls.shift(), ['evaluate', pageSubmitFor, 1])

  await a.submit(2)
  assert.deepEqual(fake.calls.shift(), ['click', '[data-desk-n="2"]'])

  await a.scroll('down')
  assert.deepEqual(fake.calls.shift(), ['evaluate', pageScroll, 'down'])
  assert.equal(fake.calls.length, 0)
})

test('scroll down is one step, and the next snapshot is the lower part of the same text', async () => {
  const fake = fakePuppeteer()
  const a = await launched(fake)
  const top = await a.snapshot()
  await a.scroll('down')
  assert.equal(fake.doc.scrollY, 6000)
  const lower = await a.snapshot()
  assert.notEqual(lower.text, top.text)
  const start = BODY.lastIndexOf('\n', 6000 - 1) + 1
  assert.ok(lower.text.length <= BROWSE_TEXT_CHARS)
  assert.equal(lower.text, BODY.slice(start, start + lower.text.length))
  assert.equal(BODY[start + lower.text.length], '\n', 'cut on a line break')
  assert.deepEqual(lower.controls, CONTROLS)
})

test('the evaluate body: scrollY 0 is the top, cut at 8,000 on a line break; a later scrollY starts on a whole line', () => {
  const doc = { bodyText: BODY, controls: CONTROLS, hasPassword: false, scrollY: 0 }
  const top = pageSnapshot(doc, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.ok(top.text.length <= BROWSE_TEXT_CHARS && top.text.length > BROWSE_TEXT_CHARS - 80)
  assert.equal(top.text, BODY.slice(0, top.text.length))
  assert.equal(BODY[top.text.length], '\n')
  assert.deepEqual(top.controls, CONTROLS)
  assert.equal(top.hasPassword, false)
  assert.equal(top.title, '')

  const mid = pageSnapshot({ ...doc, scrollY: 9000 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.match(mid.text, /^Line \d{3} of the Summit page/)
  assert.ok(BODY.includes(mid.text))
  assert.ok(BODY.indexOf(mid.text) <= 9000 && BODY.indexOf(mid.text) > 9000 - 60)

  const end = pageSnapshot({ ...doc, scrollY: BODY.length + 500 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.equal(end.text, 'Line 400 of the Summit page, plain words.')
})

test('the evaluate body keeps at most 40 controls, in order', () => {
  const many = Array.from({ length: 55 }, (_, i) => `link Note ${i + 1}`)
  const got = pageSnapshot({ bodyText: 'short', controls: many, hasPassword: true, scrollY: 0 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.equal(got.controls.length, BROWSE_MAX_CONTROLS)
  assert.equal(got.controls[0], 'link Note 1')
  assert.equal(got.controls[39], 'link Note 40')
  assert.equal(got.hasPassword, true)
  assert.equal(got.text, 'short')
})

test('front brings the page forward, and closed follows the page', async () => {
  const fake = fakePuppeteer()
  const a = await launched(fake)
  fake.calls.length = 0
  await a.front?.()
  assert.deepEqual(fake.calls, [['bringToFront']])
  assert.equal(a.closed?.(), false)
  fake.closePage()
  assert.equal(a.closed?.(), true)
})

test('a closed window with Chrome still running opens a page in it, not a second Chrome on the same profile', async () => {
  const fake = fakePuppeteer()
  const launch = makeDeskLaunch(fake.puppeteerLaunch)
  const chromePath = fakeChromeExe()
  await launch({ chromePath, profileDir: deskProfileDir() })
  fake.closePage()
  fake.calls.length = 0
  const again = await launch({ chromePath, profileDir: deskProfileDir() })
  assert.ok(!('noChrome' in again))
  assert.equal(fake.launches.length, 1)
  assert.deepEqual(fake.calls[0], ['newPage'])
})

test('launch parks the window off screen, and front brings it back on screen before bringToFront', async () => {
  const fake = fakePuppeteer()
  const seen: unknown[][] = []
  let opened = 0
  let detaches = 0
  fake.page.createCDPSession = async () => {
    opened += 1
    return {
      send: async (method: string, params?: object) => {
        seen.push([method, params])
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 }
        return {}
      },
      detach: async () => {
        detaches += 1
      }
    }
  }
  const bring = fake.page.bringToFront
  fake.page.bringToFront = async () => {
    seen.push(['bringToFront'])
    await bring()
  }
  const page = await launched(fake)
  assert.ok(!('args' in fake.launches[0]), 'park is not a launch argument')
  const parked = seen.find((row) => row[0] === 'Browser.setWindowBounds')
  const parkBounds = (parked?.[1] as { bounds?: { left: number; width: number; windowState: string } } | undefined)?.bounds
  assert.ok(parkBounds && typeof parkBounds.width === 'number' && parkBounds.left + parkBounds.width <= 0 && parkBounds.windowState === 'normal', JSON.stringify(parked))
  seen.length = 0
  await page.front?.()
  const i = seen.findIndex((row) => row[0] === 'Browser.setWindowBounds')
  const showBounds = (seen[i]?.[1] as { bounds?: { left: number; top: number; width: number; height: number; windowState: string } } | undefined)?.bounds
  assert.ok(showBounds, JSON.stringify(seen))
  assert.ok(showBounds.left >= 40 && showBounds.left <= 120, String(showBounds.left))
  assert.ok(showBounds.top >= 20 && showBounds.top <= 100, String(showBounds.top))
  assert.equal(showBounds.width, 1100)
  assert.equal(showBounds.height, 800)
  assert.equal(showBounds.windowState, 'normal')
  assert.deepEqual(seen[i + 1], ['bringToFront'])
  await page.front?.()
  assert.equal(opened, detaches)
  assert.ok(opened >= 3)
})

test('a page with no CDP session still launches, and front still brings it forward', async () => {
  const fake = fakePuppeteer()
  assert.equal(fake.page.createCDPSession, undefined)
  const page = await launched(fake)
  fake.calls.length = 0
  await page.front?.()
  assert.deepEqual(fake.calls, [['bringToFront']])
})

test('the page fills the window: viewport emulation is turned off after launch', async () => {
  const fake = fakePuppeteer()
  await launched(fake)
  assert.deepEqual(
    fake.calls.filter((c) => c[0] === 'setViewport'),
    [['setViewport', null]]
  )
})

test('chrome.ts and browser.ts do not import puppeteer-core', () => {
  for (const file of ['chrome.ts', 'browser.ts']) {
    const src = readFileSync(join(import.meta.dirname, file), 'utf8')
    assert.doesNotMatch(src, /from\s+['"]puppeteer|require\(\s*['"]puppeteer|import\(\s*['"]puppeteer/, file)
  }
})

test('puppeteer-core is a dependency, not a devDependency', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['puppeteer-core'])
  assert.equal(pkg.devDependencies['puppeteer-core'], undefined)
  assert.match(pkg.scripts.dev, /BRAIN_APP_DRY_RUN=1/)
})
