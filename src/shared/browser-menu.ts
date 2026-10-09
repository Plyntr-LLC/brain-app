/**
 * The browser picture's controls, as plain functions: what the address field opens, what a printed page is
 * called, and what the right-click menu offers. Main builds the native menu and acts; these only decide.
 */

const WEB = /^https?:$/i

/** What Enter in the address field opens: an http(s) address, a bare domain as https, anything else as a search. null opens nothing. */
export function addressFor(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const search = `https://www.google.com/search?q=${encodeURIComponent(text)}`
  // Words with spaces are a search, colon or not ("Re: meeting notes").
  if (/\s/.test(text)) return search
  const href = (url: string) => {
    try {
      return new URL(url).href
    } catch {
      return null
    }
  }
  // This computer and bare IP addresses, with or without a port: plain http, the way dev servers answer.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(text)) return href(`http://${text}`)
  if (/^[^\s/:?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return href(`https://${text}`)
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const u = href(text)
    return u && WEB.test(new URL(u).protocol) ? u : null
  }
  return search
}

/** Where any Brain window may go: web pages, an empty page, or a page's own blob. Never a file or another app's link. */
export function navAllowed(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' || p === 'blob:'
  } catch {
    return false
  }
}

/** The PDF a printed page saves as: its title made safe for a file name, `Page` when nothing is left. */
export function pdfName(title: string): string {
  const safe = String(title ?? '')
    .replace(/[/\\:\u0000-\u001f\u007f]/g, '-')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim()
  return `${safe || 'Page'}.pdf`
}

/** A link or page the system's own browser may open: web pages and mail only. */
export function opensOutside(url: string): boolean {
  try {
    return /^(https?|mailto):$/i.test(new URL(url).protocol)
  } catch {
    return false
  }
}

export type MenuAction = 'back' | 'forward' | 'reload' | 'copyLink' | 'openLink' | 'copy' | 'cut' | 'paste' | 'selectAll' | 'copyImage' | 'print' | 'openPage' | 'forget'
export type MenuEntry = { action: MenuAction; label: string } | { separator: true }

/**
 * The right-click menu for what was under the mouse. `shared` is a WhatsApp window: no Back or Forward there.
 * `remembered` is a camera or microphone Allow this site has in this login, which the menu can forget.
 */
export function menuFor(
  at: { linkURL?: string; selectionText?: string; isEditable?: boolean; mediaType?: string; srcURL?: string; pageURL?: string },
  page: { canGoBack: boolean; canGoForward: boolean; shared: boolean; remembered?: boolean }
): MenuEntry[] {
  const out: MenuEntry[] = []
  const add = (action: MenuAction, label: string) => out.push({ action, label })
  const gap = () => {
    if (out.length && !('separator' in out[out.length - 1])) out.push({ separator: true })
  }
  if (!page.shared && page.canGoBack) add('back', 'Back')
  if (!page.shared && page.canGoForward) add('forward', 'Forward')
  add('reload', 'Reload')
  if (at.linkURL) {
    gap()
    add('copyLink', 'Copy link address')
    if (opensOutside(at.linkURL)) add('openLink', 'Open link in your browser')
  }
  if (at.isEditable) {
    gap()
    add('cut', 'Cut')
    add('copy', 'Copy')
    add('paste', 'Paste')
    add('selectAll', 'Select all')
  } else if (at.selectionText) {
    gap()
    add('copy', 'Copy')
  }
  if (at.mediaType === 'image' && at.srcURL) {
    gap()
    add('copyImage', 'Copy image address')
  }
  gap()
  add('print', 'Print to PDF')
  if (at.pageURL && opensOutside(at.pageURL)) add('openPage', 'Open page in your browser')
  if (page.remembered) {
    gap()
    add('forget', "Forget this site's permissions")
  }
  return out
}
