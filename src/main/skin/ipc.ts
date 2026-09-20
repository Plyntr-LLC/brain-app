import { ipcMain } from 'electron'
import { getAccount } from '../session-token'
import { acpDecidePermission } from '../acp-session'
import {
  captureOn,
  jevOn,
  labelCapture,
  listCaptures,
  onUnmatchedCapture,
  setCaptureOn,
  setJevOn
} from './capture'
import { SKIN_COMPONENTS } from '../../shared/skin/catalog'
import { getProposal } from './jev-cache'
import { proposeFromCapture } from './jev'
import { typesafeReady, warmTypesafeKey } from './typesafe'

function joeOnly(): boolean {
  const acct = getAccount()
  return String(acct?.email || '').toLowerCase() === 'joe@plyntr.com'
}

function withProposal<T extends { fingerprint: string }>(row: T) {
  return { ...row, jevProposal: getProposal(row.fingerprint) }
}

onUnmatchedCapture((row) => {
  if (!jevOn()) return
  void proposeFromCapture(row)
})

export function registerSkinIpc(): void {
  void warmTypesafeKey()
  ipcMain.handle('skin:get', async () => {
    if (joeOnly() && jevOn()) await warmTypesafeKey()
    return {
      capture: joeOnly() && captureOn(),
      jev: joeOnly() && jevOn(),
      jevReady: joeOnly() && typesafeReady(),
      joe: joeOnly(),
      components: [...SKIN_COMPONENTS]
    }
  })
  ipcMain.handle('skin:toggle', (_e, on: boolean) => {
    if (!joeOnly()) return { ok: false, capture: false }
    return { ok: true, capture: setCaptureOn(Boolean(on)) }
  })
  ipcMain.handle('skin:toggleJev', async (_e, on: boolean) => {
    if (!joeOnly()) return { ok: false, jev: false, jevReady: false }
    const jev = setJevOn(Boolean(on))
    if (jev) await warmTypesafeKey()
    return { ok: true, jev, jevReady: typesafeReady() }
  })
  ipcMain.handle('skin:list', () => {
    if (!joeOnly()) return []
    return listCaptures().map(withProposal)
  })
  ipcMain.handle('skin:label', (_e, fingerprint: string, label: string) => {
    if (!joeOnly()) return { ok: false }
    return { ok: labelCapture(String(fingerprint || ''), String(label || '')) }
  })
  ipcMain.handle('skin:propose', async (_e, fingerprint: string) => {
    if (!joeOnly()) return { ok: false }
    if (!jevOn()) return { ok: false, detail: 'Jev is off' }
    const fp = String(fingerprint || '')
    const row = listCaptures(500).find((c) => c.fingerprint === fp)
    if (!row) return { ok: false, detail: 'No capture' }
    const proposal = await proposeFromCapture(row, { force: true })
    if (!proposal) return { ok: false, detail: typesafeReady() ? 'Jev skipped this screen' : 'TypeSafe key missing' }
    return { ok: true, proposal }
  })
  ipcMain.handle(
    'skin:decide',
    (_e, payload: { tabId: string; optionId: string }) => {
      return { ok: acpDecidePermission(String(payload?.tabId || ''), String(payload?.optionId || '')) }
    }
  )
}
