import { ipcMain } from 'electron'
import { getAccount } from '../session-token'
import { acpDecidePermission } from '../acp-session'
import { captureOn, labelCapture, listCaptures, setCaptureOn } from './capture'
import { SKIN_COMPONENTS } from '../../shared/skin/catalog'

function joeOnly(): boolean {
  const acct = getAccount()
  return String(acct?.email || '').toLowerCase() === 'joe@plyntr.com'
}

export function registerSkinIpc(): void {
  ipcMain.handle('skin:get', () => ({
    capture: joeOnly() && captureOn(),
    joe: joeOnly(),
    components: [...SKIN_COMPONENTS]
  }))
  ipcMain.handle('skin:toggle', (_e, on: boolean) => {
    if (!joeOnly()) return { ok: false, capture: false }
    return { ok: true, capture: setCaptureOn(Boolean(on)) }
  })
  ipcMain.handle('skin:list', () => {
    if (!joeOnly()) return []
    return listCaptures()
  })
  ipcMain.handle('skin:label', (_e, fingerprint: string, label: string) => {
    if (!joeOnly()) return { ok: false }
    return { ok: labelCapture(String(fingerprint || ''), String(label || '')) }
  })
  ipcMain.handle(
    'skin:decide',
    (_e, payload: { tabId: string; optionId: string }) => {
      return { ok: acpDecidePermission(String(payload?.tabId || ''), String(payload?.optionId || '')) }
    }
  )
}
