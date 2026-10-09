import {
  app,
  BaseWindow,
  ipcMain,
  WebContentsView,
  session,
  webContents as allContents,
  type ContextMenuParams,
  type HandlerDetails,
  type Session,
  type WebContents,
  type WebFrameMain,
  type WindowOpenHandlerResponse
} from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS } from '../../shared/desk.ts'
import type { DeskLaunch, KeyInput, PageFrame, PointerInput } from '../../shared/desk.ts'
import { navAllowed } from '../../shared/browser-menu.ts'
import { originOf, usesAsked, type SiteUse } from '../../shared/site-permissions.ts'
import { pageActiveNames, pageScroll, pageSnapshot, pageSubmitFor, type DeskPage, type DeskWindows } from './chrome.ts'
import { isWhatsAppKey, whatsappPartition } from '../../shared/page-picture.ts'

/**
 * The browser inside Brain. Each window is a hidden BaseWindow holding one offscreen WebContentsView,
 * so nothing shows on screen and Brain's BrowserWindow.getAllWindows() never lists it.
 * Every window shares one saved partition, so a login made in one chat is there for every chat and Desk bot.
 * A WhatsApp account other than main has its own, so each number keeps its own login.
 */

export const BROWSER_PARTITION = 'persist:brain-browser'
export const VIEW = { width: 1100, height: 800 }
const STEP_MS = 15_000
const FRAME_MS = 66
/** Pop-ups one window can have open on top of it. A page asking for more opens nothing. */
export const MAX_POPUPS = 3
/** A page may open a new window only this soon after Brain sent it a click or key (Chromium's own user-activation window). */
export const OPEN_AFTER_INPUT_MS = 5_000
/** A closed window's key stays known this long, so a download it started on its way out still reaches its owners. */
const KEY_GRACE_MS = 60_000
/** The biggest iframe document a page's print() may hand Brain, kept under Chromium's 2 MB address limit once base64. */
const MAX_PRINT_HTML = 1_400_000
const EDIT_COMMANDS = new Set(['selectAll', 'copy', 'paste', 'cut', 'undo', 'redo'])
/** macOS text chords the offscreen page only performs as editing commands. Key: CDP modifiers (Alt 1, Meta 4, Shift 8) and key. */
const MAC_CHORDS: Record<string, string> = {
  '4:ArrowLeft': 'moveToBeginningOfLine',
  '12:ArrowLeft': 'moveToBeginningOfLineAndModifySelection',
  '4:ArrowRight': 'moveToEndOfLine',
  '12:ArrowRight': 'moveToEndOfLineAndModifySelection',
  '4:ArrowUp': 'moveToBeginningOfDocument',
  '12:ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  '4:ArrowDown': 'moveToEndOfDocument',
  '12:ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  '1:ArrowLeft': 'moveWordLeft',
  '9:ArrowLeft': 'moveWordLeftAndModifySelection',
  '1:ArrowRight': 'moveWordRight',
  '9:ArrowRight': 'moveWordRightAndModifySelection',
  '8:ArrowLeft': 'moveLeftAndModifySelection',
  '8:ArrowRight': 'moveRightAndModifySelection',
  '4:Backspace': 'deleteToBeginningOfLine',
  '1:Backspace': 'deleteWordBackward',
  '4:Delete': 'deleteToEndOfLine',
  '1:Delete': 'deleteWordForward'
}
const LOAD_MS = 30_000

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' }
}

function chromeAgent(): string {
  const major = process.versions.chrome.split('.')[0]
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** What a page asked of the person. browser-ui.ts answers; this file only reports, with the window's key. */
export type PageAsk =
  | { kind: 'file'; key: string; wc: WebContents; wcId: number; multiple: boolean; put: (files: string[]) => Promise<void> }
  | { kind: 'menu'; key: string; wc: WebContents; page: DeskPage; params: ContextMenuParams }
  /** `make` is the page itself, or for an iframe's print() that iframe's document. */
  | { kind: 'print'; key: string; wc: WebContents; page: DeskPage; make: () => Promise<{ pdf: Buffer; title: string }> }
  | { kind: 'download'; key: string; name: string; path: string; state: 'completed' | 'interrupted' | 'cancelled' }
  /** Camera, microphone or clipboard read, from the window's own top-level site. `answer` is called once. */
  | { kind: 'site'; key: string; wc: WebContents; page: DeskPage; partition: string; site: string; uses: SiteUse[]; answer: (yes: boolean) => void }
  /** A passkey request the page guard holds. `reply` with a card id lets it go ahead; null refuses it. */
  | { kind: 'passkey'; key: string; wc: WebContents; page: DeskPage; frame: WebFrameMain; site: string; use: 'get' | 'create'; reply: (id: string | null) => void }
  | { kind: 'passkey-done'; key: string; id: string }
  /** More than one Brain passkey fits. `pick` is called once: an account's credential id, or nothing to cancel. */
  | { kind: 'account'; key: string; wc: WebContents; page: DeskPage; site: string; accounts: { id: string; name: string }[]; pick: (id?: string) => void }
export const pageAsks = new EventEmitter<{ ask: [PageAsk] }>()
/** The key of the window each page lives in, for asks that arrive from the session (downloads). */
const keyOfPage = new Map<number, string>()
/** Each Brain page's adapter and login, by its webContents id, for asks that arrive from the page guard or the session. */
const pageOfWc = new Map<number, DeskPage>()
const partitionOfWc = new Map<number, string>()
/** When Brain last sent each window a click or key. Pop-ups need one in the last few seconds. */
const lastInput = new Map<number, number>()

/** Whether a remembered camera or microphone Allow applies now. browser-ui.ts sets it; until then nothing is granted. */
let siteCheck: (q: { partition: string; wc: WebContents; page: DeskPage | undefined; site: string; use: SiteUse }) => boolean = () => false
export function setSiteCheck(fn: typeof siteCheck): void {
  siteCheck = fn
}

/** The Brain page in this webContents, if Brain holds it, with its login (partition). */
export function heldPageOf(wc: WebContents): { key: string; page: DeskPage; partition: string } | null {
  const key = keyOfPage.get(wc.id)
  const page = pageOfWc.get(wc.id)
  return key && page ? { key, page, partition: partitionOfWc.get(wc.id) ?? BROWSER_PARTITION } : null
}

let guardFile = ''
/** Where the page guard is (src/preload/page-guard.cjs, or the packed copy in Resources). Checks point it at their own. */
export function setPageGuardFile(path: string): void {
  guardFile = path
}
function pageGuardFile(): string {
  if (guardFile) return guardFile
  if (app.isPackaged) return join(process.resourcesPath, 'page-guard.cjs')
  // A dev run starts from the repo; a check script names the repo's copy, since its own app path is a bundle folder.
  return process.env.BRAIN_PAGE_GUARD || join(app.getAppPath(), 'src/preload/page-guard.cjs')
}

/** Every Brain page's settings: hidden, offscreen, sandboxed, and the page guard in each frame too. */
function pagePrefs(partition: string) {
  return { offscreen: true, partition, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true }
}

export function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext) || 'download'
  let file = join(dir, `${stem}${ext}`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem} (${n})${ext}`)
  return file
}

const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])
/**
 * The second print layer. The page guard (a preload) misses a frame the page's HTML brings when the very next script
 * prints it; the debugger's new-document script reaches that frame. It turns print() into a console line Brain reads.
 */
const PRINT_MARK = '__brain_print__'
const PRINT_FALLBACK = `(function () { var say = console.debug.bind(console); window.print = function () { try { say(${JSON.stringify(PRINT_MARK)}) } catch (e) {} } })()`
const prepared = new Map<string, Session>()

function browserSession(partition: string): Session {
  const have = prepared.get(partition)
  if (have) return have
  const ses = session.fromPartition(partition)
  ses.setUserAgent(chromeAgent())
  const guard = pageGuardFile()
  if (existsSync(guard)) ses.registerPreloadScript({ type: 'frame', filePath: guard })
  listenToGuards()
  // Only the window's own top-level site may ask, and only for what browser-ui.ts can put to a person.
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    if (ALLOWED.has(permission)) return done(true)
    const uses = usesAsked(permission, (details as { mediaTypes?: string[] }).mediaTypes)
    const held = wc ? heldPageOf(wc) : null
    const site = wc ? originOf(wc.getURL()) : null
    if (!uses || !held || !site || originOf(details.requestingUrl || '') !== site || !pageAsks.listenerCount('ask')) return done(false)
    let answered = false
    const gone = () => answer(false)
    const answer = (yes: boolean) => {
      if (answered) return
      answered = true
      if (!wc.isDestroyed()) wc.off('destroyed', gone)
      done(yes)
    }
    wc.once('destroyed', gone)
    pageAsks.emit('ask', { kind: 'site', key: held.key, wc, page: held.page, partition, site, uses, answer })
  })
  // Synchronous: granted only for a remembered camera or microphone Allow that applies right now (siteCheck).
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (ALLOWED.has(permission)) return true
    if (!wc || permission !== 'media') return false
    const media = (details as { mediaType?: string }).mediaType
    const use: SiteUse | null = media === 'video' ? 'camera' : media === 'audio' ? 'microphone' : null
    const site = originOf(wc.getURL())
    if (!use || !site || originOf(origin) !== site) return false
    return siteCheck({ partition, wc, page: pageOfWc.get(wc.id), site, use })
  })
  // More than one Brain passkey fits this site: the person picks. Every path calls back exactly once.
  ses.on('select-webauthn-account', (event, details, callback) => {
    event.preventDefault()
    let called = false
    const pick = (id?: string) => {
      if (called) return
      called = true
      callback(id)
    }
    const wc = details.frame ? allContents.fromFrame(details.frame) : undefined
    const held = wc ? heldPageOf(wc) : null
    const site = wc ? originOf(wc.getURL()) : null
    if (!wc || !held || !site || !pageAsks.listenerCount('ask')) return pick()
    const accounts = details.accounts.map((a) => ({ id: a.credentialId, name: a.displayName || a.name || 'Unnamed account' }))
    pageAsks.emit('ask', { kind: 'account', key: held.key, wc, page: held.page, site, accounts, pick })
  })
  ses.on('will-download', (_e, item, from) => {
    const path = freePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(path)
    const key = from ? keyOfPage.get(from.id) : undefined
    // A download that breaks off reports 'interrupted' as an update and stays resumable; it never reaches done.
    let told = false
    const tell = (state: 'completed' | 'interrupted' | 'cancelled') => {
      if (told || !key) return
      told = true
      pageAsks.emit('ask', { kind: 'download', key, name: basename(path), path, state })
    }
    item.on('updated', (_d, state) => {
      if (state === 'interrupted') tell('interrupted')
    })
    item.once('done', (_d, state) => tell(state))
  })
  prepared.set(partition, ses)
  return ses
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Runs one of chrome.ts's in-page functions. They use only their arguments and the page's globals. */
function inPage<T>(wc: WebContents, fn: (...args: any[]) => unknown, ...args: unknown[]): Promise<T> {
  const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
  return within(wc.executeJavaScript(call, true) as Promise<T>, STEP_MS, 'The page')
}

const errText = (e: unknown) => String((e as Error)?.message ?? e)

/**
 * An iframe's document as a PDF, drawn in a scratch window with scripts off, in the same login so its pictures load.
 * It is a data: page, so it can reach the web (through `base`) but never a file on this Mac.
 */
async function htmlPdf(partition: string, html: string, base: string, title: string): Promise<{ pdf: Buffer; title: string }> {
  const href = /^https?:\/\//i.test(base) ? base : ''
  const tag = href ? `<base href="${href.replace(/"/g, '&quot;')}">` : ''
  const doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html
  const host = new BaseWindow({ show: false, width: VIEW.width, height: VIEW.height, skipTaskbar: true })
  const view = new WebContentsView({ webPreferences: { offscreen: true, partition, javascript: false, sandbox: true, contextIsolation: true } })
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...VIEW })
  try {
    await within(view.webContents.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(doc).toString('base64')}`), LOAD_MS, 'The printout')
    const pdf = Buffer.from(await within(view.webContents.printToPDF({ printBackground: true }), STEP_MS, 'The printout'))
    return { pdf, title: view.webContents.getTitle() && !/^data:/.test(view.webContents.getTitle()) ? view.webContents.getTitle() : title }
  } finally {
    host.destroy()
  }
}

let guardsHeard = false
/** The page guard's three messages. Each is matched to its window by the sender; a sender Brain does not hold is ignored. */
function listenToGuards() {
  if (guardsHeard) return
  guardsHeard = true
  ipcMain.on('page-guard:print', (e, html: unknown, base: unknown) => printFrom(e.sender, html, base))
  ipcMain.handle('page-guard:passkey', (e, use: unknown) => {
    const held = heldPageOf(e.sender)
    const frame = e.senderFrame
    // The site that asks: an iframe's own, which is also the name Touch ID shows.
    const site = (frame && originOf(frame.url)) || originOf(e.sender.getURL())
    if (!held || !site || !frame || !pageAsks.listenerCount('ask')) return null
    return new Promise<string | null>((resolve) => {
      let done = false
      const reply = (id: string | null) => {
        if (done) return
        done = true
        resolve(id)
      }
      pageAsks.emit('ask', { kind: 'passkey', key: held.key, wc: e.sender, page: held.page, frame, site, use: use === 'create' ? 'create' : 'get', reply })
      setTimeout(() => reply(null), 5000)
    })
  })
  ipcMain.on('page-guard:passkey-done', (e, id: unknown) => {
    const held = heldPageOf(e.sender)
    if (held) pageAsks.emit('ask', { kind: 'passkey-done', key: held.key, id: String(id ?? '') })
  })
}

/** A print request from a page (the guard's, or the console fallback's): the whole page, or an iframe's own document. */
function printFrom(wc: WebContents, html: unknown, base: unknown) {
  const held = heldPageOf(wc)
  if (!held) return
  const partition = partitionOfWc.get(wc.id) ?? BROWSER_PARTITION
  const frameHtml = typeof html === 'string' && html.length > 0 && html.length <= MAX_PRINT_HTML ? html : null
  // A frame's print with nothing Brain can draw (too big, or unreadable) prints nothing rather than the wrong page.
  if (typeof html === 'string' && !frameHtml) return
  const make = frameHtml
    ? () => htmlPdf(partition, frameHtml, String(base || ''), wc.getTitle())
    : async () => {
        if (!held.page.printPdf) throw new Error('This page cannot print.')
        return held.page.printPdf()
      }
  pageAsks.emit('ask', { kind: 'print', key: held.key, wc, page: held.page, make })
}

/** The console fallback's print: the page itself from its main frame, else that frame's document read in main. */
async function printFromConsole(wc: WebContents, frame: WebFrameMain | null | undefined) {
  if (!frame || frame === wc.mainFrame) return printFrom(wc, null, '')
  try {
    const got = (await within(frame.executeJavaScript(`({ html: '<!doctype html>' + document.documentElement.outerHTML, base: document.baseURI })`), STEP_MS, 'The frame')) as { html: string; base: string }
    printFrom(wc, String(got?.html || ''), String(got?.base || ''))
  } catch {
    // A frame that went away prints nothing.
  }
}

/** A click, key or typed text Brain sends. A page may open a pop-up only shortly after one. */
function isInput(method: string, params?: Record<string, unknown>): boolean {
  if (method === 'Input.insertText') return true
  if (method === 'Input.dispatchMouseEvent') return params?.type === 'mousePressed'
  if (method === 'Input.dispatchKeyEvent') return params?.type === 'keyDown' || params?.type === 'rawKeyDown'
  return false
}

/**
 * `ready` holds every debugger command until a pop-up's setup answered. A pop-up (`popup`) has no paint events in an
 * adopted offscreen view, so its live picture takes the screencast as its "page changed" signal.
 */
function adapterFor(host: BaseWindow, wc: WebContents, opts: { ready?: Promise<unknown>; popup?: boolean } = {}): DeskPage {
  let lastControls: string[] | null = null
  const ready = opts.ready ?? Promise.resolve()
  const cdp = (method: string, params?: Record<string, unknown>) =>
    within(
      ready.then(() => {
        if (isInput(method, params)) lastInput.set(wc.id, Date.now())
        return wc.debugger.sendCommand(method, params)
      }),
      STEP_MS,
      'The page'
    )

  const settle = async () => {
    if (wc.isLoading()) {
      await within(new Promise<void>((done) => wc.once('did-stop-loading', () => done())), 4000, 'Loading').catch(() => {})
    }
    await new Promise((done) => setTimeout(done, 300))
  }

  const read = async () => {
    for (let tries = 1; ; tries++) {
      try {
        return await inPage<ReturnType<typeof pageSnapshot>>(wc, pageSnapshot, null, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
      } catch (e) {
        // A click that navigates can swap the page out from under the read.
        if (tries >= 3 || !/context|navigat|destroyed|Script failed/i.test(errText(e))) throw e
        await settle()
      }
    }
  }

  const mouseClick = async (x: number, y: number, clickCount = 1) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
  }

  /** Centre of control `i` from the last snapshot, scrolled into view. null when the mark is gone. */
  const centre = (i: number) =>
    inPage<{ x: number; y: number } | null>(
      wc,
      (n: number) => {
        const el = document.querySelector(`[data-desk-n="${n}"]`) as HTMLElement | null
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      i
    )

  const clickControl = async (i: number) => {
    const at = await centre(i)
    if (!at) throw new Error(`no element found for control ${i}`)
    await mouseClick(at.x, at.y)
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

  const pressKey = async (key: string) => {
    const k = KEYS[key]
    if (!k) {
      if ([...key].length === 1) await cdp('Input.insertText', { text: key })
      return
    }
    const base = { key: key === 'Space' ? ' ' : key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }
    await cdp('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await settle()
  }

  /** A key from the wide picture. Edit commands use the page's own editing (paste reads the Mac clipboard). */
  const key = async (ev: KeyInput) => {
    const mods = ev.modifiers | 0
    if (ev.command && EDIT_COMMANDS.has(ev.command)) {
      const base = { key: ev.key, code: ev.code, modifiers: mods, windowsVirtualKeyCode: ev.key.toUpperCase().charCodeAt(0) }
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: [ev.command] })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      return
    }
    if (ev.text && !(mods & 0b0110)) {
      await cdp('Input.insertText', { text: ev.text })
      return
    }
    const named = KEYS[ev.key === ' ' ? 'Space' : ev.key]
    const chord = process.platform === 'darwin' ? MAC_CHORDS[`${mods}:${ev.key}`] : undefined
    if (chord && named) {
      const base = { key: ev.key, code: named.code, modifiers: mods, windowsVirtualKeyCode: named.vk, nativeVirtualKeyCode: named.vk }
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: [chord] })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      return
    }
    const vk = named?.vk ?? ev.key.toUpperCase().charCodeAt(0)
    const base = { key: ev.key, code: named?.code ?? ev.code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    const text = named?.text && !(mods & 0b0110) ? { text: named.text, unmodifiedText: named.text } : {}
    await cdp('Input.dispatchKeyEvent', { type: 'text' in text ? 'keyDown' : 'rawKeyDown', ...base, ...text })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  const pointer = async (ev: PointerInput) => {
    const type = ev.type === 'down' ? 'mousePressed' : ev.type === 'up' ? 'mouseReleased' : 'mouseMoved'
    await cdp('Input.dispatchMouseEvent', {
      type,
      x: ev.x,
      y: ev.y,
      button: ev.type === 'move' && !ev.buttons ? 'none' : ev.button,
      buttons: ev.buttons | 0,
      clickCount: ev.type === 'move' ? 0 : Math.max(1, ev.clickCount | 0)
    })
  }

  let watchers = 0
  const changed = new Set<() => void>()
  const onPaint = () => changed.forEach((fn) => fn())
  const onCast = (_e: unknown, method: string, params: Record<string, unknown>) => {
    if (method !== 'Page.screencastFrame') return
    void cdp('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    onPaint()
  }
  const startChanges = () => {
    if (!opts.popup) return wc.on('paint', onPaint)
    wc.debugger.on('message', onCast)
    void cdp('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }).catch(() => {})
  }
  const stopChanges = () => {
    if (!opts.popup) return wc.off('paint', onPaint)
    wc.debugger.off('message', onCast)
    void cdp('Page.stopScreencast').catch(() => {})
  }
  const frameOf = async (): Promise<PageFrame | null> => {
    const img = await wc.capturePage()
    if (img.isEmpty()) return null
    const size = img.getSize()
    const sized = size.width === VIEW.width && size.height === VIEW.height ? img : img.resize({ width: VIEW.width, height: VIEW.height, quality: 'good' })
    return { src: Buffer.from(sized.toJPEG(60)).toString('base64'), url: wc.getURL() }
  }
  /** Paint events fire only when the page changes. A burst sends its first frame and, after 66 ms, one more of the latest state. */
  const watch = (send: (frame: PageFrame) => void) => {
    let stopped = false
    let last = 0
    let timer: NodeJS.Timeout | null = null
    const emit = () => {
      timer = null
      last = Date.now()
      void frameOf().then((f) => {
        if (f && !stopped) send(f)
      }).catch(() => {})
    }
    const onChange = () => {
      if (timer || stopped) return
      timer = setTimeout(emit, Math.max(0, FRAME_MS - (Date.now() - last)))
    }
    changed.add(onChange)
    if (++watchers === 1) {
      startChanges()
      wc.setFrameRate(30)
      wc.setAudioMuted(false)
    }
    emit()
    return () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      changed.delete(onChange)
      if (wc.isDestroyed()) return
      if (--watchers === 0) {
        stopChanges()
        wc.setFrameRate(10)
        wc.setAudioMuted(true)
      }
    }
  }

  return {
    id: wc.id,
    pointer,
    key,
    watch,
    live: () => watchers > 0,
    facts: () => ({ url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }),
    nav: async (action) => {
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      else if (action === 'reload') wc.reload()
      else return
      await settle()
    },
    printPdf: async () => ({ pdf: Buffer.from(await within(wc.printToPDF({ printBackground: true }), STEP_MS, 'The page')), title: wc.getTitle() }),
    edit: (action) => {
      if (action === 'copy') wc.copy()
      else if (action === 'cut') wc.cut()
      else if (action === 'paste') wc.paste()
      else wc.selectAll()
    },
    run: (fn, ...args) => inPage(wc, fn, ...args),
    url: () => wc.getURL(),
    goto: async (url) => {
      // A dead link or a slow page still leaves something in the window to read.
      await within(wc.loadURL(url), LOAD_MS, 'The page').catch((e) => {
        if (!/ERR_|net::|did not answer/i.test(errText(e))) throw e
      })
      await settle()
    },
    snapshot: async () => {
      const got = await read()
      lastControls = got.controls
      return { url: wc.getURL(), ...got }
    },
    click: (i) => onControl(i, () => clickControl(i)),
    type: (i, text) =>
      onControl(i, async () => {
        await clickControl(i)
        await inPage(wc, () => {
          const el = document.activeElement as HTMLElement | null
          if (!el) return
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select()
            return
          }
          if (el.isContentEditable) {
            const range = document.createRange()
            range.selectNodeContents(el)
            const sel = getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        })
        if (text) await cdp('Input.insertText', { text })
      }),
    submit: (i) => onControl(i, () => clickControl(i)),
    submitFor: (i) => inPage(wc, pageSubmitFor, i),
    activeNames: () => inPage(wc, pageActiveNames),
    scroll: async (dir) => {
      await inPage(wc, pageScroll, dir)
      await settle()
    },
    front: async () => {
      // The page lives inside Brain. Nothing to bring forward.
    },
    shot: async () => {
      const img = await within(wc.capturePage(), STEP_MS, 'The picture')
      if (img.isEmpty()) return new Uint8Array()
      const size = img.getSize()
      const sized = size.width === VIEW.width && size.height === VIEW.height ? img : img.resize({ width: VIEW.width, height: VIEW.height, quality: 'good' })
      return new Uint8Array(sized.toJPEG(50))
    },
    closed: () => host.isDestroyed() || wc.isDestroyed(),
    clickAt: (x, y) => mouseClick(x, y),
    typeText: async (text) => {
      if (text) await cdp('Input.insertText', { text })
    },
    pressKey,
    wheel: async (deltaY) => {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEW.width / 2, y: VIEW.height / 2, deltaX: 0, deltaY })
    }
  }
}

type Held = { host: BaseWindow; wc: WebContents; page: DeskPage }

/** What a window asks of the launch that holds it: whether a page may open a pop-up on top of it, and how. */
type OpenWindow = (key: string, partition: string, opener: WebContents, details: HandlerDetails) => WindowOpenHandlerResponse

/** Everything a Brain page, base window or pop-up, gets wired with. `cdp` waits on the page's own setup. */
function wire(key: string, partition: string, held: Held, cdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>, openWindow: OpenWindow) {
  const { host, wc, page } = held
  wc.setAudioMuted(true)
  wc.setFrameRate(10)
  keyOfPage.set(wc.id, key)
  pageOfWc.set(wc.id, page)
  partitionOfWc.set(wc.id, partition)
  const id = wc.id
  wc.once('destroyed', () => {
    pageOfWc.delete(id)
    lastInput.delete(id)
    // A download a closing window started still needs to find its owners for a while.
    setTimeout(() => {
      if (keyOfPage.get(id) === key) keyOfPage.delete(id)
      partitionOfWc.delete(id)
    }, KEY_GRACE_MS).unref?.()
  })
  wc.setWindowOpenHandler((details) => openWindow(key, partition, wc, details))
  wc.on('console-message', (e) => {
    if (e.message === PRINT_MARK) void printFromConsole(wc, e.frame)
  })
  // Only web pages, an empty page or a page's own blob: in any Brain window. Never a file or another app.
  wc.on('will-navigate', (e) => {
    if (!navAllowed(e.url)) e.preventDefault()
  })
  host.on('closed', () => {
    if (!wc.isDestroyed()) wc.close()
  })
  // A crashed page would answer nothing until each step timed out. Drop the window; the next step opens a new one.
  wc.on('render-process-gone', () => {
    if (!host.isDestroyed()) host.destroy()
  })
  wc.debugger.on('message', (_e, method, params) => {
    // A file input asks Brain, not an invisible macOS panel on this hidden window.
    if (method !== 'Page.fileChooserOpened') return
    const node = (params as { backendNodeId?: number }).backendNodeId
    if (node == null) return
    pageAsks.emit('ask', {
      kind: 'file',
      key,
      wc,
      // Read now: a destroyed window throws on every property, and the queue still has to let go of it.
      wcId: wc.id,
      multiple: (params as { mode?: string }).mode === 'selectMultiple',
      put: async (files) => {
        await cdp('DOM.setFileInputFiles', { files, backendNodeId: node })
      }
    })
  })
  // A right-click from a live picture. A small picture sends none.
  wc.on('context-menu', (_e, params) => {
    if (page.live?.()) pageAsks.emit('ask', { kind: 'menu', key, wc, page, params })
  })
}

async function openHeld(key: string, partition: string, openWindow: OpenWindow): Promise<Held> {
  browserSession(partition)
  const host = new BaseWindow({ show: false, width: VIEW.width, height: VIEW.height, skipTaskbar: true })
  const view = new WebContentsView({ webPreferences: pagePrefs(partition) })
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...VIEW })
  const wc = view.webContents
  // The debugger has to attach after a first load; a command sent before it never returns.
  await wc.loadURL('about:blank')
  wc.debugger.attach('1.3')
  const cdp = (method: string, params?: Record<string, unknown>) => within(wc.debugger.sendCommand(method, params), STEP_MS, 'The page')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp('Page.enable')
  await cdp('Page.setInterceptFileChooserDialog', { enabled: true })
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: PRINT_FALLBACK })
  const held = { host, wc, page: adapterFor(host, wc) }
  wire(key, partition, held, cdp, openWindow)
  return held
}

/**
 * A page's new window, taken in synchronously inside `createWindow` so its key is known before its first document
 * runs. The debugger attaches one tick later: attaching inside `createWindow` crashes Electron 44 for a pop-up opened
 * without an opener (a plain target=_blank link). It is already navigating then, so the debugger answers at once.
 * The viewport is set by hand (an adopted offscreen view stays 0 x 0). Input waits until that setup answered.
 */
function adoptPopup(key: string, partition: string, wc: WebContents, openWindow: OpenWindow): Held {
  const host = new BaseWindow({ show: false, width: VIEW.width, height: VIEW.height, skipTaskbar: true })
  const view = new WebContentsView({ webContents: wc })
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...VIEW })
  const send = (method: string, params?: Record<string, unknown>) => within(wc.debugger.sendCommand(method, params), STEP_MS, 'The pop-up')
  const ready = new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      try {
        if (wc.isDestroyed()) throw new Error('The pop-up closed before it opened.')
        wc.debugger.attach('1.3')
      } catch (e) {
        reject(e)
        return
      }
      Promise.all([
        send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false }),
        send('Emulation.setFocusEmulationEnabled', { enabled: true }),
        send('Page.enable').then(() => Promise.all([send('Page.setInterceptFileChooserDialog', { enabled: true }), send('Page.addScriptToEvaluateOnNewDocument', { source: PRINT_FALLBACK })]))
      ]).then(() => resolve(), reject)
    })
  )
  ready.catch(() => {
    if (!host.isDestroyed()) host.destroy()
  })
  const held = { host, wc, page: adapterFor(host, wc, { ready, popup: true }) }
  wire(key, partition, held, (method, params) => ready.then(() => send(method, params)), openWindow)
  return held
}

/** The launch the desk browser takes. Same keyed windows as before: `wa` and `wa:<name>` are the WhatsApp windows and are never closed by a place. */
export function makeInAppLaunch(): DeskLaunch & { windows: DeskWindows; closeAll: () => void } {
  const byKey = new Map<string, Held>()
  /** Pop-ups open on top of each key's window, oldest first. */
  const stacks = new Map<string, Held[]>()
  const opening = new Map<string, Promise<DeskPage | { noChrome: true }>>()
  /** A close that arrived while this key was still opening. The open does not keep the window. */
  const dropped = new Set<string>()
  const topWatchers = new Set<(key: string) => void>()

  const alive = (held: Held | undefined): held is Held => !!held && !held.host.isDestroyed() && !held.wc.isDestroyed()
  const popupsOf = (key: string): Held[] => {
    const live = (stacks.get(key) ?? []).filter(alive)
    if (live.length) stacks.set(key, live)
    else stacks.delete(key)
    return live
  }
  const topOf = (key: string): Held | null => {
    const pops = popupsOf(key)
    if (pops.length) return pops[pops.length - 1]
    const base = byKey.get(key)
    return alive(base) ? base : null
  }
  const tellTop = (key: string) => {
    for (const fn of topWatchers) fn(key)
  }
  const dropPopups = (key: string) => {
    for (const pop of stacks.get(key) ?? []) if (!pop.host.isDestroyed()) pop.host.destroy()
    stacks.delete(key)
  }

  /** A pop-up opens only right after Brain sent this window a click or key, only to a web page or an empty one, and at most three deep. */
  const openWindow: OpenWindow = (key, partition, opener, details) => {
    const recent = Date.now() - (lastInput.get(opener.id) ?? 0) <= OPEN_AFTER_INPUT_MS
    const url = details.url || 'about:blank'
    if (!recent || !alive(byKey.get(key)) || popupsOf(key).length >= MAX_POPUPS || !(url === 'about:blank' || /^https?:\/\//i.test(url))) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { show: false, webPreferences: pagePrefs(partition) },
      createWindow: (options) => {
        // Electron passes the new page here at run time, though its typings leave the field out.
        const wc = (options as { webContents?: WebContents }).webContents
        if (!wc) throw new Error('The pop-up came without a page.')
        const held = adoptPopup(key, partition, wc, openWindow)
        stacks.set(key, [...popupsOf(key), held])
        wc.once('destroyed', () => {
          if (!held.host.isDestroyed()) held.host.destroy()
          popupsOf(key)
          tellTop(key)
        })
        tellTop(key)
        return wc
      }
    }
  }

  async function pageFor(key: string): Promise<DeskPage | { noChrome: true }> {
    const inflight = opening.get(key)
    if (inflight) return inflight
    const held = byKey.get(key)
    if (alive(held)) return topOf(key)!.page
    if (held) byKey.delete(key)
    dropped.delete(key)
    const job = (async (): Promise<DeskPage | { noChrome: true }> => {
      const fresh = await openHeld(key, whatsappPartition(key) ?? BROWSER_PARTITION, openWindow)
      if (dropped.has(key)) {
        dropped.delete(key)
        fresh.host.destroy()
        return { noChrome: true }
      }
      byKey.set(key, fresh)
      fresh.wc.once('destroyed', () => {
        if (byKey.get(key) !== fresh) return
        byKey.delete(key)
        // Pop-ups do not outlive the window they came from.
        dropPopups(key)
        tellTop(key)
      })
      return fresh.page
    })()
    opening.set(key, job)
    try {
      return await job
    } finally {
      if (opening.get(key) === job) opening.delete(key)
    }
  }

  function peek(key: string): DeskPage | null {
    return topOf(key)?.page ?? null
  }

  const windows: DeskWindows = {
    connect: async () => ({ inApp: true }),
    page: pageFor,
    peek,
    has: (key) => alive(byKey.get(key)),
    base: (key) => {
      const held = byKey.get(key)
      return alive(held) ? held.page : null
    },
    layers: (key) => popupsOf(key).length,
    async closeTop(key) {
      const pops = popupsOf(key)
      const top = pops[pops.length - 1]
      if (!top) return false
      // Destroying the host skips the page's beforeunload, so a pop-up cannot keep itself open.
      top.host.destroy()
      return true
    },
    onTop(fn) {
      topWatchers.add(fn)
      return () => topWatchers.delete(fn)
    },
    async close(key) {
      if (!key || isWhatsAppKey(key)) return
      if (opening.has(key)) dropped.add(key)
      const held = byKey.get(key)
      byKey.delete(key)
      dropPopups(key)
      if (held && !held.host.isDestroyed()) held.host.destroy()
    },
    anyOpen: () => [...byKey.values()].some(alive)
  }

  const closeAll = () => {
    for (const key of [...stacks.keys()]) dropPopups(key)
    for (const held of byKey.values()) if (!held.host.isDestroyed()) held.host.destroy()
    byKey.clear()
  }
  return Object.assign(async () => pageFor('page'), { windows, closeAll })
}
