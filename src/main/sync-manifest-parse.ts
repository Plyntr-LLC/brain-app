import { parseGithubHqRepo } from './github-repo.ts'

export type FileSyncMode = 'plyntr' | 'agency-brain'
export type SyncMode = FileSyncMode | 'local'

export function asSyncMode(raw: unknown): SyncMode | undefined {
  if (raw === 'plyntr' || raw === 'agency-brain' || raw === 'local') return raw
  return undefined
}

/** This Mac's local choice wins over a sync file that other computers still use. */
export function effectiveSyncMode(
  rowMode: unknown,
  manifest: { ok: true; manifest: SyncManifest } | { ok: false; error: string } | null
): SyncMode | null {
  const row = asSyncMode(rowMode)
  if (row === 'local') return 'local'
  if (manifest?.ok) return manifest.manifest.mode
  if (row === 'plyntr' || row === 'agency-brain') return row
  return null
}

export type SyncManifest = {
  version: 1
  mode: FileSyncMode
  repo: string
  githubApp: string
  bridgeApp?: string
  createdAt?: string
}

const APP_FOR_MODE: Record<FileSyncMode, string> = {
  plyntr: 'plyntr-brain-sync',
  'agency-brain': 'agency-brain-sync'
}

export function parseSyncManifest(
  raw: unknown,
  origin?: string
): { ok: true; manifest: SyncManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'This folder’s sync file is not a version this app can use.' }
  const row = raw as Record<string, unknown>
  if (row.version !== 1) return { ok: false, error: 'This folder’s sync file is not a version this app can use.' }
  const mode = row.mode === 'plyntr' || row.mode === 'agency-brain' ? row.mode : null
  if (!mode) return { ok: false, error: 'This folder’s sync file is not a version this app can use.' }
  const repo = parseGithubHqRepo(String(row.repo || ''))
  if (!repo) return { ok: false, error: 'This folder’s sync file does not match the GitHub repo.' }
  const githubApp = String(row.githubApp || '')
  if (githubApp !== APP_FOR_MODE[mode]) {
    return { ok: false, error: 'This folder’s sync file is not a version this app can use.' }
  }
  if (origin !== undefined) {
    const remote = parseGithubHqRepo(origin)
    if (!remote || remote.toLowerCase() !== repo.toLowerCase()) {
      return { ok: false, error: 'This folder’s sync file does not match the GitHub repo.' }
    }
  }
  return {
    ok: true,
    manifest: {
      version: 1,
      mode,
      repo,
      githubApp,
      bridgeApp: row.bridgeApp ? String(row.bridgeApp) : undefined,
      createdAt: row.createdAt ? String(row.createdAt) : undefined
    }
  }
}
