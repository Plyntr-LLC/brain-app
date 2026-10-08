import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS } from '../../shared/desk.ts'
import type { DeskLaunch, PageAdapter } from '../../shared/desk.ts'

/**
 * The desk Chrome window. `makeDeskLaunch` turns puppeteer's Browser and its Page into the shared
 * `PageAdapter`. This file does not import puppeteer-core: ipc.ts passes `puppeteer.launch` in.
 */

/** The Page calls the adapter makes. puppeteer-core's Page fits this shape. */
export type ChromePage = {
  goto: (url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>
  evaluate: (fn: (...args: any[]) => unknown, ...args: any[]) => Promise<any>
  url: () => string
  click: (selector: string, options?: { count?: number }) => Promise<void>
  type: (selector: string, text: string) => Promise<void>
  bringToFront: () => Promise<void>
  screenshot?: (options: {
    type: 'jpeg'
    quality: number
    fromSurface?: boolean
    captureBeyondViewport?: boolean
    clip?: { x: number; y: number; width: number; height: number; scale?: number }
  }) => Promise<Uint8Array>
  isClosed: () => boolean
  setViewport?: (viewport: null | { width: number; height: number; deviceScaleFactor: number }) => Promise<void>
  close?: () => Promise<void>
  waitForNetworkIdle?: (options: { idleTime: number; timeout: number }) => Promise<void>
  /** Present on a real puppeteer page. Missing on the fake page, which then skips the park.
   * `any` because puppeteer's send() only accepts protocol command names, so a `string` method would reject Page. */
  createCDPSession?: () => Promise<any>
  /** `any` so puppeteer's Mouse and Keyboard stay assignable to this page. */
  mouse?: any
  keyboard?: any
  /** The CDP target this page belongs to. The real page has this. The id is how a new window is found. */
  target?: () => { url?: () => string; _targetId?: string }
}

type ChromeTarget = { url?: () => string; _targetId?: string; page?: () => Promise<ChromePage | null> }

export type ChromeBrowser = {
  pages: () => Promise<ChromePage[]>
  newPage: () => Promise<ChromePage>
  /** A new operating-system window in this same Chrome. Tests provide it. The real browser uses CDP. */
  newWindow?: () => Promise<ChromePage>
  readonly connected: boolean
  /** The real browser has this. A test supplies it when the new page is not in `pages()` yet. */
  waitForTarget?: (predicate: (target: ChromeTarget) => boolean | Promise<boolean>, options?: { timeout?: number }) => Promise<ChromeTarget>
}

/** Exactly these four options. No `connect`, no debugging port. */
export type ChromeLaunchOptions = { pipe: true; headless: false; executablePath: string; userDataDir: string }
export type PuppeteerLaunch = (options: ChromeLaunchOptions) => Promise<ChromeBrowser>

/** Pages this one Chrome already has. `page` creates a window. `peek` does not. */
export type DeskWindows = {
  connect: (opts: { chromePath: string; profileDir: string }) => Promise<ChromeBrowser | { noChrome: true }>
  page: (key: string) => Promise<DeskPage | { noChrome: true }>
  peek: (key: string) => DeskPage | null
  has: (key: string) => boolean
  close: (key: string) => Promise<void>
  anyOpen: () => boolean
}

/** What the adapter adds beyond `PageAdapter`. Optional so a test adapter can leave them out. */
export type DeskPage = PageAdapter & {
  /** The live page does not move the operating-system window. Tests may still record a call. */
  front?: () => Promise<void>
  /** A jpeg of the open page, for the picture in the thread. Empty when the page cannot take one. */
  shot?: () => Promise<Uint8Array>
  /** True once the person closed the desk window or quit that Chrome. */
  closed?: () => boolean
  /** A click at page pixels. The picture maps its own box onto these. */
  clickAt?: (x: number, y: number) => Promise<void>
  /** Keys into the focused page, not into a named field. */
  typeText?: (text: string) => Promise<void>
  pressKey?: (key: string) => Promise<void>
  wheel?: (deltaY: number) => Promise<void>
}

/** What the page reader sees. A test passes a fake with the same fields.
 * `scrollY` is where the window starts, in characters of `bodyText`. The live page maps its pixel
 * scroll onto the text by the share of the page height scrolled past. */
export type PageDoc = { bodyText: string; controls: string[]; hasPassword: boolean; scrollY: number; title?: string }

const APP_CHROME = 'Google Chrome.app/Contents/MacOS/Google Chrome'

/** Google Chrome on this Mac: /Applications, else ~/Applications. When neither exists, the /Applications path, and launch says noChrome. */
export function macChromePath(home = homedir()): string {
  const system = join('/Applications', APP_CHROME)
  const user = join(home, 'Applications', APP_CHROME)
  return !existsSync(system) && existsSync(user) ? user : system
}

/** The desk profile. Not the person's everyday Chrome profile, and never inside the brain. */
export function deskProfileDir(home = homedir()): string {
  return join(home, '.brain-sessions', 'desk')
}

/**
 * The snapshot body. It runs inside the page through `page.evaluate`, so it uses only its arguments and
 * the page's globals: no imports and no outer names. With no `doc` it reads the live page: links,
 * buttons, and text fields from the top of the window down, each marked `data-desk-n` with its
 * number so click, type, and submit can find it again. Then it cuts the text at the scroll position
 * and at `maxText` on a line break.
 */
export function pageSnapshot(
  doc: PageDoc | null,
  maxText: number,
  maxControls: number
): { title: string; text: string; controls: string[]; hasPassword: boolean } {
  if (!doc) {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const shown = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      const st = getComputedStyle(el)
      return st.visibility !== 'hidden' && st.display !== 'none'
    }
    const roleOf = (el: HTMLElement) => {
      const role = el.getAttribute('role')
      if (el.tagName === 'A' || role === 'link') return 'link'
      if (el.tagName === 'BUTTON' || role === 'button') return 'button'
      if (el.tagName === 'INPUT') {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase()
        if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button'
        return ['text', 'search', 'email', 'tel', 'url', 'number', 'password'].includes(t) ? 'field' : ''
      }
      return el.tagName === 'TEXTAREA' || role === 'textbox' || role === 'searchbox' || el.isContentEditable ? 'field' : ''
    }
    // Same order as pageSubmitFor, so a held submit button's name matches its line here.
    const nameOf = (el: HTMLElement, role: string) => {
      const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      const named = clean(el.getAttribute('aria-label')) || clean(by.map((id) => document.getElementById(id)?.innerText || '').join(' '))
      if (named) return named
      if (role === 'field') {
        const labels = (el as HTMLInputElement).labels
        return clean(labels && labels[0] ? labels[0].innerText : '') || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name'))
      }
      return clean(el.innerText) || clean((el as HTMLInputElement).value) || clean(el.getAttribute('title')) || clean(el.querySelector('img[alt]')?.getAttribute('alt'))
    }
    document.querySelectorAll('[data-desk-n]').forEach((el) => el.removeAttribute('data-desk-n'))
    const controls: string[] = []
    const all = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, [role=button], [role=link], [role=textbox], [role=searchbox], [contenteditable]:not([contenteditable="false"])'
    )
    for (const el of Array.from(all)) {
      if (controls.length >= maxControls) break
      const role = roleOf(el)
      if (!role || el.getBoundingClientRect().bottom < 0 || !shown(el)) continue
      const name = nameOf(el, role)
      if (!name) continue
      el.setAttribute('data-desk-n', String(controls.length))
      controls.push(`${role} ${name}`)
    }
    const bodyText = document.body ? document.body.innerText : ''
    const height = Math.max(document.documentElement.scrollHeight, 1)
    doc = {
      title: document.title,
      bodyText,
      controls,
      hasPassword: Array.from(document.querySelectorAll<HTMLElement>('input[type=password]')).some(shown),
      scrollY: Math.round((bodyText.length * window.scrollY) / height)
    }
  }
  const body = doc.bodyText || ''
  let start = Math.max(0, Math.min(Math.floor(doc.scrollY || 0), body.length))
  if (start > 0) start = body.lastIndexOf('\n', start - 1) + 1
  let text = body.slice(start)
  if (text.length > maxText) {
    const cut = text.lastIndexOf('\n', maxText)
    text = text.slice(0, cut > 0 ? cut : maxText)
  }
  return { title: doc.title || '', text, controls: doc.controls.slice(0, maxControls), hasPassword: !!doc.hasPassword }
}

/** Runs in the page. One window height, a little less so a line stays in view. */
export function pageScroll(dir: 'down' | 'up'): void {
  window.scrollBy(0, (dir === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.85))
}

/** Runs in the page. The submit control in the form of field `i`, numbered like the last snapshot.
 * A submit button the snapshot did not list gets the next free number. */
export function pageSubmitFor(i: number): { index: number; name: string } | null {
  const field = document.querySelector(`[data-desk-n="${i}"]`) as HTMLInputElement | null
  const form = field ? field.form : null
  if (!form) return null
  const sub = Array.from(form.elements).find(
    (el) => (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'))
  ) as HTMLInputElement | undefined
  if (!sub) return null
  let at = sub.getAttribute('data-desk-n')
  if (at === null) {
    at = String(document.querySelectorAll('[data-desk-n]').length)
    sub.setAttribute('data-desk-n', at)
  }
  const name = (sub.getAttribute('aria-label') || sub.innerText || sub.value || sub.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return { index: Number(at), name }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e)

type WindowBounds = { left: number; top: number; width: number; height: number; windowState: 'normal' | 'minimized' }

/** Off the screen, with a width, so a restored window cannot ignore a bare negative left. */
const PARKED: WindowBounds = { left: -2400, top: 0, width: 1100, height: 800, windowState: 'normal' }
/** Same rectangle, minimized, so macOS cannot clamp a strip back onto the laptop. */
const MINIMIZED: WindowBounds = { left: -2400, top: 0, width: 1100, height: 800, windowState: 'minimized' }
const PAGE_VIEW = { width: 1100, height: 800, deviceScaleFactor: 1 }

/** Best effort. A page with no CDP session, or a CDP error, leaves the window where it is. */
async function place(page: ChromePage, bounds: WindowBounds) {
  if (!page.createCDPSession) return
  let client: Awaited<ReturnType<NonNullable<ChromePage['createCDPSession']>>> | undefined
  try {
    client = await page.createCDPSession()
    const got = await client.send('Browser.getWindowForTarget')
    if (got?.windowId == null) return
    await client.send('Browser.setWindowBounds', { windowId: got.windowId, bounds })
  } catch {
    // The picture in the thread still works if the operating-system window cannot be moved.
  } finally {
    try {
      await client?.detach?.()
    } catch {
      // The session is already gone.
    }
  }
}

function adapterFor(browser: ChromeBrowser, page: ChromePage): DeskPage {
  let lastControls: string[] | null = null
  const at = (i: number) => `[data-desk-n="${i}"]`
  const settle = async () => {
    await page.waitForNetworkIdle?.({ idleTime: 400, timeout: 4000 }).catch(() => {})
  }
  const read = async () => {
    for (let tries = 1; ; tries++) {
      try {
        return (await page.evaluate(pageSnapshot, null, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)) as ReturnType<typeof pageSnapshot>
      } catch (e) {
        // A click that navigates can swap the page out from under the read.
        if (tries >= 3 || !/context|navigat|detached/i.test(errText(e))) throw e
        await settle()
      }
    }
  }
  const hide = () => place(page, MINIMIZED)
  // A page that re-rendered since the last look has lost its marks. Mark it again and retry once,
  // only when that number still names the same control.
  const onControl = async (i: number, run: () => Promise<void>) => {
    await hide()
    try {
      await run()
    } catch (e) {
      if (!lastControls || !/no element found/i.test(errText(e))) throw e
      const now = await read()
      if (now.controls[i] !== lastControls[i]) throw e
      lastControls = now.controls
      await run()
    }
    await settle()
  }
  return {
    goto: async (url) => {
      await hide()
      // A dead link or a slow page still leaves something in the window to read.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => {
        if (!/net::|timeout/i.test(errText(e))) throw e
      })
      await settle()
    },
    snapshot: async () => {
      const got = await read()
      lastControls = got.controls
      return { url: page.url(), ...got }
    },
    click: (i) => onControl(i, () => page.click(at(i))),
    type: (i, text) =>
      onControl(i, async () => {
        await page.click(at(i), { count: 3 })
        await page.type(at(i), text)
      }),
    submit: (i) => onControl(i, () => page.click(at(i))),
    submitFor: (i) => page.evaluate(pageSubmitFor, i),
    scroll: async (dir) => {
      await hide()
      await page.evaluate(pageScroll, dir)
      await settle()
    },
    front: async () => {
      // The picture stays inside the app. This does not move the window or bring it forward.
    },
    // mouse.click is CSS pixels. A surface shot is device pixels, so this clip is the parked CSS window at scale 1.
    shot: async () => {
      await hide()
      return page.screenshot
        ? page.screenshot({
            type: 'jpeg',
            quality: 40,
            fromSurface: false,
            captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: PARKED.width, height: PARKED.height, scale: 1 }
          })
        : new Uint8Array()
    },
    closed: () => page.isClosed() || !browser.connected,
    clickAt: async (x, y) => {
      await hide()
      await page.mouse?.click(x, y)
    },
    typeText: async (text) => {
      await hide()
      await page.keyboard?.type(text)
    },
    pressKey: async (key) => {
      await hide()
      await page.keyboard?.press(key)
    },
    wheel: async (deltaY) => {
      await hide()
      await page.mouse?.wheel?.({ deltaY })
    }
  }
}

function pageTargetId(page: ChromePage): string {
  const id = page.target?.()._targetId
  return typeof id === 'string' ? id : ''
}

async function pageListed(browser: ChromeBrowser, targetId: string): Promise<ChromePage | null> {
  const pages = await browser.pages()
  return pages.find((page) => !page.isClosed() && pageTargetId(page) === targetId) ?? null
}

/** `createTarget` already opened this window. Find that target. Do not open another. */
async function pageForTarget(browser: ChromeBrowser, targetId: string): Promise<ChromePage | null> {
  const listed = await pageListed(browser, targetId)
  if (listed) return listed
  if (browser.waitForTarget) {
    try {
      const target = await browser.waitForTarget((row) => row._targetId === targetId, { timeout: 5000 })
      const page = await target.page?.()
      if (page && !page.isClosed()) return page
    } catch {
      // The target was created. A later pages() list is the backup.
    }
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const found = await pageListed(browser, targetId)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

function targetIdFrom(created: unknown): string {
  if (!created || typeof created !== 'object' || !('targetId' in created)) return ''
  const id = created.targetId
  return typeof id === 'string' ? id : ''
}

/** A new operating-system window in the Chrome that is already running. */
async function openWindow(browser: ChromeBrowser): Promise<ChromePage> {
  if (browser.newWindow) return browser.newWindow()
  const seed = (await browser.pages()).find((p) => !p.isClosed())
  if (seed?.createCDPSession) {
    let client: Awaited<ReturnType<NonNullable<ChromePage['createCDPSession']>>> | undefined
    let targetId = ''
    try {
      client = await seed.createCDPSession()
      targetId = targetIdFrom(await client.send('Target.createTarget', { url: 'about:blank', newWindow: true }))
    } catch {
      // This Chrome is still the one we have. A new page in it is the fallback when createTarget did not run.
      targetId = ''
    } finally {
      try {
        await client?.detach?.()
      } catch {
        // The session is already gone.
      }
    }
    if (targetId) {
      const page = await pageForTarget(browser, targetId)
      if (!page) throw new Error('desk chrome: created window did not attach')
      return page
    }
  }
  return browser.newPage()
}

/** The `DeskLaunch` the desk browser takes. A missing `chromePath` returns { noChrome: true } without
 * launching. One Chrome per app run. A closed window opens a page in that Chrome. Later keys open
 * new windows in it. `.windows` is how chat and Desk name those windows. */
export function makeDeskLaunch(puppeteerLaunch: PuppeteerLaunch): DeskLaunch & { windows: DeskWindows } {
  let browser: ChromeBrowser | null = null
  let starting: Promise<ChromeBrowser> | null = null
  let opts: { chromePath: string; profileDir: string } | null = null
  const byKey = new Map<string, { page: ChromePage | null; adapter: DeskPage | null }>()
  const opening = new Map<string, Promise<DeskPage | { noChrome: true }>>()
  /** A close that arrived while this key was still opening. The open does not keep the page. */
  const dropped = new Set<string>()
  /** The page `prepare` is parking, so a close during that wait can close it. */
  const preparing = new Map<string, ChromePage>()
  // Two places can open at once. Creating the windows has to be one at a time, or both
  // reads of browser.pages() see the same new window and the second address replaces the first.
  let claiming: Promise<void> = Promise.resolve()
  function claim<T>(work: () => Promise<T>): Promise<T> {
    const run = claiming.then(work, work)
    claiming = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function connect(next: { chromePath: string; profileDir: string }): Promise<ChromeBrowser | { noChrome: true }> {
    opts = next
    if (!next.chromePath || !existsSync(next.chromePath)) return { noChrome: true }
    if (browser?.connected) return browser
    if (!starting) {
      starting = puppeteerLaunch({ pipe: true, headless: false, executablePath: next.chromePath, userDataDir: next.profileDir })
        .then((got) => {
          browser = got
          byKey.clear()
          return got
        })
        .finally(() => {
          starting = null
        })
    }
    return starting
  }

  async function prepare(page: ChromePage): Promise<DeskPage> {
    await page.setViewport?.(PAGE_VIEW)
    await place(page, PARKED)
    await place(page, MINIMIZED)
    return adapterFor(browser as ChromeBrowser, page)
  }

  async function pageFor(key: string): Promise<DeskPage | { noChrome: true }> {
    const inflight = opening.get(key)
    if (inflight) return inflight
    const held = byKey.get(key)
    if (held?.page && !held.page.isClosed() && held.adapter) return held.adapter
    const isFirst = byKey.size === 0
    if (!held) byKey.set(key, { page: null, adapter: null })
    const job = (async (): Promise<DeskPage | { noChrome: true }> => {
      if (!opts) return { noChrome: true }
      const got = await connect(opts)
      if ('noChrome' in got) {
        dropped.delete(key)
        if (!byKey.get(key)?.page) byKey.delete(key)
        return got
      }
      let page: ChromePage
      try {
        page = await claim(async () => {
          const current = byKey.get(key)
          if (current?.page && !current.page.isClosed()) return current.page
          if (current?.page?.isClosed()) return got.newPage()
          if (isFirst) return (await got.pages()).find((p) => !p.isClosed()) ?? (await got.newPage())
          return openWindow(got)
        })
      } catch (error) {
        if (!byKey.get(key)?.page) byKey.delete(key)
        // A close during this failed open must not cancel the next open of the same key.
        if (!dropped.has(key)) throw error
        dropped.delete(key)
        return { noChrome: true }
      }
      if (dropped.has(key)) {
        dropped.delete(key)
        if (!page.isClosed()) await page.close?.()
        if (!byKey.get(key)?.page) byKey.delete(key)
        return { noChrome: true }
      }
      preparing.set(key, page)
      let adapter: DeskPage | null = null
      try {
        adapter = await prepare(page)
      } catch (error) {
        if (!dropped.has(key)) throw error
      } finally {
        preparing.delete(key)
      }
      if (dropped.has(key) || !adapter) {
        dropped.delete(key)
        if (!page.isClosed()) await page.close?.()
        if (!byKey.get(key)?.page) byKey.delete(key)
        return { noChrome: true }
      }
      byKey.set(key, { page, adapter })
      return adapter
    })()
    opening.set(key, job)
    try {
      return await job
    } finally {
      if (opening.get(key) === job) opening.delete(key)
    }
  }

  function peek(key: string): DeskPage | null {
    const held = byKey.get(key)
    if (!held?.page || held.page.isClosed() || !held.adapter) return null
    return held.adapter
  }

  const windows: DeskWindows = {
    connect,
    page: pageFor,
    peek,
    has: (key) => peek(key) !== null,
    async close(key) {
      if (!key || key === 'wa') return
      const inflight = opening.has(key)
      const held = byKey.get(key)
      const pending = preparing.get(key)
      if (!held && !inflight && !pending) return
      if (inflight) dropped.add(key)
      byKey.delete(key)
      const page = held?.page ?? pending
      if (page && !page.isClosed()) await page.close?.()
    },
    anyOpen: () => {
      if (!browser?.connected) return false
      for (const held of byKey.values()) if (held.page && !held.page.isClosed()) return true
      return false
    }
  }

  const launch = (async (next: { chromePath: string; profileDir: string }) => {
    const got = await connect(next)
    if ('noChrome' in got) return got
    return pageFor('page')
  }) as DeskLaunch & { windows: DeskWindows }
  launch.windows = windows
  return launch
}
