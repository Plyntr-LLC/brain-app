import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { menuFor, opensOutside, pdfName, type MenuAction } from '../shared/browser-menu.ts'
import type { DeskBrowser } from '../shared/desk.ts'
import type { DeskPage } from './desk/chrome.ts'
import { freePath, pageAsks, type PageAsk } from './desk/inapp.ts'
import { startPageTurn } from './desk/page-lane.ts'
import { isWhatsAppKey } from '../shared/page-picture.ts'

/**
 * Answers what pages in Brain's browser ask of the person: a file to upload, a right-click menu, a page's own
 * print, a finished download. Only the person picks files; nothing opens outside Brain except web and mail links.
 */

const PRINT_COOLDOWN_MS = 10_000
const MAX_DOWNLOADS = 200

function siteOf(url: string): string {
  try {
    return new URL(url).host || 'This page'
  } catch {
    return 'This page'
  }
}

export function startBrowserUi(opts: { browser: DeskBrowser; window: () => BrowserWindow | null }): void {
  const downloads = new Map<string, string>()
  const send = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // One Open panel at a time for the whole app. A page asking again while its own ask is open or waiting is refused.
  const waiting: Extract<PageAsk, { kind: 'file' }>[] = []
  const asking = new Set<number>()
  let open = false
  async function nextFile() {
    if (open) return
    const ask = waiting.shift()
    if (!ask) return
    open = true
    try {
      if (ask.wc.isDestroyed()) return
      const props: ('openFile' | 'multiSelections')[] = ask.multiple ? ['openFile', 'multiSelections'] : ['openFile']
      // The panel names the site, so a page the AI clicked into is not mistaken for Brain asking.
      const options = { properties: props, message: `${siteOf(ask.wc.getURL())} wants a file.` }
      // A sheet on a hidden Brain window would stay invisible and hold the queue; then the panel stands alone.
      const win = opts.window()
      const picked = win && win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (!picked.canceled && picked.filePaths.length && !ask.wc.isDestroyed()) await ask.put(picked.filePaths)
    } catch {
      // A page that went away while the panel was open takes nothing.
    } finally {
      asking.delete(ask.wcId)
      open = false
      void nextFile()
    }
  }

  // A page's own print() makes a PDF only while someone watches it live, and at most one per window per cooldown.
  const lastPrint = new Map<string, number>()
  const printing = new Set<string>()
  async function savePdf(key: string, page: DeskPage, own: boolean) {
    // The cooldown stops a page's own print() loop; a person choosing Print to PDF is never held back by it.
    if (printing.has(key) || (own && Date.now() - (lastPrint.get(key) ?? 0) < PRINT_COOLDOWN_MS) || !page.printPdf) return
    printing.add(key)
    try {
      const { pdf, title } = await page.printPdf()
      const path = freePath(app.getPath('downloads'), pdfName(title))
      writeFileSync(path, pdf)
      await shell.openPath(path)
    } finally {
      lastPrint.set(key, Date.now())
      printing.delete(key)
    }
  }

  async function onMenu(ask: Extract<PageAsk, { kind: 'menu' }>) {
    const { page, params, key, wc } = ask
    const f = page.facts?.() ?? { url: params.pageURL, canGoBack: false, canGoForward: false }
    const entries = menuFor(
      { linkURL: params.linkURL, selectionText: params.selectionText, isEditable: params.isEditable, mediaType: params.mediaType, srcURL: params.srcURL, pageURL: f.url },
      { canGoBack: f.canGoBack, canGoForward: f.canGoForward, shared: isWhatsAppKey(key) }
    )
    const act = async (action: MenuAction) => {
      if (wc.isDestroyed()) return
      // Moving the page and printing it wait for the window's lane, so neither lands in the middle of an AI step.
      if (action === 'back' || action === 'forward' || action === 'reload' || action === 'print') {
        const turn = startPageTurn(key)
        try {
          await turn.promise
          if (action === 'print') await savePdf(key, page, false)
          else await page.nav?.(action)
        } finally {
          turn.release()
        }
      } else if (action === 'copyLink') await clipboard.writeText(params.linkURL)
      else if (action === 'openLink' && opensOutside(params.linkURL)) await shell.openExternal(params.linkURL)
      else if (action === 'copyImage') await clipboard.writeText(params.srcURL)
      else if (action === 'copy' || action === 'cut' || action === 'paste' || action === 'selectAll') page.edit?.(action)
      else if (action === 'openPage' && opensOutside(f.url)) await shell.openExternal(f.url)
    }
    const template: MenuItemConstructorOptions[] = entries.map((e) => ('separator' in e ? { type: 'separator' } : { label: e.label, click: () => void act(e.action) }))
    const win = opts.window()
    Menu.buildFromTemplate(template).popup(win ? { window: win } : {})
  }

  pageAsks.on('ask', (ask) => {
    if (ask.kind === 'file') {
      if (asking.has(ask.wcId)) return
      asking.add(ask.wcId)
      waiting.push(ask)
      void nextFile()
    } else if (ask.kind === 'menu') {
      void onMenu(ask)
    } else if (ask.kind === 'print') {
      if (ask.page.live?.()) void savePdf(ask.key, ask.page, true)
    } else if (ask.kind === 'download') {
      const id = randomBytes(9).toString('hex')
      downloads.set(id, ask.path)
      // Only recent downloads can be opened from a line; the oldest ids are forgotten.
      if (downloads.size > MAX_DOWNLOADS) downloads.delete(downloads.keys().next().value!)
      for (const owner of opts.browser.ownersShowing?.(ask.key) ?? []) send('browser:download', { owner, id, name: ask.name, state: ask.state })
    }
  })

  ipcMain.handle('browser:nav', (_e, owner: string, action: string) =>
    action === 'back' || action === 'forward' || action === 'reload' ? opts.browser.nav?.(String(owner || ''), action) ?? false : false
  )
  ipcMain.handle('browser:go', (_e, owner: string, text: string) => opts.browser.go?.(String(owner || ''), String(text || '')) ?? false)
  ipcMain.handle('browser:print', async (_e, owner: string) => {
    const out = await opts.browser.printPage?.(String(owner || ''))
    if (!out) return false
    const path = freePath(app.getPath('downloads'), pdfName(out.title))
    writeFileSync(path, out.pdf)
    await shell.openPath(path)
    return true
  })
  // Only a download Brain finished can be opened, by its id, never a path the window sends.
  ipcMain.handle('browser:openDownload', async (_e, id: string, how: string) => {
    const path = downloads.get(String(id || ''))
    if (!path) return false
    if (how === 'show') shell.showItemInFolder(path)
    else await shell.openPath(path)
    return true
  })
}
