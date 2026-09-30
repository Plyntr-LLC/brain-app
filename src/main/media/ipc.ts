import { app, BrowserWindow, dialog, ipcMain, shell, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { currentBrainFolder } from '../brains.ts'
import { copyMediaHere, exportMedia } from './export.ts'
import { MEDIA_LIBRARY_FAIL, type MediaAddResult } from '../../shared/media.ts'
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
  mediaLibrary,
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

type MediaFileAsk = { folder?: string; mediaId?: string }

function note(err: unknown): string {
  return String((err as Error)?.message || err || 'Could not open that file.')
}

export function registerMediaIpc(): void {
  initShellVault(app.getPath('userData'))
  // A stored file as a normal file: every path goes through exportMedia, which runs the viewer's gate first.
  const ask = (opts?: MediaFileAsk) => ({ folder: String(opts?.folder || currentBrainFolder() || ''), mediaId: String(opts?.mediaId || '') })
  // A drag is armed when the tab opens and again on mousedown (each time the full gate and export run),
  // and started synchronously on dragstart: macOS only takes a file during the drag the OS already
  // began, so that handler cannot await. A re-arm never clears the ready slot first; a refused gate does.
  const armed = new Map<string, { path: string; icon: NativeImage; until: number }>()
  const arm = async (a: { folder: string; mediaId: string }) => {
    try {
      const exp = await exportMedia(a)
      const icon = await app.getFileIcon(exp.path, { size: 'normal' })
      armed.set(a.mediaId, { path: exp.path, icon, until: Date.now() + 120_000 })
      return { ok: true as const }
    } catch (err) {
      armed.delete(a.mediaId)
      return { ok: false as const, detail: note(err) }
    }
  }
  ipcMain.handle('media:prepare', (_e, opts?: MediaFileAsk) => arm(ask(opts)))
  ipcMain.handle('media:armDrag', (_e, opts?: MediaFileAsk) => arm(ask(opts)))
  ipcMain.handle('media:open', async (_e, opts?: MediaFileAsk) => {
    try {
      const exp = await exportMedia(ask(opts))
      const err = await shell.openPath(exp.path)
      return err ? { ok: false as const, detail: err } : { ok: true as const, name: exp.name }
    } catch (e) {
      return { ok: false as const, detail: note(e) }
    }
  })
  ipcMain.handle('media:saveCopy', async (e, opts?: MediaFileAsk) => {
    try {
      const exp = await exportMedia(ask(opts))
      const win = BrowserWindow.fromWebContents(e.sender)
      const pick = { defaultPath: join(homedir(), 'Downloads', exp.name) }
      const r = win ? await dialog.showSaveDialog(win, pick) : await dialog.showSaveDialog(pick)
      if (r.canceled || !r.filePath) return { ok: false as const, canceled: true }
      copyFileSync(exp.path, r.filePath)
      return { ok: true as const, path: r.filePath }
    } catch (err) {
      return { ok: false as const, detail: note(err) }
    }
  })
  ipcMain.handle('media:copyHere', async (_e, opts?: MediaFileAsk) => {
    try {
      return { ok: true as const, path: await copyMediaHere(ask(opts)) }
    } catch (err) {
      return { ok: false as const, detail: note(err) }
    }
  })
  ipcMain.on('media:startDrag', (e, opts?: MediaFileAsk) => {
    const id = ask(opts).mediaId
    const hit = armed.get(id)
    armed.delete(id)
    if (!hit || hit.until < Date.now() || !existsSync(hit.path)) return
    e.sender.startDrag({ file: hit.path, icon: hit.icon })
  })
  ipcMain.handle('media:status', async (_e, folder?: string) => {
    const path = String(folder || '')
    // Live status already joins and wraps for anyone waiting.
    if (path && isMediaDryRun()) await pollMediaState(path)
    return assertRendererSafe(await mediaStatus(path))
  })
  // The stored-file list. A failure stays a line in the library tab; it never changes media status.
  ipcMain.handle('media:library', async (_e, opts?: { folder?: string }) => {
    try {
      return assertRendererSafe(await mediaLibrary(folderOf(opts) || currentBrainFolder() || ''))
    } catch {
      return { ok: false as const, detail: MEDIA_LIBRARY_FAIL }
    }
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
