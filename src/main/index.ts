import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { readWatching } from './agency-brain'
import { registerStubIpc } from './ipc-stubs'
import { killAllPtys, registerPtyIpc } from './pty'
import { killAllWarm, prewarm } from './warm'

registerStubIpc()
registerPtyIpc()

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#fffdf9',
    title: 'Brain',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  const watching = readWatching()
  if (watching.brainPath) prewarm('grok', watching.brainPath)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitFlushed = false
let quitStarted = false

app.on('window-all-closed', () => {
  killAllPtys()
  killAllWarm()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', (e) => {
  if (quitFlushed) {
    killAllPtys()
    killAllWarm()
    return
  }
  if (quitStarted) {
    e.preventDefault()
    return
  }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    quitFlushed = true
    killAllPtys()
    killAllWarm()
    return
  }
  quitStarted = true
  e.preventDefault()
  win.webContents.send('app:will-quit')
  setTimeout(() => {
    if (quitFlushed) return
    quitFlushed = true
    app.quit()
  }, 2000)
})

ipcMain.on('app:flush-done', () => {
  if (quitFlushed) return
  quitFlushed = true
  app.quit()
})
