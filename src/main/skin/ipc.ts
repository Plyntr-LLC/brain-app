import { BrowserWindow, ipcMain } from 'electron'
import { getAccount } from '../session-token'
import { getSettings } from '../settings-store'
import { isJoeSuperAdmin } from '../super-admin'
import { acpDecidePermission } from '../acp-session'
import {
  captureOn,
  jevOn,
  labelCapture,
  listCaptures,
  onUnmatchedCapture,
  setCaptureOn,
  setJevOn,
  type SkinCapture
} from './capture'
import { SKIN_COMPONENTS } from '../../shared/skin/catalog'
import { getProposal } from './jev-cache'
import { learnUnmatchedCaptures, onCatalogHeal, proposeFromCapture } from './jev'
import { getLearned, listLearned } from './learned'
import { typesafeReady, warmTypesafeKey } from './typesafe'

function joeOnly(): boolean {
  return isJoeSuperAdmin(getAccount(), getSettings())
}

function withProposal(row: SkinCapture) {
  const learned = getLearned(String(row.cli), row.eventKind)
  return {
    ...row,
    jevProposal: getProposal(row.fingerprint),
    catalogId: row.catalogId || learned?.component || null,
    matched: row.matched || Boolean(learned),
    learned: Boolean(learned)
  }
}

onCatalogHeal((row) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('skin:healed', row)
  }
})

onUnmatchedCapture((row) => {
  if (!jevOn()) return
  void proposeFromCapture(row).then(() => startDrain())
})

function startDrain(): void {
  if (!jevOn()) return
  void learnUnmatchedCaptures()
}

export function registerSkinIpc(): void {
  void warmTypesafeKey().then(() => startDrain())
  ipcMain.handle('skin:get', async () => {
    if (joeOnly() && jevOn()) await warmTypesafeKey()
    return {
      capture: joeOnly() && captureOn(),
      jev: joeOnly() && jevOn(),
      jevReady: joeOnly() && typesafeReady(),
      joe: joeOnly(),
      components: [...SKIN_COMPONENTS],
      learned: joeOnly() ? listLearned() : []
    }
  })
  ipcMain.handle('skin:toggle', (_e, on: boolean) => {
    if (!joeOnly()) return { ok: false, capture: false }
    return { ok: true, capture: setCaptureOn(Boolean(on)) }
  })
  ipcMain.handle('skin:toggleJev', async (_e, on: boolean) => {
    if (!joeOnly()) return { ok: false, jev: false, jevReady: false }
    const jev = setJevOn(Boolean(on))
    if (jev) {
      await warmTypesafeKey()
      startDrain()
    }
    return { ok: true, jev, jevReady: typesafeReady() }
  })
  ipcMain.handle('skin:list', () => {
    if (!joeOnly()) return []
    return listCaptures().map(withProposal)
  })
  ipcMain.handle('skin:learn', async () => {
    if (!joeOnly()) return { ok: false, added: 0 }
    if (!jevOn()) return { ok: false, added: 0, detail: 'Jev is off' }
    await warmTypesafeKey()
    const added = await learnUnmatchedCaptures()
    return { ok: true, added, learned: listLearned() }
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
