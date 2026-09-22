import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brainRowForPath } from './brains'
import { parseSyncManifest, type SyncManifest, type SyncMode } from './sync-manifest-parse'

export type { SyncManifest, SyncMode }
export { parseSyncManifest }

function gitOrigin(folder: string): string {
  try {
    return execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

export function readSyncManifest(folder: string): { ok: true; manifest: SyncManifest } | { ok: false; error: string } | null {
  const path = join(String(folder || ''), '.team-config', 'sync.json')
  if (!folder || !existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const origin = gitOrigin(folder)
    if (!origin) return { ok: false, error: 'This folder’s sync file does not match the GitHub repo.' }
    return parseSyncManifest(raw, origin)
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
