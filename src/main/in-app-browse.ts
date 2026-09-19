import { shell } from 'electron'

/**
 * GitHub login (passkeys) does not work in an Electron child window.
 * Open the system browser. Brain keeps polling until they finish.
 */
export function openInApp(url: string, _title = 'GitHub'): { ok: boolean } {
  if (!/^https:\/\//i.test(url)) throw new Error('That is not a web address.')
  void shell.openExternal(url)
  return { ok: true }
}
