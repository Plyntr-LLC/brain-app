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
  screenshot?: (options: { type: 'jpeg'; quality: number }) => Promise<Uint8Array>
  isClosed: () => boolean
  setViewport?: (viewport: null) => Promise<void>
  waitForNetworkIdle?: (options: { idleTime: number; timeout: number }) => Promise<void>
}

export type ChromeBrowser = {
  pages: () => Promise<ChromePage[]>
  newPage: () => Promise<ChromePage>
  readonly connected: boolean
}

/** Exactly these four options. No `connect`, no debugging port. */
export type ChromeLaunchOptions = { pipe: true; headless: false; executablePath: string; userDataDir: string }
export type PuppeteerLaunch = (options: ChromeLaunchOptions) => Promise<ChromeBrowser>

/** What the adapter adds beyond `PageAdapter`. Optional so a test adapter can leave them out. */
export type DeskPage = PageAdapter & {
  /** Brings the desk Chrome window forward. Sign-in uses this. Ordinary focus does not. */
  front?: () => Promise<void>
  /** A jpeg of the open page, for the corner picture. Empty when the page cannot take one. */
  shot?: () => Promise<Uint8Array>
  /** True once the person closed the desk window or quit that Chrome. */
  closed?: () => boolean
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
  // A page that re-rendered since the last look has lost its marks. Mark it again and retry once,
  // only when that number still names the same control.
  const onControl = async (i: number, run: () => Promise<void>) => {
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
      await page.evaluate(pageScroll, dir)
      await settle()
    },
    front: () => page.bringToFront(),
    shot: async () => (page.screenshot ? page.screenshot({ type: 'jpeg', quality: 40 }) : new Uint8Array()),
    closed: () => page.isClosed() || !browser.connected
  }
}

/** The `DeskLaunch` the desk browser takes. A missing `chromePath` returns { noChrome: true } without
 * launching. One Chrome per app run: when the person closed the window but that Chrome still runs,
 * the next launch opens a page in it instead of starting a second Chrome on the same profile. */
export function makeDeskLaunch(puppeteerLaunch: PuppeteerLaunch): DeskLaunch {
  let browser: ChromeBrowser | null = null
  return async ({ chromePath, profileDir }) => {
    if (!chromePath || !existsSync(chromePath)) return { noChrome: true }
    if (!browser || !browser.connected) {
      browser = await puppeteerLaunch({ pipe: true, headless: false, executablePath: chromePath, userDataDir: profileDir })
    }
    const page = (await browser.pages()).find((p) => !p.isClosed()) ?? (await browser.newPage())
    // Let the page fill the window instead of puppeteer's 800×600.
    await page.setViewport?.(null)
    return adapterFor(browser, page)
  }
}
