import { app, ipcMain } from 'electron'
import type { MediaAddResult } from '../../shared/media.ts'
import { initShellVault } from '../shell-vault.ts'
import { assertRendererSafe } from './renderer-safe.ts'
import { pollMediaState } from './state-poll.ts'
import {
  MediaErr,
  mediaAdd,
  mediaAllow,
  mediaEnable,
  mediaSetCap,
  mediaSetPassphrase,
  mediaShouldAsk,
  mediaSkip,
  mediaStatus,
  mediaTurnOnBucket,
  revokeMediaDevice,
  takePassphrase,
  takeRecoveryKey
} from './session.ts'

function folderOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && 'folder' in raw) return String((raw as { folder?: string }).folder || '')
  return ''
}

export function registerMediaIpc(): void {
  initShellVault(app.getPath('userData'))
  ipcMain.handle('media:status', async (_e, folder?: string) => {
    const path = String(folder || '')
    if (path) await pollMediaState(path)
    return assertRendererSafe(await mediaStatus(path))
  })
  ipcMain.handle('media:shouldAsk', async (_e, opts?: { folder?: string; role?: string }) => {
    return assertRendererSafe(await mediaShouldAsk({ folder: String(opts?.folder || ''), role: opts?.role }))
  })
  ipcMain.handle('media:skip', (_e, folder?: string) => {
    return assertRendererSafe(mediaSkip(String(folder || '')))
  })
  ipcMain.handle('media:enable', async (_e, opts?: { folder?: string; passphrase?: string }) => {
    return assertRendererSafe(await mediaEnable({ folder: folderOf(opts), passphrase: opts?.passphrase }))
  })
  ipcMain.handle('media:setPassphrase', (_e, opts?: { folder?: string; passphrase?: string }) => {
    return assertRendererSafe(mediaSetPassphrase({ folder: folderOf(opts), passphrase: String(opts?.passphrase || '') }))
  })
  ipcMain.handle('media:takePassphrase', (_e, folder?: string) => takePassphrase(String(folder || '')))
  ipcMain.handle('media:takeRecoveryKey', (_e, folder?: string) => takeRecoveryKey(String(folder || '')))
  ipcMain.handle('media:add', async (_e, opts?: { folder?: string; root?: string; path?: string }) => {
    try {
      const result: MediaAddResult = await mediaAdd({
        folder: folderOf(opts),
        root: String(opts?.root || ''),
        path: opts?.path
      })
      return assertRendererSafe(result)
    } catch (err) {
      if (err instanceof MediaErr) {
        return assertRendererSafe({
          ok: false as const,
          status: err.status,
          error: err.error,
          detail: err.message
        })
      }
      throw err
    }
  })
  ipcMain.handle('media:setCap', (_e, opts?: { folder?: string; capBytes?: number }) => {
    return assertRendererSafe(mediaSetCap({ folder: folderOf(opts), capBytes: Number(opts?.capBytes) }))
  })
  ipcMain.handle('media:turnOnBucket', (_e, folder?: string) => {
    return assertRendererSafe(mediaTurnOnBucket(String(folder || '')))
  })
  ipcMain.handle('media:allow', (_e, opts?: { folder?: string; deviceId?: string }) => {
    return assertRendererSafe(mediaAllow({ folder: folderOf(opts), deviceId: String(opts?.deviceId || '') }))
  })
  ipcMain.handle('media:revokeDevice', (_e, opts?: { folder?: string; deviceId?: string; seatId?: string }) => {
    return assertRendererSafe(
      revokeMediaDevice({
        folder: folderOf(opts),
        deviceId: opts?.deviceId,
        seatId: opts?.seatId
      })
    )
  })
  ipcMain.handle('media:revokeSeat', (_e, opts?: { folder?: string; seatId?: string }) => {
    return assertRendererSafe(revokeMediaDevice({ folder: folderOf(opts), seatId: String(opts?.seatId || '') }))
  })
}
