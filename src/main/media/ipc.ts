import { app, ipcMain } from 'electron'
import type { MediaAddResult } from '../../shared/media.ts'
import { initShellVault } from '../shell-vault.ts'
import { assertRendererSafe } from './renderer-safe.ts'
import { pollMediaState } from './state-poll.ts'
import { isMediaDryRun } from './transport.ts'
import {
  MediaErr,
  liveInvitePerson,
  liveMediaAllow,
  liveReclaimOnThisMac,
  liveRenameDevice,
  liveRevokeDevice,
  liveRequestMediaCode,
  mediaAdd,
  mediaAllow,
  mediaRenameDevice,
  mediaEnable,
  mediaSetCap,
  mediaSetPassphrase,
  mediaShouldAsk,
  mediaSkip,
  mediaStatus,
  mediaTurnOnBucket,
  mintPmsInvite,
  reclaimOnThisMac,
  requestMediaEmailCode,
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
    // Live status already joins and wraps for anyone waiting.
    if (path && isMediaDryRun()) await pollMediaState(path)
    return assertRendererSafe(await mediaStatus(path))
  })
  ipcMain.handle('media:shouldAsk', async (_e, opts?: { folder?: string; role?: string }) => {
    return assertRendererSafe(await mediaShouldAsk({ folder: String(opts?.folder || ''), role: opts?.role }))
  })
  ipcMain.handle('media:skip', (_e, folder?: string) => {
    return assertRendererSafe(mediaSkip(String(folder || '')))
  })
  ipcMain.handle(
    'media:enable',
    async (_e, opts?: { folder?: string; passphrase?: string; recoveryKey?: string; email?: string; code?: string }) => {
      return assertRendererSafe(
        await mediaEnable({
          folder: folderOf(opts),
          passphrase: opts?.passphrase,
          recoveryKey: opts?.recoveryKey,
          email: opts?.email,
          code: opts?.code
        })
      )
    }
  )
  ipcMain.handle('media:setPassphrase', async (_e, opts?: { folder?: string; passphrase?: string }) => {
    return assertRendererSafe(
      await mediaSetPassphrase({ folder: folderOf(opts), passphrase: String(opts?.passphrase || '') })
    )
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
  ipcMain.handle('media:setCap', async (_e, opts?: { folder?: string; capBytes?: number }) => {
    return assertRendererSafe(await mediaSetCap({ folder: folderOf(opts), capBytes: Number(opts?.capBytes) }))
  })
  ipcMain.handle('media:turnOnBucket', async (_e, folder?: string) => {
    return assertRendererSafe(await mediaTurnOnBucket(String(folder || '')))
  })
  ipcMain.handle('media:allow', async (_e, opts?: { folder?: string; deviceId?: string }) => {
    const args = { folder: folderOf(opts), deviceId: String(opts?.deviceId || '') }
    return assertRendererSafe(isMediaDryRun() ? mediaAllow(args) : await liveMediaAllow(args))
  })
  ipcMain.handle('media:renameDevice', async (_e, opts?: { folder?: string; deviceId?: string; label?: string }) => {
    const args = { folder: folderOf(opts), deviceId: String(opts?.deviceId || ''), label: String(opts?.label || '') }
    return assertRendererSafe(isMediaDryRun() ? mediaRenameDevice(args) : await liveRenameDevice(args))
  })
  ipcMain.handle('media:revokeDevice', async (_e, opts?: { folder?: string; deviceId?: string; seatId?: string; passphrase?: string }) => {
    // Live: an owner or scout removes one computer without a passphrase. Emergency restore keeps the passphrase.
    if (!isMediaDryRun() && opts?.deviceId && !opts?.passphrase) {
      return assertRendererSafe(await liveRevokeDevice({ folder: folderOf(opts), deviceId: String(opts.deviceId) }))
    }
    return assertRendererSafe(
      revokeMediaDevice({
        folder: folderOf(opts),
        deviceId: opts?.deviceId,
        seatId: opts?.seatId,
        passphrase: opts?.passphrase
      })
    )
  })
  ipcMain.handle('media:revokeSeat', (_e, opts?: { folder?: string; seatId?: string }) => {
    return assertRendererSafe(revokeMediaDevice({ folder: folderOf(opts), seatId: String(opts?.seatId || '') }))
  })
  ipcMain.handle('media:requestCode', async (_e, opts?: { email?: string }) => {
    const email = String(opts?.email || '')
    const ok = isMediaDryRun() ? requestMediaEmailCode(email).status === 200 : await liveRequestMediaCode(email)
    return assertRendererSafe({ ok, detail: ok ? 'Code sent.' : 'Could not send a code.' })
  })
  ipcMain.handle(
    'media:reclaim',
    async (_e, opts?: { folder?: string; email?: string; code?: string; passphrase?: string; recovery?: string }) => {
      if (!isMediaDryRun()) {
        const res = await liveReclaimOnThisMac({
          folder: folderOf(opts),
          email: String(opts?.email || ''),
          code: String(opts?.code || ''),
          passphrase: opts?.passphrase,
          recovery: opts?.recovery
        })
        return assertRendererSafe({ ok: res.ok, fingerprint: res.fingerprint, detail: res.detail })
      }
      const result = reclaimOnThisMac({
        folder: folderOf(opts),
        email: String(opts?.email || ''),
        code: String(opts?.code || ''),
        passphrase: opts?.passphrase,
        recovery: opts?.recovery
      })
      return assertRendererSafe({
        ok: result.ok,
        fingerprint: result.fingerprint,
        detail: result.detail
      })
    }
  )
  ipcMain.handle('media:invitePerson', async (_e, opts?: { folder?: string; email?: string; role?: string }) => {
    if (!isMediaDryRun()) {
      return assertRendererSafe(
        await liveInvitePerson({ folder: folderOf(opts), email: String(opts?.email || ''), role: opts?.role })
      )
    }
    const minted = mintPmsInvite({
      folder: folderOf(opts),
      email: String(opts?.email || ''),
      role: opts?.role
    })
    return assertRendererSafe({
      ok: minted.status === 200,
      detail: minted.status === 200 ? 'Invite sent.' : 'Could not add that person.'
    })
  })
}
