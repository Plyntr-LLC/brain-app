import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The keychain group Brain keeps Touch ID passkeys in. It must be in the app's signed keychain-access-groups. */
export const PASSKEY_GROUP = 'DWYL4KK53B.com.plyntr.brain.webauthn'

/** True when a codesign entitlements dump lists Brain's passkey group under keychain-access-groups. */
export function hasPasskeyGroup(xml: string): boolean {
  const m = /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  return !!m && m[1].includes(`<string>${PASSKEY_GROUP}</string>`)
}

/** The .app this process runs from, or null in a dev run. */
function bundlePath(): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(app.getPath('exe'))
  return m ? m[1] : null
}

/**
 * Turns on Touch ID passkeys for Brain's browser, only in a packed build whose own signature carries the passkey
 * group (a Developer ID build with the provisioning profile). Anything else would offer a passkey that then fails.
 */
export async function enablePasskeys(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  // Without the page guard nothing would keep an AI-driven page from raising Touch ID prompts.
  if (!existsSync(join(process.resourcesPath, 'page-guard.cjs'))) return false
  const bundle = bundlePath()
  if (!bundle) return false
  const xml = await new Promise<string>((done) => {
    execFile('codesign', ['-d', '--entitlements', '-', '--xml', bundle], { timeout: 10_000 }, (_err, stdout) => done(String(stdout || '')))
  })
  if (!hasPasskeyGroup(xml)) return false
  app.configureWebAuthn({ touchID: { keychainAccessGroup: PASSKEY_GROUP, promptReason: 'sign in to $1' } })
  return true
}
