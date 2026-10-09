import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS, payCheck } from '../../shared/desk.ts'
import type { BrowseStepResult, DeskBrowser, DeskLaunch, KeyInput, PageFrame, PageSnapshot, PointerInput } from '../../shared/desk.ts'
import { addressFor } from '../../shared/browser-menu.ts'
import { isWhatsAppKey, windowKey } from '../../shared/page-picture.ts'
import type { DeskPage } from './chrome.ts'
import { startPageTurn } from './page-lane.ts'
import { messageBoxFocused, sendOnWhatsApp, WHATSAPP_BOX, WHATSAPP_URL, type WhatsAppMessage, type WhatsAppPage, type WhatsAppSent } from './wa-send.ts'

/**
 * The desk browser. Callers that omit an owner share one lock, so one browse at a time.
 * A named owner has its own lock. The same window still waits its turn. Each step returns
 * the page or a refusal. The controller writes every sentence; this file returns only results.
 */

type Step = { action: string; detail?: string; url?: string; account?: string }
type Session = {
  id: string
  owner: string
  lock: string
  page: PageSnapshot | null
  field: { index: number; control: string } | null
}

const SIGN_IN_TITLE = /\b(sign|log)[\s-]?in\b/i

/** A password field, a QR code to sign in with, or a sign-in title. */
const asksSignIn = (p: { hasPassword: boolean; qrLogin?: boolean; title: string }) => p.hasPassword || !!p.qrLogin || SIGN_IN_TITLE.test(p.title)

const KEY_NAMES = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']
const KEY_ALIASES: Record<string, string> = { return: 'Enter', esc: 'Escape', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', spacebar: 'Space' }

/** The one key name the page understands, whatever case or common alias the caller used. null for anything else. */
export function keyName(raw: string): string | null {
  const text = String(raw ?? '')
  if (text === ' ') return 'Space'
  const k = text.trim().toLowerCase()
  return KEY_NAMES.find((n) => n.toLowerCase() === k) ?? KEY_ALIASES[k] ?? null
}

/** "link Pricing" is named Pricing. A line with no kind word is all name. */
function controlName(control: string): string {
  const m = /^(link|button|field) (.*)$/.exec(control)
  return m ? m[2] : control
}

const same = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** The one control `target` names: `#3` is the third on the list, else its name or its whole line ("link Pricing"). */
function findControl(controls: string[], target: string, fieldsFirst = false): number | 'missing' | 'ambiguous' {
  const n = /^#\s*(\d+)$/.exec(target.trim())
  if (n) {
    const i = Number(n[1]) - 1
    return i >= 0 && i < controls.length ? i : 'missing'
  }
  const key = same(target)
  if (!key) return 'missing'
  let hits = controls.flatMap((c, i) => (same(controlName(c)) === key || same(c) === key ? [i] : []))
  if (fieldsFirst && hits.length > 1) {
    const fields = hits.filter((i) => controls[i].startsWith('field '))
    if (fields.length) hits = fields
  }
  if (!hits.length) return 'missing'
  return hits.length > 1 ? 'ambiguous' : hits[0]
}

/** The typed field's number on the current list. It moves when the page re-numbered. */
function fieldNow(controls: string[], field: { index: number; control: string }): number | null {
  if (controls[field.index] === field.control) return field.index
  const i = controls.indexOf(field.control)
  return i >= 0 ? i : null
}

type WindowsApi = {
  connect: (opts: { chromePath: string; profileDir: string }) => Promise<unknown>
  page: (key: string) => Promise<DeskPage | { noChrome: true }>
  peek: (key: string) => DeskPage | null
  has: (key: string) => boolean
  close: (key: string) => Promise<void>
  anyOpen: () => boolean
}

function windowsOf(launch: DeskLaunch): WindowsApi | null {
  const windows = (launch as DeskLaunch & { windows?: Partial<WindowsApi> }).windows
  if (typeof windows?.page !== 'function' || typeof windows.connect !== 'function') return null
  return windows as WindowsApi
}

function isNoChrome(v: unknown): v is { noChrome: true } {
  return !!v && typeof v === 'object' && (v as { noChrome?: boolean }).noChrome === true
}

export function createDeskBrowser(opts: { launch: DeskLaunch; chromePath: string; profileDir: string }): DeskBrowser {
  const { launch, chromePath, profileDir } = opts
  let adapter: DeskPage | null = null
  let launching: ReturnType<DeskLaunch> | null = null
  let signedOut: { id: string; result: BrowseStepResult } | null = null
  const cancelled = new Set<string>()
  const showing = new Map<string, string>()
  const sessions = new Map<string, Session>()
  const locks = new Map<string, { holder: string | null; waiters: { id: string; go: () => void }[] }>()

  function lockFor(name: string) {
    let lock = locks.get(name)
    if (!lock) {
      lock = { holder: null, waiters: [] }
      locks.set(name, lock)
    }
    return lock
  }

  function lockName(owner?: string) {
    return owner ? `owner:${owner}` : 'desk'
  }

  const wins = () => windowsOf(launch)
  const windowOpen = () => {
    const w = wins()
    if (w) return w.anyOpen()
    return !!adapter && !adapter.closed?.()
  }

  /** The one page, when this launch has no window map. A window the person closed launches again. */
  async function chrome(): Promise<DeskPage | { noChrome: true }> {
    if (adapter && !adapter.closed?.()) return adapter
    launching ??= launch({ chromePath, profileDir }).finally(() => {
      launching = null
    })
    const got = await launching
    if ('noChrome' in got) return got
    adapter = got
    return got
  }

  /** Ends that lock's session and hands it to the next bot in line. */
  function handOn(name: string) {
    const lock = lockFor(name)
    if (lock.holder) sessions.delete(lock.holder)
    lock.holder = null
    const next = lock.waiters.shift()
    if (!next) return
    lock.holder = next.id
    next.go()
  }

  function dropWaiter(name: string, browseId: string) {
    const lock = lockFor(name)
    const i = lock.waiters.findIndex((w) => w.id === browseId)
    if (i >= 0) lock.waiters.splice(i, 1)[0].go()
  }

  function lockHolding(browseId: string): string | null {
    for (const [name, lock] of locks) {
      if (lock.holder === browseId || lock.waiters.some((w) => w.id === browseId)) return name
    }
    return sessions.get(browseId)?.lock ?? null
  }

  async function open(browseId: string, owner?: string): Promise<void | { noChrome: true }> {
    const name = lockName(owner)
    const lock = lockFor(name)
    if (cancelled.has(browseId) || lock.holder === browseId) return
    if (lock.holder !== null) {
      await new Promise<void>((go) => lock.waiters.push({ id: browseId, go }))
      if (lock.holder !== browseId) return
    } else {
      lock.holder = browseId
    }
    const w = wins()
    let got: DeskPage | { noChrome: true } | null = null
    try {
      if (w) {
        const connected = await w.connect({ chromePath, profileDir })
        if (isNoChrome(connected)) got = { noChrome: true }
      } else {
        got = await chrome()
      }
    } catch (e) {
      if (lock.holder === browseId) handOn(name)
      throw e
    }
    // Released or cancelled while Chrome was starting: the lock moves on.
    if (lock.holder !== browseId) return
    if (cancelled.has(browseId) || (got && 'noChrome' in got)) {
      handOn(name)
      return got && 'noChrome' in got ? got : undefined
    }
    sessions.set(browseId, { id: browseId, owner: owner ?? '', lock: name, page: null, field: null })
  }

  function cancel(browseId: string) {
    cancelled.add(browseId)
    const name = lockHolding(browseId) ?? 'desk'
    dropWaiter(name, browseId)
    // While Chrome is still starting, open sees the mark and lets go itself.
    if (lockFor(name).holder === browseId && sessions.has(browseId)) handOn(name)
  }

  function release(browseId: string) {
    const name = sessions.get(browseId)?.lock ?? lockHolding(browseId) ?? 'desk'
    if (lockFor(name).holder === browseId) handOn(name)
    else dropWaiter(name, browseId)
  }

  function focus() {
    // The corner picture lives in the Desk window. This must not launch Chrome or bring it forward.
  }

  function showWindow() {
    if (adapter && windowOpen()) void adapter.front?.().catch(() => {})
  }

  function shown(owner?: string): DeskPage | null {
    const w = wins()
    if (!w) return adapter && !adapter.closed?.() ? adapter : null
    if (!owner) return null
    const key = showing.get(owner)
    if (!key || !w.has(key)) return null
    return w.peek(key)
  }

  async function picture(owner?: string): Promise<string | null> {
    const a = wins() ? shown(owner) : adapter && windowOpen() ? adapter : null
    if (!a?.shot) return null
    try {
      const bytes = await a.shot()
      if (!bytes?.byteLength) return null
      return Buffer.from(bytes).toString('base64')
    } catch {
      return null
    }
  }

  /** Reads the page after a step. A sign-in page ends the session; the window stays open. */
  async function read(a: DeskPage, s: Session | null): Promise<BrowseStepResult> {
    const p = await a.snapshot()
    if (asksSignIn(p)) {
      const result: BrowseStepResult = { signIn: true, url: p.url, title: p.title }
      if (s && lockFor(s.lock).holder === s.id) {
        signedOut = { id: s.id, result }
        handOn(s.lock)
      }
      return result
    }
    const text = p.text.slice(0, BROWSE_TEXT_CHARS)
    const controls = p.controls.slice(0, BROWSE_MAX_CONTROLS)
    if (s) s.page = { ...p, text, controls }
    return { ok: true, url: p.url, title: p.title, text, controls }
  }

  /** The pay check runs on the control's name before anything is clicked or pressed. */
  function payStop(name: string, url: string): BrowseStepResult | null {
    const pay = payCheck(name)
    if (pay === 'hold') return { hold: 'spend', name, url }
    if (pay === 'refuse') return { refused: 'pay', name, url }
    return null
  }

  async function heldPage(): Promise<DeskPage | { noChrome: true } | null> {
    if (!adapter || adapter.closed?.()) return null
    return adapter
  }

  async function goTo(url: string, owner?: string) {
    const w = wins()
    const key = w ? windowKey(owner || 'page', url) : 'page'
    const turn = startPageTurn(key)
    try {
      await turn.promise
      if (w) {
        const connected = await w.connect({ chromePath, profileDir })
        if (isNoChrome(connected)) return
        const a = await w.page(key)
        // A close during the open wins. Do not point this place at a window that was not kept.
        if ('noChrome' in a || !w.has(key)) return
        if (owner) {
          showing.set(owner, key)
          rewatch(owner)
        }
        await a.goto(url)
        return
      }
      const a = await chrome()
      if ('noChrome' in a) return
      await a.goto(url)
    } finally {
      turn.release()
    }
  }

  async function onShown(owner: string | undefined, run: (a: DeskPage) => Promise<void>) {
    const w = wins()
    const key = w ? (owner ? showing.get(owner) || owner : 'page') : 'page'
    const turn = startPageTurn(key)
    try {
      await turn.promise
      // The page is the one this lane waited on. A later goTo can change `showing` on another lane.
      const a = w ? w.peek(key) : await heldPage()
      if (!a || 'noChrome' in a) return
      await run(a)
    } finally {
      turn.release()
    }
  }

  type Watcher = { send: (frame: PageFrame) => void; key: string | null; stop: (() => void) | null }
  const watchers = new Map<string, Set<Watcher>>()

  /** Points every watcher of this place at the window it shows now. A watcher already on that window stays. */
  function rewatch(owner: string) {
    const rows = watchers.get(owner)
    if (!rows) return
    const w = wins()
    const key = w ? showing.get(owner) ?? null : 'page'
    for (const row of rows) {
      if (row.key === key && row.stop) continue
      row.stop?.()
      row.stop = null
      row.key = key
      const page = !key ? null : w ? w.peek(key) : adapter && windowOpen() ? adapter : null
      if (page?.watch) row.stop = page.watch(row.send)
    }
  }

  function watch(owner: string, send: (frame: PageFrame) => void) {
    const row: Watcher = { send, key: null, stop: null }
    const rows = watchers.get(owner) ?? new Set<Watcher>()
    rows.add(row)
    watchers.set(owner, rows)
    rewatch(owner)
    return () => {
      row.stop?.()
      row.stop = null
      rows.delete(row)
      if (!rows.size && watchers.get(owner) === rows) watchers.delete(owner)
    }
  }

  function pointer(owner: string, ev: PointerInput) {
    return onShown(owner, (a) => a.pointer?.(ev) ?? Promise.resolve())
  }

  function keyInput(owner: string, ev: KeyInput) {
    return onShown(owner, (a) => a.key?.(ev) ?? Promise.resolve())
  }

  function clickAt(x: number, y: number, owner?: string) {
    return onShown(owner, (a) => a.clickAt?.(x, y) ?? Promise.resolve())
  }

  function typeText(text: string, owner?: string) {
    return onShown(owner, (a) => a.typeText?.(text) ?? Promise.resolve())
  }

  function pressKey(key: string, owner?: string) {
    return onShown(owner, (a) => a.pressKey?.(key) ?? Promise.resolve())
  }

  function wheel(deltaY: number, owner?: string) {
    return onShown(owner, (a) => a.wheel?.(deltaY) ?? Promise.resolve())
  }

  async function look(owner?: string): Promise<{ signIn: boolean } | null> {
    const a = wins() ? shown(owner) : await heldPage()
    if (!a || 'noChrome' in a) return null
    try {
      const p = await a.snapshot()
      return { signIn: asksSignIn(p) }
    } catch {
      return { signIn: false }
    }
  }

  async function stepAdapter(s: Session, url?: string, account?: string): Promise<DeskPage | { noChrome: true }> {
    const w = wins()
    if (!w) return chrome()
    const owner = s.owner || 'desk'
    const key = url ? windowKey(owner, url, account) : showing.get(owner) || owner
    if (url) showing.set(owner, key)
    const connected = await w.connect({ chromePath, profileDir })
    if (isNoChrome(connected)) return { noChrome: true }
    const page = await w.page(key)
    rewatch(owner)
    return page
  }

  function sessionNow(owner?: string): Session | null {
    if (owner) return [...sessions.values()].find((row) => row.owner === owner) ?? null
    return [...sessions.values()].find((row) => row.lock === 'desk' && lockFor('desk').holder === row.id) ?? null
  }

  async function runStep(browseId: string, step: Step): Promise<BrowseStepResult> {
    const action = step.action.toLowerCase()
    const detail = (step.detail ?? '').trim()
    const mutates = action === 'url' || action === 'click' || action === 'type' || action === 'press' || action === 'key' || action === 'scroll'
    const s0 = sessions.get(browseId)
    const urlForKey = action === 'url' ? (step.url ?? detail).trim() : undefined
    const key = wins()
      ? urlForKey
        ? windowKey(s0?.owner || 'desk', urlForKey, step.account)
        : showing.get(s0?.owner || '') || s0?.owner || 'desk'
      : 'page'
    const onWhatsApp = isWhatsAppKey(key)
    const turn = mutates ? startPageTurn(key) : null
    try {
      if (turn) await turn.promise
      if (signedOut?.id === browseId) return signedOut.result
      const s = sessions.get(browseId)
      // The controller posts no-page before it gets here. This is a wiring bug, not a sentence.
      if (!s || s.id !== browseId) throw new Error(`desk browser: runStep for ${browseId} without an open session`)
      const a = await stepAdapter(s, action === 'url' ? urlForKey : undefined, step.account)
      if ('noChrome' in a) return a
      if (action === 'read') return read(a, s)

    if (action === 'url') {
      const url = (step.url ?? detail).trim()
      if (!/^https?:\/\//i.test(url)) return { refused: 'missing', name: url, url: s.page?.url ?? '' }
      s.field = null
      await a.goto(url)
      return read(a, s)
    }
    if (!s.page) throw new Error(`desk browser: ${action} for ${browseId} before its url step`)
    const { controls, url } = s.page

    if (action === 'click') {
      const hit = findControl(controls, detail)
      if (typeof hit !== 'number') return { refused: hit, name: detail, url }
      const name = controlName(controls[hit])
      const stop = payStop(name, url)
      if (stop) return stop
      await a.click(hit)
      return read(a, s)
    }
    if (action === 'type') {
      const bar = detail.indexOf('|')
      const target = bar < 0 ? detail : detail.slice(0, bar).trim()
      const hit = findControl(controls, target, true)
      if (typeof hit !== 'number') return { refused: hit, name: target, url }
      // Typing clicks the control first. Only a field takes text; a button named here is not clicked.
      if (!controls[hit].startsWith('field ')) return payStop(controlName(controls[hit]), url) ?? { refused: 'missing', name: target, url }
      await a.type(hit, bar < 0 ? '' : detail.slice(bar + 1).trim())
      s.field = { index: hit, control: controls[hit] }
      return read(a, s)
    }
    if (action === 'press') {
      const field = s.field && fieldNow(controls, s.field)
      const sub = typeof field === 'number' ? await a.submitFor(field) : null
      if (!sub) return { refused: 'no-submit', url }
      const stop = payStop(sub.name, url)
      if (stop) return stop
      await a.submit(sub.index)
      return read(a, s)
    }
    if (action === 'key') {
      const key = keyName(detail)
      if (!key || !a.pressKey) return { refused: 'missing', name: detail, url }
      // Enter in WhatsApp's message box sends the message. Only the Send card does that.
      if (key === 'Enter' && onWhatsApp && (await a.run?.<boolean>(messageBoxFocused))) return { refused: 'pay', name: WHATSAPP_BOX, url }
      // Enter and Space press the focused control, and Enter in a form submits it. Both get a click's pay check.
      if (key === 'Enter' || key === 'Space') {
        const names = await a.activeNames?.()
        for (const name of [names?.own, key === 'Enter' ? names?.submit : '']) {
          const stop = name ? payStop(name, url) : null
          if (stop) return stop
        }
      }
      await a.pressKey(key)
      return read(a, s)
    }
    if (action === 'scroll') {
      await a.scroll(detail.toLowerCase() === 'up' ? 'up' : 'down')
      return read(a, s)
    }
    return { refused: 'missing', name: detail, url }
    } finally {
      turn?.release()
    }
  }

  /** Approve on a browser hold: one click on `name`, only on `pageUrl`. With the window closed it
   * reopens `pageUrl` in the desk profile first. The person already said yes, so no pay check. */
  async function clickApproved(name: string, pageUrl: string, owner?: string): Promise<BrowseStepResult> {
    const w = wins()
    // A hold on a WhatsApp page was raised on the account this place shows.
    const shownKey = owner ? showing.get(owner) : undefined
    const account = shownKey && isWhatsAppKey(shownKey) ? shownKey.slice(3) : ''
    const key = w ? windowKey(owner || 'page', pageUrl, account) : 'page'
    const turn = startPageTurn(key)
    try {
      await turn.promise
      let a: DeskPage | { noChrome: true }
      if (w && owner) {
        const connected = await w.connect({ chromePath, profileDir })
        if (isNoChrome(connected)) return { noChrome: true }
        const had = w.has(key)
        a = await w.page(key)
        if ('noChrome' in a || !w.has(key)) return { noChrome: true }
        showing.set(owner, key)
        rewatch(owner)
        if (!had) await a.goto(pageUrl)
      } else {
        const wasOpen = windowOpen()
        a = await chrome()
        if ('noChrome' in a) return a
        if (!wasOpen) await a.goto(pageUrl)
      }
      const p = await a.snapshot()
      if (p.url !== pageUrl) return { refused: 'page-changed', url: p.url }
      if (asksSignIn(p)) return { signIn: true, url: p.url, title: p.title }
      const hit = findControl(p.controls, name)
      if (typeof hit !== 'number') return { refused: hit, name, url: p.url }
      await a.click(hit)
      return read(a, sessionNow(owner))
    } finally {
      turn.release()
    }
  }

  /** Back, Forward or Reload on the page this place shows, in that window's lane. A WhatsApp window is shared: no Back or Forward. */
  async function nav(owner: string, action: 'back' | 'forward' | 'reload'): Promise<boolean> {
    const key = showing.get(owner)
    if (!key || (isWhatsAppKey(key) && action !== 'reload')) return false
    let done = false
    await onShown(owner, async (a) => {
      if (!a.nav) return
      await a.nav(action)
      done = true
    })
    return done
  }

  /** What the address field opens for this place: http(s) only, through the same path as a bare address. */
  async function go(owner: string, text: string): Promise<boolean> {
    const url = addressFor(text)
    if (!url) return false
    await goTo(url, owner)
    return true
  }

  /** Where this place's page is, for the address field and the Back and Forward buttons. */
  function facts(owner: string): { url: string; canGoBack: boolean; canGoForward: boolean; shared: boolean } | null {
    const key = showing.get(owner)
    const a = key ? wins()?.peek(key) : null
    const f = a?.facts?.()
    if (!key || !f) return null
    const shared = isWhatsAppKey(key)
    return { url: f.url, canGoBack: !shared && f.canGoBack, canGoForward: !shared && f.canGoForward, shared }
  }

  /** The page this place shows, as a PDF, in that window's lane. */
  async function printPage(owner: string): Promise<{ pdf: Buffer; title: string } | null> {
    let out: { pdf: Buffer; title: string } | null = null
    await onShown(owner, async (a) => {
      if (a.printPdf) out = await a.printPdf()
    })
    return out
  }

  /** Every place whose picture is showing that window. */
  function ownersShowing(key: string): string[] {
    return [...showing].filter(([, k]) => k === key).map(([o]) => o)
  }

  /** One message through that account's WhatsApp window. The window's lane is held for the whole send. */
  async function whatsappSend(msg: WhatsAppMessage): Promise<WhatsAppSent> {
    const w = wins()
    if (!w) return { ok: false, note: "Brain's browser is not available. Nothing was sent." }
    const key = windowKey('page', WHATSAPP_URL, msg.account)
    const turn = startPageTurn(key)
    try {
      await turn.promise
      const connected = await w.connect({ chromePath, profileDir })
      if (isNoChrome(connected)) return { ok: false, note: "Brain's browser is not available. Nothing was sent." }
      const a = await w.page(key)
      if ('noChrome' in a || !a.run || !a.url || !a.clickAt || !a.typeText || !a.key || !a.pressKey) return { ok: false, note: "Brain's browser is not available. Nothing was sent." }
      return await sendOnWhatsApp(a as DeskPage & WhatsAppPage, msg)
    } catch (e) {
      return { ok: false, note: `Sending stopped: ${String((e as Error)?.message || e)}. Check the chat before sending again.` }
    } finally {
      turn.release()
    }
  }

  async function closeOwner(owner: string) {
    const w = wins()
    showing.delete(owner)
    rewatch(owner)
    if (!w || !owner || isWhatsAppKey(owner)) return
    // `has` is false while the page is still being opened. The close still has to win.
    await w.close(owner)
  }

  return { open, cancel, release, focus, showWindow, picture, windowOpen, clickApproved, runStep, goTo, clickAt, typeText, pressKey, wheel, look, closeOwner, pointer, keyInput, watch, whatsappSend, nav, go, facts, printPage, ownersShowing }
}
