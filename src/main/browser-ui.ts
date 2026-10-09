import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, systemPreferences, type MenuItemConstructorOptions, type WebFrameMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { menuFor, opensOutside, pdfName, type MenuAction } from '../shared/browser-menu.ts'
import type { DeskBrowser, PageCard, PageCardEnd } from '../shared/desk.ts'
import { cardKey, forget, originOf, parseStore, remember, remembered, type SiteStore, type SiteUse } from '../shared/site-permissions.ts'
import type { DeskPage } from './desk/chrome.ts'
import { freePath, heldPageOf, pageAsks, setSiteCheck, type PageAsk } from './desk/inapp.ts'
import { startPageTurn } from './desk/page-lane.ts'
import { isWhatsAppKey } from '../shared/page-picture.ts'

/**
 * Answers what pages in Brain's browser ask of the person: a file to upload, a right-click menu, a page's own
 * print, a finished download. Only the person picks files; nothing opens outside Brain except web and mail links.
 */

const PRINT_COOLDOWN_MS = 10_000
const MAX_DOWNLOADS = 200
/** A card nobody answers refuses after this long. */
const ASK_MS = 120_000
/** A passkey card goes after this long even if the page never says its request ended. */
const PASSKEY_CARD_MS = 300_000

function siteOf(url: string): string {
  try {
    return new URL(url).host || 'This page'
  } catch {
    return 'This page'
  }
}

type Unowned<T> = T extends unknown ? Omit<T, 'owner'> : never

/** What a card is waiting on, by card id. Every callback in it is called exactly once. */
type OpenCard =
  | { kind: 'site'; key: string; owners: string[]; ck: string; partition: string; site: string; uses: SiteUse[]; answers: ((yes: boolean) => void)[]; timer: NodeJS.Timeout; answered: boolean }
  | { kind: 'passkey'; key: string; owners: string[]; frame: WebFrameMain; timer: NodeJS.Timeout; answered: boolean }
  | { kind: 'account'; key: string; owners: string[]; accounts: { id: string; name: string }[]; pick: (id?: string) => void; timer: NodeJS.Timeout; answered: boolean }

export function startBrowserUi(opts: {
  browser: DeskBrowser
  window: () => BrowserWindow | null
  /** Checks only: a shorter card timeout, and a stand-in for macOS's camera and microphone answer. */
  test?: { askMs?: number; mediaAccess?: (use: 'camera' | 'microphone') => Promise<boolean> }
}): void {
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
  async function savePdf(key: string, make: () => Promise<{ pdf: Buffer; title: string }>, own: boolean) {
    // The cooldown stops a page's own print() loop; a person choosing Print to PDF is never held back by it.
    if (printing.has(key) || (own && Date.now() - (lastPrint.get(key) ?? 0) < PRINT_COOLDOWN_MS)) return
    printing.add(key)
    try {
      const { pdf, title } = await make()
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
    const login = heldPageOf(wc)?.partition
    const site = originOf(f.url)
    const known = !!login && !!site && (remembered(store(), login, site, 'camera') || remembered(store(), login, site, 'microphone'))
    const entries = menuFor(
      { linkURL: params.linkURL, selectionText: params.selectionText, isEditable: params.isEditable, mediaType: params.mediaType, srcURL: params.srcURL, pageURL: f.url },
      { canGoBack: f.canGoBack, canGoForward: f.canGoForward, shared: isWhatsAppKey(key), remembered: known }
    )
    const act = async (action: MenuAction) => {
      if (wc.isDestroyed()) return
      // Moving the page and printing it wait for the window's lane, so neither lands in the middle of an AI step.
      if (action === 'back' || action === 'forward' || action === 'reload' || action === 'print') {
        const turn = startPageTurn(key)
        try {
          await turn.promise
          if (action === 'print') {
            if (page.printPdf) await savePdf(key, () => page.printPdf!(), false)
          }
          else await page.nav?.(action)
        } finally {
          turn.release()
        }
      } else if (action === 'copyLink') await clipboard.writeText(params.linkURL)
      else if (action === 'openLink' && opensOutside(params.linkURL)) await shell.openExternal(params.linkURL)
      else if (action === 'copyImage') await clipboard.writeText(params.srcURL)
      else if (action === 'copy' || action === 'cut' || action === 'paste' || action === 'selectAll') page.edit?.(action)
      else if (action === 'openPage' && opensOutside(f.url)) await shell.openExternal(f.url)
      else if (action === 'forget' && login && site) save(forget(store(), login, site))
    }
    const template: MenuItemConstructorOptions[] = entries.map((e) => ('separator' in e ? { type: 'separator' } : { label: e.label, click: () => void act(e.action) }))
    const win = opts.window()
    Menu.buildFromTemplate(template).popup(win ? { window: win } : {})
  }

  // ---- Cards: site asks, passkeys, accounts. Only a person answers them, from a chat they were sent to. ----
  const askMs = opts.test?.askMs ?? ASK_MS
  const cards = new Map<string, OpenCard>()
  /** Don't allow, for the rest of this run: login, site and the exact set asked. */
  const refusedNow = new Set<string>()
  const storePath = () => join(app.getPath('userData'), 'site-permissions.json')
  let stored: SiteStore | null = null
  const store = (): SiteStore => {
    if (!stored) {
      try {
        stored = parseStore(readFileSync(storePath(), 'utf8'))
      } catch {
        stored = {}
      }
    }
    return stored
  }
  const save = (next: SiteStore) => {
    stored = next
    const tmp = `${storePath()}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, storePath())
  }

  /** The page is live (wide or large, in the tab on screen) and Brain's window is up front, so a person is there. */
  const withPerson = (page: DeskPage | undefined) => {
    const win = opts.window()
    return !!page?.live?.() && !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
  }
  // A remembered camera or microphone Allow counts only while a person is there (navigator.permissions.query too).
  setSiteCheck(({ partition, page, site, use }) => withPerson(page) && remembered(store(), partition, site, use))

  /** Cards go to chats only: a Desk tile has nowhere to show one. */
  const chatOwners = (key: string) => (opts.browser.ownersShowing?.(key) ?? []).filter((o) => o.startsWith('chat:'))
  const newId = () => randomBytes(9).toString('hex')
  const showCard = (owners: string[], card: Unowned<PageCard>) => {
    for (const owner of owners) send('browser:ask', { ...card, owner })
  }

  /** Finishes a card once: its callbacks, and a last line in every chat it was in. */
  function end(id: string, note: string, yes = false, pick?: string) {
    const card = cards.get(id)
    if (!card) return
    cards.delete(id)
    clearTimeout(card.timer)
    if (card.kind === 'site') {
      for (const answer of card.answers) answer(yes)
    } else if (card.kind === 'account') {
      card.pick(pick)
    }
    for (const owner of card.owners) send('browser:askEnded', { owner, id, note } satisfies PageCardEnd)
  }

  function onSite(ask: Extract<PageAsk, { kind: 'site' }>) {
    if (!withPerson(ask.page)) return ask.answer(false)
    if (ask.uses.every((u) => remembered(store(), ask.partition, ask.site, u))) return ask.answer(true)
    const ck = cardKey(ask.partition, ask.site, ask.uses)
    if (refusedNow.has(ck)) return ask.answer(false)
    const open = [...cards.entries()].find(([, c]) => c.kind === 'site' && c.ck === ck && !c.answered)
    if (open && open[1].kind === 'site') {
      open[1].answers.push(ask.answer)
      return
    }
    const owners = chatOwners(ask.key)
    if (!owners.length) return ask.answer(false)
    const id = newId()
    const timer = setTimeout(() => end(id, 'No answer in time. Nothing was allowed.'), askMs)
    cards.set(id, { kind: 'site', key: ask.key, owners, ck, partition: ask.partition, site: ask.site, uses: ask.uses, answers: [ask.answer], timer, answered: false })
    ask.wc.once('destroyed', () => end(id, 'The page closed. Nothing was allowed.'))
    showCard(owners, { id, kind: 'site', site: ask.site, uses: ask.uses })
  }

  function onPasskey(ask: Extract<PageAsk, { kind: 'passkey' }>) {
    // Only with a person watching, so the AI never puts a Touch ID prompt on screen; one waiting request per window.
    const busy = [...cards.values()].some((c) => c.kind === 'passkey' && c.key === ask.key)
    const owners = chatOwners(ask.key)
    if (!withPerson(ask.page) || busy || !owners.length) return ask.reply(null)
    const id = newId()
    const timer = setTimeout(() => end(id, ''), PASSKEY_CARD_MS)
    cards.set(id, { kind: 'passkey', key: ask.key, owners, frame: ask.frame, timer, answered: false })
    ask.wc.once('destroyed', () => end(id, ''))
    showCard(owners, { id, kind: 'passkey', site: ask.site })
    ask.reply(id)
  }

  function onAccount(ask: Extract<PageAsk, { kind: 'account' }>) {
    const owners = chatOwners(ask.key)
    if (!owners.length || !ask.accounts.length) return ask.pick()
    const id = newId()
    const timer = setTimeout(() => end(id, 'No account picked in time.'), askMs)
    cards.set(id, { kind: 'account', key: ask.key, owners, accounts: ask.accounts, pick: ask.pick, timer, answered: false })
    ask.wc.once('destroyed', () => end(id, ''))
    showCard(owners, { id, kind: 'account', site: ask.site, accounts: ask.accounts })
  }

  /** macOS's own camera or microphone switch for Brain. A check stands in for it. */
  async function macAllows(use: 'camera' | 'microphone'): Promise<boolean> {
    if (opts.test?.mediaAccess) return opts.test.mediaAccess(use)
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus(use) === 'granted') return true
    return systemPreferences.askForMediaAccess(use)
  }

  ipcMain.handle('browser:askAnswer', async (_e, owner: string, id: string, answer: string) => {
    const card = cards.get(String(id || ''))
    if (!card || card.answered || !card.owners.includes(String(owner || ''))) return { refused: true }
    card.answered = true
    if (card.kind === 'passkey') {
      if (answer !== 'cancel') return { refused: true }
      try {
        card.frame.send('page-guard:passkey-cancel', id)
      } catch {
        // The page went away; its request went with it.
      }
      end(id, 'Cancelled.')
      return { ok: true }
    }
    if (card.kind === 'account') {
      const hit = card.accounts.find((a) => a.id === answer)
      end(id, hit ? `Signing in as ${hit.name}.` : 'Cancelled.', false, hit?.id)
      return { ok: true }
    }
    if (answer !== 'allow') {
      refusedNow.add(card.ck)
      end(id, 'Not allowed.')
      return { ok: true }
    }
    for (const use of card.uses) {
      if (use === 'clipboard' || (await macAllows(use))) continue
      const name = use === 'camera' ? 'Camera' : 'Microphone'
      end(id, `macOS has Brain's ${use} turned off. System Settings > Privacy & Security > ${name}.`)
      return { ok: true }
    }
    save(remember(store(), card.partition, card.site, card.uses))
    end(id, 'Allowed.', true)
    return { ok: true }
  })
  ipcMain.handle('browser:closePopup', (_e, owner: string) => opts.browser.closeTop?.(String(owner || '')) ?? false)

  pageAsks.on('ask', (ask) => {
    if (ask.kind === 'file') {
      if (asking.has(ask.wcId)) return
      asking.add(ask.wcId)
      waiting.push(ask)
      void nextFile()
    } else if (ask.kind === 'menu') {
      void onMenu(ask)
    } else if (ask.kind === 'print') {
      if (ask.page.live?.()) void savePdf(ask.key, ask.make, true)
    } else if (ask.kind === 'site') {
      onSite(ask)
    } else if (ask.kind === 'passkey') {
      onPasskey(ask)
    } else if (ask.kind === 'passkey-done') {
      const card = cards.get(ask.id)
      if (card?.kind === 'passkey' && card.key === ask.key) end(ask.id, '')
    } else if (ask.kind === 'account') {
      onAccount(ask)
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
