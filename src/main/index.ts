import './setup-drive-home'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { appAllowList, attachMainLinks, installGuestLinkPolicy } from './link-policy'
import { join } from 'node:path'
import { readWatching } from './agency-brain'
import { currentBrainFolder } from './brains'
import { setBrainSyncBlockedReason, startBrainSync } from './brain-sync'
import { readSyncMode } from './sync-manifest'
import { AB_OWNS_PLYNTR } from './watcher-choice'
import { notifySetupBack } from './bring-front'
import { retargetHqSync, isHqMiniFolder } from './hq-sync'
import { loadAccount } from './session-token'
import { registerStubIpc } from './ipc-stubs'
import { killAllPtys, registerPtyIpc } from './pty'
import { killAllWarm, prewarm } from './warm'
import { registerUpdateIpc, startAutoUpdate, recordLaunchVersion, isInstallingUpdate, installDownloadedUpdate } from './update'
import { registerSkinIpc } from './skin/ipc'
import { registerFactoryIpc } from './factory/ipc'
import { shutdownFactory } from './factory/controller'
import { registerPhoneIpc, restorePhoneIfWanted, stopPhone } from './phone'
import { registerDeskIpc } from './desk/ipc'
import { registerMediaIpc } from './media/ipc'
import { handleBrainMediaProtocol, registerBrainMediaScheme } from './media/protocol'
import { clearMediaTemp } from './media/export'
import { startMediaStatePoll } from './media/state-poll'
import { refreshTray, startTray } from './tray'
import { answerSend, bridgeScriptPath, startBrowserBridge, stopBrowserBridge } from './browser-bridge'
import { closeAllShared, sharedDeskBrowser } from './shared-browser'
import { ensureChatShims, guardScriptPath } from './chat-env'

registerBrainMediaScheme()
registerStubIpc()
registerPtyIpc()
registerUpdateIpc()
registerSkinIpc()
registerFactoryIpc()
registerPhoneIpc()
registerMediaIpc()
registerDeskIpc()
ipcMain.handle('browser:sendAnswer', (_e, owner: string, id: string, yes: boolean) => answerSend(String(id || ''), yes === true, String(owner || '')))

process.on('uncaughtException', (err) => {
  const msg = String((err as NodeJS.ErrnoException).message || err)
  if ((err as NodeJS.ErrnoException).code === 'EPIPE' || msg.includes('EPIPE')) return
  console.error(err)
})
process.on('unhandledRejection', (err) => {
  const msg = String(err)
  if (msg.includes('EPIPE')) return
  console.error(err)
})

let mainWin: BrowserWindow | null = null
let allowQuit = false

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    title: 'Brain',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'followWindow' as const
        }
      : { backgroundColor: '#fffdf9' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true
    }
  })
  mainWin = win
  if (process.platform === 'darwin') {
    win.webContents.on('dom-ready', () => {
      void win.webContents.executeJavaScript("document.documentElement.classList.add('glass')")
    })
  }
  win.on('close', (e) => {
    if (allowQuit) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })

  attachMainLinks(win.webContents, {
    open: (url) => {
      void shell.openExternal(url)
    },
    allow: appAllowList({
      devUrl: process.env.ELECTRON_RENDERER_URL,
      packagedIndex: join(__dirname, '../renderer/index.html')
    })
  })
  installGuestLinkPolicy(win.webContents, (url) => {
    void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL
    const drive = process.env.BRAIN_APP_SETUP_DRIVE === '1'
    win.loadURL(drive ? `${base}${base.includes('?') ? '&' : '?'}setupDrive=1` : base)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function pushHealth(): void {
  void refreshTray().then((h) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('sync:health', h)
  })
}

app.whenReady().then(() => {
  clearMediaTemp()
  handleBrainMediaProtocol()
  if (process.env.BRAIN_CHECK_WINDOW === '1') return
  if (process.env.BRAIN_APP_SETUP_DRIVE === '1') {
    const win = createWindow()
    void import('./setup-drive').then((mod) => mod.runSetupDrive(win))
    return
  }
  recordLaunchVersion()
  createWindow()
  // Before any chat starts: every chat CLI gets this run's brain-browser server and the `open` guard.
  ensureChatShims(guardScriptPath({ resourcesPath: process.resourcesPath, appPath: app.getAppPath() }))
  startBrowserBridge({
    dir: app.getPath('userData'),
    script: bridgeScriptPath({ resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    exec: process.execPath,
    browser: sharedDeskBrowser(),
    onOpened: (owner) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('browser:opened', owner)
    },
    onSendAsk: (ask) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('browser:sendAsk', ask)
    }
  }).catch((e) => console.error('browser bridge', e))
  startTray(() => mainWin)
  pushHealth()
  setInterval(pushHealth, 15_000)
  try {
    startAutoUpdate()
  } catch (e) {
    console.error(e)
  }
  const watching = readWatching()
  const acct = loadAccount()
  const hqFolder = acct?.source === 'hq-sync' ? acct.folder || '' : ''
  const folder = hqFolder || currentBrainFolder() || watching.brainPath || acct?.folder || ''
  if (hqFolder || isHqMiniFolder(folder)) {
    void retargetHqSync(folder)
    if (folder) prewarm('grok', folder)
  } else if (folder) {
    if (readSyncMode(folder) === 'plyntr' && watching.watching && watching.brainPath === folder) {
      setBrainSyncBlockedReason(folder, AB_OWNS_PLYNTR)
    } else {
      startBrainSync(folder)
    }
    prewarm('grok', folder)
  }
  restorePhoneIfWanted()
  startMediaStatePoll()
  app.on('activate', () => {
    if (!mainWin || mainWin.isDestroyed()) createWindow()
    else mainWin.show()
  })
  app.on('browser-window-focus', () => {
    notifySetupBack()
    void import('./media/state-poll').then((mod) => mod.pollMediaState())
  })
})

let quitFlushed = false
let quitStarted = false

function finishQuit(): void {
  if (quitFlushed) return
  quitFlushed = true
  allowQuit = true
  void stopPhone().finally(() => {
    if (isInstallingUpdate()) installDownloadedUpdate()
    else app.quit()
  })
}

app.on('window-all-closed', () => {
  if (!allowQuit) return
  void stopPhone()
  killAllPtys()
  killAllWarm()
  stopBrowserBridge()
  closeAllShared()
})
app.on('before-quit', (e) => {
  allowQuit = true
  clearMediaTemp()
  if (quitFlushed) {
    void stopPhone()
    killAllPtys()
    killAllWarm()
    stopBrowserBridge()
    closeAllShared()
    shutdownFactory()
    return
  }
  if (quitStarted) {
    e.preventDefault()
    return
  }
  const win = mainWin && !mainWin.isDestroyed() ? mainWin : BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    finishQuit()
    return
  }
  quitStarted = true
  e.preventDefault()
  win.webContents.send('app:will-quit')
  setTimeout(() => finishQuit(), 2000)
})

ipcMain.on('app:flush-done', () => {
  finishQuit()
})
