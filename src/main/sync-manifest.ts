import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brainRowForPath } from './brains'
import { parseSyncManifest, type SyncManifest, type SyncMode } from './sync-manifest-parse'

export type { SyncManifest, SyncMode }
export { parseSyncManifest }

export function readSyncManifest(folder: string): { ok: true; manifest: SyncManifest } | { ok: false; error: string } | null {
  const path = join(String(folder || ''), '.team-config', 'sync.json')
  if (!folder || !existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parseSyncManifest(raw)
  } catch {
    return { ok: false, error: 'This folder’s sync file is not a version this app can use.' }
  }
}

export function readSyncMode(folder: string): SyncMode | null {
  const parsed = readSyncManifest(folder)
  if (parsed?.ok) return parsed.manifest.mode
  const row = brainRowForPath(folder)
  if (row?.syncMode === 'plyntr' || row?.syncMode === 'agency-brain') return row.syncMode
  return null
}

export function syncModesConflict(folder: string): boolean {
  const parsed = readSyncManifest(folder)
  const row = brainRowForPath(folder)
  if (!parsed?.ok || !row?.syncMode) return false
  return parsed.manifest.mode !== row.syncMode
}
