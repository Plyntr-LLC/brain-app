import { app, BaseWindow, WebContentsView, session, type Session, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS } from '../../shared/desk.ts'
import type { DeskLaunch, KeyInput, PageFrame, PointerInput } from '../../shared/desk.ts'
import { pageActiveNames, pageScroll, pageSnapshot, pageSubmitFor, type DeskPage, type DeskWindows } from './chrome.ts'

/**
 * The browser inside Brain. Each window is a hidden BaseWindow holding one offscreen WebContentsView,
 * so nothing shows on screen and Brain's BrowserWindow.getAllWindows() never lists it.
 * Every window shares one saved partition, so a login made in one chat is there for every chat and Desk bot.
 */

export const BROWSER_PARTITION = 'persist:brain-browser'
export const VIEW = { width: 1100, height: 800 }
const STEP_MS = 15_000
const FRAME_MS = 66
const EDIT_COMMANDS = new Set(['selectAll', 'copy', 'paste', 'cut', 'undo', 'redo'])
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

function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext) || 'download'
  let file = join(dir, `${stem}${ext}`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem} (${n})${ext}`)
  return file
}

const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])
let prepared: Session | null = null

function browserSession(): Session {
  if (prepared) return prepared
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setUserAgent(chromeAgent())
  ses.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
  ses.on('will-download', (_e, item) => item.setSavePath(freePath(app.getPath('downloads'), item.getFilename())))
  prepared = ses
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

function adapterFor(host: BaseWindow, wc: WebContents): DeskPage {
  let lastControls: string[] | null = null
  const cdp = (method: string, params?: Record<string, unknown>) => within(wc.debugger.sendCommand(method, params), STEP_MS, 'The page')

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
    const onPaint = () => {
      if (timer || stopped) return
      timer = setTimeout(emit, Math.max(0, FRAME_MS - (Date.now() - last)))
    }
    wc.on('paint', onPaint)
    if (++watchers === 1) wc.setFrameRate(30)
    emit()
    return () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      if (wc.isDestroyed()) return
      wc.off('paint', onPaint)
      if (--watchers === 0) wc.setFrameRate(10)
    }
  }

  return {
    pointer,
    key,
    watch,
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

async function openHeld(): Promise<Held> {
  browserSession()
  const host = new BaseWindow({ show: false, width: VIEW.width, height: VIEW.height, skipTaskbar: true })
  const view = new WebContentsView({
    webPreferences: { offscreen: true, partition: BROWSER_PARTITION, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...VIEW })
  const wc = view.webContents
  wc.setAudioMuted(true)
  wc.setFrameRate(10)
  // A link that opens a new window loads here instead. Nothing new appears on screen.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void wc.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  host.on('closed', () => {
    if (!wc.isDestroyed()) wc.close()
  })
  // A crashed page would answer nothing until each step timed out. Drop the window; the next step opens a new one.
  wc.on('render-process-gone', () => {
    if (!host.isDestroyed()) host.destroy()
  })
  // The debugger has to attach after a first load; a command sent before it never returns.
  await wc.loadURL('about:blank')
  wc.debugger.attach('1.3')
  await within(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), STEP_MS, 'The page')
  return { host, wc, page: adapterFor(host, wc) }
}

/** The launch the desk browser takes. Same keyed windows as before: `wa` is the one WhatsApp window and is never closed by a place. */
export function makeInAppLaunch(): DeskLaunch & { windows: DeskWindows; closeAll: () => void } {
  const byKey = new Map<string, Held>()
  const opening = new Map<string, Promise<DeskPage | { noChrome: true }>>()
  /** A close that arrived while this key was still opening. The open does not keep the window. */
  const dropped = new Set<string>()

  const alive = (held: Held | undefined): held is Held => !!held && !held.host.isDestroyed() && !held.wc.isDestroyed()

  async function pageFor(key: string): Promise<DeskPage | { noChrome: true }> {
    const inflight = opening.get(key)
    if (inflight) return inflight
    const held = byKey.get(key)
    if (alive(held)) return held.page
    if (held) byKey.delete(key)
    dropped.delete(key)
    const job = (async (): Promise<DeskPage | { noChrome: true }> => {
      const fresh = await openHeld()
      if (dropped.has(key)) {
        dropped.delete(key)
        fresh.host.destroy()
        return { noChrome: true }
      }
      byKey.set(key, fresh)
      fresh.wc.once('destroyed', () => {
        if (byKey.get(key) === fresh) byKey.delete(key)
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
    const held = byKey.get(key)
    return alive(held) ? held.page : null
  }

  const windows: DeskWindows = {
    connect: async () => ({ inApp: true }),
    page: pageFor,
    peek,
    has: (key) => peek(key) !== null,
    async close(key) {
      if (!key || key === 'wa') return
      if (opening.has(key)) dropped.add(key)
      const held = byKey.get(key)
      byKey.delete(key)
      if (held && !held.host.isDestroyed()) held.host.destroy()
    },
    anyOpen: () => [...byKey.values()].some(alive)
  }

  const closeAll = () => {
    for (const held of byKey.values()) if (!held.host.isDestroyed()) held.host.destroy()
    byKey.clear()
  }
  return Object.assign(async () => pageFor('page'), { windows, closeAll })
}
