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

let orgWatchGen = 0

/** Drop a leftover GitHub-org clipboard poll so it cannot steal focus later. */
export function stopClipboardOrgWatch(): void {
  orgWatchGen += 1
}

/** Poll the clipboard until they copy a GitHub org name, then steal focus back. */
export async function watchClipboardOrg(ms = 180000): Promise<string> {
  const gen = ++orgWatchGen
  const start = clipboard.readText()
  const until = Date.now() + ms
  while (Date.now() < until && gen === orgWatchGen) {
    const now = clipboard.readText()
    if (now !== start) {
      const org = parseGithubOrgLogin(now)
      if (org) {
        bringAppFront()
        notifySetupBack()
        return org
      }
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  if (gen !== orgWatchGen) return ''
  bringAppFront()
  notifySetupBack()
  return clipOrgLogin()
}
