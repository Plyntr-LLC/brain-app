import { BrowserWindow } from 'electron'

/** GitHub blocks iframes. A child window still keeps them inside Brain. */
export function openInApp(url: string, title = 'GitHub'): { ok: boolean } {
  if (!/^https:\/\//i.test(url)) throw new Error('That is not a web address.')
  const parent = BrowserWindow.getAllWindows()[0]
  const win = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 980,
    height: 740,
    title,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url: next }) => {
    if (!/^https:\/\//i.test(next)) return { action: 'deny' as const }
    return {
      action: 'allow' as const,
      overrideBrowserWindowOptions: {
        parent: win,
        width: 560,
        height: 740,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    }
  })
  void win.loadURL(url)
  return { ok: true }
}
