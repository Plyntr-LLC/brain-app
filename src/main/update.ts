import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

function send(status: string, detail = ''): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:update', { status, detail })
  }
}

export function registerUpdateIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:checkUpdate', async () => {
    if (!app.isPackaged) return { ok: false, detail: 'Dev builds do not update from GitHub.' }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version || '' }
    } catch (e) {
      const detail = String((e as Error).message || e)
      send('error', detail)
      return { ok: false, detail }
    }
  })
  ipcMain.handle('app:installUpdate', () => {
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })
}

export function startAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'Plyntr-LLC',
    repo: 'brain-app'
  })
  autoUpdater.on('checking-for-update', () => send('checking'))
  autoUpdater.on('update-available', (info) => send('available', String(info.version || '')))
  autoUpdater.on('update-not-available', () => send('none'))
  autoUpdater.on('update-downloaded', (info) => send('downloaded', String(info.version || '')))
  autoUpdater.on('error', (err) => send('error', String(err.message || err)))
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 8000)
}
