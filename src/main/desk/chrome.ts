import type { PageAdapter } from '../../shared/desk.ts'

/**
 * What a page in the browser inside Brain can do, and the functions that run inside the page.
 * The functions below run through `executeJavaScript` (desk/inapp.ts), so each uses only its arguments
 * and the page's own globals.
 */

/** The pages Brain has open, by window key. `page` creates a window. `peek` does not. */
export type DeskWindows = {
  connect: (opts: { chromePath: string; profileDir: string }) => Promise<unknown>
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
  /** True once that window was closed. */
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

/**
 * The snapshot body. It runs inside the page through `executeJavaScript`, so it uses only its arguments and
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

/** Runs in the page. The submit control of the focused field's form, named the way pageSubmitFor names it. */
export function pageActiveSubmit(): { name: string } | null {
  const field = document.activeElement as HTMLInputElement | null
  const form = field ? field.form : null
  if (!form) return null
  const sub = Array.from(form.elements).find(
    (el) => (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'))
  ) as HTMLInputElement | undefined
  if (!sub) return null
  return { name: (sub.getAttribute('aria-label') || sub.innerText || sub.value || sub.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80) }
}
