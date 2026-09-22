import { parseGithubHqRepo } from './github-repo.ts'

export type SyncMode = 'plyntr' | 'agency-brain'

export type SyncManifest = {
  version: 1
  mode: SyncMode
  repo: string
  githubApp: string
  bridgeApp?: string
  createdAt?: string
}

const APP_FOR_MODE: Record<SyncMode, string> = {
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
