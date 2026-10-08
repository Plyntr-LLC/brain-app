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

test('front does not move the window, and closed follows the page', async () => {
  const fake = fakePuppeteer()
  const a = await launched(fake)
  fake.calls.length = 0
  await a.front?.()
  assert.deepEqual(fake.calls, [])
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

test('launch parks the window, then minimizes it, and later work stays minimized', async () => {
  const fake = fakePuppeteer()
  const seen: unknown[][] = []
  const windowIds: number[] = []
  let opened = 0
  let detaches = 0
  fake.page.createCDPSession = async () => {
    opened += 1
    return {
      send: async (method: string, params?: object) => {
        seen.push([method, params])
        if (method === 'Browser.getWindowForTarget') {
          windowIds.push(7)
          return { windowId: 7 }
        }
        return {}
      },
      detach: async () => {
        detaches += 1
      }
    }
  }
  fake.page.screenshot = async () => new Uint8Array([1])
  fake.page.mouse = {
    click: async () => {
      fake.calls.push(['mouse'])
    },
    wheel: async () => {
      fake.calls.push(['wheel'])
    }
  }
  fake.page.keyboard = {
    type: async () => {
      fake.calls.push(['keytype'])
    },
    press: async () => {
      fake.calls.push(['press'])
    }
  }
  const page = await launched(fake)
  assert.ok(!('args' in fake.launches[0]), 'park is not a launch argument')
  const boundsOf = (rows: unknown[][]) =>
    rows
      .filter((row) => row[0] === 'Browser.setWindowBounds')
      .map((row) => (row[1] as { windowId?: number; bounds?: { left: number; width: number; windowState: string } }).bounds)
  const idsOf = (rows: unknown[][]) =>
    rows.filter((row) => row[0] === 'Browser.setWindowBounds').map((row) => (row[1] as { windowId?: number }).windowId)
  const first = boundsOf(seen)
  assert.equal(first.length, 2, JSON.stringify(first))
  assert.ok(first[0] && first[0].left + first[0].width <= 0 && first[0].windowState === 'normal', JSON.stringify(first[0]))
  assert.equal(first[1]?.windowState, 'minimized')
  assert.ok((first[1]?.left ?? 1) <= 0, JSON.stringify(first[1]))
  seen.length = 0
  await page.front?.()
  assert.deepEqual(seen, [])
  await page.goto('https://a.example/')
  await page.shot?.()
  await page.clickAt?.(10, 12)
  await page.typeText?.('a')
  await page.pressKey?.('Enter')
  await page.wheel?.(20)
  const later = boundsOf(seen)
  assert.ok(later.length >= 6, String(later.length))
  for (const bounds of later) {
    assert.equal(bounds?.windowState, 'minimized')
    assert.ok((bounds?.left ?? 1) <= 0, JSON.stringify(bounds))
  }
  for (const id of idsOf(seen)) assert.ok(windowIds.includes(id as number), String(id))
  assert.equal(seen.filter((row) => row[0] === 'bringToFront').length, 0)
  assert.equal(opened, detaches)
})

test('a page with no CDP session still launches, and front does not bring it forward', async () => {
  const fake = fakePuppeteer()
  assert.equal(fake.page.createCDPSession, undefined)
  const page = await launched(fake)
  fake.calls.length = 0
  await page.front?.()
  assert.deepEqual(fake.calls, [])
})

test('launch sets an 1100 by 800 viewport before the picture is taken', async () => {
  const fake = fakePuppeteer()
  await launched(fake)
  assert.deepEqual(
    fake.calls.filter((c) => c[0] === 'setViewport'),
    [['setViewport', { width: 1100, height: 800, deviceScaleFactor: 1 }]]
  )
})

test('chrome.ts and browser.ts do not import puppeteer-core', () => {
  for (const file of ['chrome.ts', 'browser.ts']) {
    const src = readFileSync(join(import.meta.dirname, file), 'utf8')
    assert.doesNotMatch(src, /from\s+['"]puppeteer|require\(\s*['"]puppeteer|import\(\s*['"]puppeteer/, file)
  }
})

test('a created window that pages() does not list yet is parked, and newPage is not called', async () => {
  const calls: string[] = []
  const bounds: Array<{ windowId?: number; bounds?: { left: number; width: number; windowState: string } }> = []
  let newPages = 0
  let waiting = false
  let releaseWait = () => {}
  const pages: ChromePage[] = []
  const sessionFor = (windowId: number) => async () => ({
    send: async (method: string, params?: { windowId?: number; bounds?: { left: number; width: number; windowState: string } }) => {
      if (method === 'Browser.getWindowForTarget') return { windowId }
      if (method === 'Browser.setWindowBounds') {
        bounds.push({ windowId: params?.windowId, bounds: params?.bounds })
        return {}
      }
      if (method === 'Target.createTarget') {
        calls.push('createTarget')
        return { targetId: 'late' }
      }
      return {}
    },
    detach: async () => {}
  })
  const seed: ChromePage = {
    goto: async () => {},
    evaluate: async () => undefined,
    url: () => 'about:blank',
    click: async () => {},
    type: async () => {},
    bringToFront: async () => {},
    isClosed: () => false,
    setViewport: async () => {
      calls.push('seed-view')
    },
    createCDPSession: sessionFor(1)
  }
  let lateViewport: { width: number; height: number; deviceScaleFactor: number } | null = null
  const late: ChromePage = {
    goto: async () => {},
    evaluate: async () => undefined,
    url: () => 'about:blank',
    click: async () => {},
    type: async () => {},
    bringToFront: async () => {},
    isClosed: () => false,
    setViewport: async (viewport) => {
      if (viewport) lateViewport = viewport
    },
    createCDPSession: sessionFor(9),
    target: () => ({ _targetId: 'late' }),
    close: async () => {}
  }
  const browser: ChromeBrowser = {
    pages: async () => pages.filter((page) => !page.isClosed()),
    newPage: async () => {
      newPages += 1
      if (newPages === 1) {
        pages.push(seed)
        return seed
      }
      calls.push('newPage')
      pages.push(seed)
      return seed
    },
    connected: true,
    waitForTarget: async (predicate) => {
      waiting = true
      await new Promise<void>((resolve) => {
        releaseWait = () => resolve()
      })
      pages.push(late)
      const target = { _targetId: 'late', page: async () => late }
      if (!(await predicate(target))) throw new Error('predicate missed the created target')
      return target
    }
  }
  const launch = makeDeskLaunch(async () => browser)
  await launch({ chromePath: fakeChromeExe(), profileDir: deskProfileDir() })
  const newPagesAfterFirst = newPages
  calls.length = 0
  const pending = launch.windows.page('chat:other')
  const end = Date.now() + 2000
  while (!waiting) {
    if (Date.now() > end) throw new Error('did not wait for the created target')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(pages.includes(late), false)
  assert.equal(calls.includes('createTarget'), true)
  assert.equal(calls.includes('newPage'), false)
  releaseWait()
  const adapter = await pending
  assert.equal('noChrome' in adapter, false)
  assert.equal(newPages, newPagesAfterFirst)
  assert.equal(calls.includes('newPage'), false)
  assert.deepEqual(lateViewport, { width: 1100, height: 800, deviceScaleFactor: 1 })
  const lateBounds = bounds.filter((row) => row.windowId === 9).map((row) => row.bounds)
  assert.equal(lateBounds.length, 2, JSON.stringify(lateBounds))
  assert.ok(lateBounds[0] && lateBounds[0].left + lateBounds[0].width <= 0 && lateBounds[0].windowState === 'normal', JSON.stringify(lateBounds[0]))
  assert.equal(lateBounds[1]?.windowState, 'minimized')
  assert.ok((lateBounds[1]?.left ?? 1) <= 0, JSON.stringify(lateBounds[1]))
})

test('a close during a failed open does not cancel the next open of that key', { timeout: 15_000 }, async () => {
  const pages: ChromePage[] = []
  let creates = 0
  let waits = 0
  let newPages = 0
  let waiting = false
  let releaseWait = () => {}
  let okViewport: { width: number; height: number; deviceScaleFactor: number } | null = null
  let okClosed = false
  const ok: ChromePage = {
    goto: async () => {},
    evaluate: async () => undefined,
    url: () => 'about:blank',
    click: async () => {},
    type: async () => {},
    bringToFront: async () => {},
    isClosed: () => okClosed,
    close: async () => {
      okClosed = true
    },
    setViewport: async (viewport) => {
      if (viewport) okViewport = viewport
    },
    createCDPSession: async () => ({
      send: async (method: string) => (method === 'Browser.getWindowForTarget' ? { windowId: 9 } : {}),
      detach: async () => {}
    }),
    target: () => ({ _targetId: 'ok' })
  }
  const seed: ChromePage = {
    goto: async () => {},
    evaluate: async () => undefined,
    url: () => 'about:blank',
    click: async () => {},
    type: async () => {},
    bringToFront: async () => {},
    isClosed: () => false,
    setViewport: async () => {},
    createCDPSession: async () => ({
      send: async (method: string) => {
        if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
        if (method === 'Browser.setWindowBounds') return {}
        if (method === 'Target.createTarget') {
          creates += 1
          if (creates === 1) return { targetId: 'missing' }
          pages.push(ok)
          return { targetId: 'ok' }
        }
        return {}
      },
      detach: async () => {}
    })
  }
  const browser: ChromeBrowser = {
    pages: async () => pages.filter((page) => !page.isClosed()),
    newPage: async () => {
      newPages += 1
      pages.push(seed)
      return seed
    },
    connected: true,
    waitForTarget: async () => {
      waits += 1
      if (waits > 1) throw new Error('the next open waited instead of using the listed page')
      waiting = true
      await new Promise<void>((_resolve, reject) => {
        releaseWait = () => reject(new Error('target never attached'))
      })
      throw new Error('target never attached')
    }
  }
  const launch = makeDeskLaunch(async () => browser)
  await launch({ chromePath: fakeChromeExe(), profileDir: deskProfileDir() })
  const newPagesAfterFirst = newPages
  const pending = launch.windows.page('chat:z')
  const end = Date.now() + 2000
  while (!waiting) {
    if (Date.now() > end) throw new Error('did not wait for the missing target')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await launch.windows.close('chat:z')
  releaseWait()
  assert.deepEqual(await pending, { noChrome: true })
  const again = await launch.windows.page('chat:z')
  assert.equal('noChrome' in again, false)
  assert.equal(okClosed, false)
  assert.deepEqual(okViewport, { width: 1100, height: 800, deviceScaleFactor: 1 })
  assert.equal(creates, 2)
  assert.equal(newPages, newPagesAfterFirst)
})

test('puppeteer-core is a dependency, not a devDependency', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['puppeteer-core'])
  assert.equal(pkg.devDependencies['puppeteer-core'], undefined)
  assert.match(pkg.scripts.dev, /BRAIN_APP_DRY_RUN=1/)
})
