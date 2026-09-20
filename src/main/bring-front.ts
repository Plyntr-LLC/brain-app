import { app, BrowserWindow, clipboard } from 'electron'
import { parseGithubOrgLogin } from './github-repo'

/**
 * Setup steps that leave Brain.app:
 * - GitHub: create a free organization (browser)
 * - GitHub: Install Agency Brain Sync (browser)
 * - Homebrew / Git / Agency Brain / CLI installers (other windows)
 * - AI sign-in (browser or Terminal)
 * We cannot keep those pages inside this window (passkeys, vendor installers).
 * When the step is done, steal focus back here.
 */
export function bringAppFront(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (process.platform === 'darwin') app.dock?.show()
  if (win.isMinimized()) win.restore()
  win.show()
  win.moveTop()
  win.focus()
  app.focus({ steal: true })
}

export function clipOrgLogin(): string {
  try {
    return parseGithubOrgLogin(clipboard.readText())
  } catch {
    return ''
  }
}

export function notifySetupBack(): void {
  const org = clipOrgLogin()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('setup:back', { org })
  }
}
