import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { enableDirectoryBucket, type DirectoryBucket } from './dry-worker.ts'
import {
  MEDIA_BRAINS_PATH,
  MEDIA_CODES_EMAIL_PATH,
  MEDIA_INVITES_PATH,
  MEDIA_INVITES_REDEEM_PATH,
  MEDIA_RECLAIM_FINISH_PATH,
  MEDIA_RECLAIM_START_PATH
} from './worker-shapes.ts'

export const R2_HOST = 'r2.cloudflarestorage.com'
export const R2_REFUSE = 'Dry-run refuses Cloudflare R2 URLs.'
export const DRY_ONLY = 'Media worker load is dry-run only in this slice.'
/** brain-sync origin/main Slice 6 merge (PR #5). */
export const MEDIA_V1_TIP = 'cb25c2b0a58cc5553497cf8f50b1f010f8ba2e62'

export const SLICE6_MEDIA_PATHS = [
  MEDIA_CODES_EMAIL_PATH,
  MEDIA_BRAINS_PATH,
  MEDIA_INVITES_PATH,
  MEDIA_INVITES_REDEEM_PATH,
  MEDIA_RECLAIM_START_PATH,
  MEDIA_RECLAIM_FINISH_PATH
] as const

export function isMediaDryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

export function assertNotR2Url(url: string): void {
  if (/r2\.cloudflarestorage\.com/i.test(String(url || ''))) throw new Error(R2_REFUSE)
}

function envSyncRoot(): string {
  return String(process.env.BRAIN_SYNC_ROOT || '').trim()
}

function homeSyncRoot(): string {
  return join(homedir(), 'Projects', 'brain-sync')
}

export function mediaSyncRoot(override?: string): string {
  if (override) return override
  const env = envSyncRoot()
  if (env && existsSync(mediaV1Path(env))) return env
  const home = homeSyncRoot()
  if (existsSync(mediaV1Path(home))) return home
  return join(process.cwd(), 'vendor', 'brain-sync')
}

export async function resolveMediaSyncRoot(override?: string): Promise<string> {
  if (override) return override
  const env = envSyncRoot()
  if (env && existsSync(mediaV1Path(env))) return env
  const home = homeSyncRoot()
  if (existsSync(mediaV1Path(home))) return home
  try {
    const hq = await import('../hq-sync.ts')
    const root = hq.syncRoot()
    if (existsSync(mediaV1Path(root))) return root
  } catch {
    /* vendor copy has no media-v1 until Joe's tree is on this Mac */
  }
  return mediaSyncRoot()
}

export function r2AdminPath(syncRoot: string): string {
  return join(syncRoot, 'src', 'r2-admin.js')
}

export function mediaV1Path(syncRoot: string): string {
  return join(syncRoot, 'src', 'media-v1.js')
}

export function mediaV1SourceHasSlice6(source: string): boolean {
  const text = String(source || '')
  return SLICE6_MEDIA_PATHS.every((path) => text.includes(path))
}

export function readMediaV1Source(syncRoot: string): string | null {
  const v1 = mediaV1Path(syncRoot)
  if (!existsSync(v1)) return null
  return readFileSync(v1, 'utf8')
}

export async function loadMediaV1(syncRoot?: string): Promise<unknown | null> {
  if (!isMediaDryRun()) throw new Error(DRY_ONLY)
  const root = await resolveMediaSyncRoot(syncRoot)
  const v1 = mediaV1Path(root)
  if (!existsSync(v1)) return null
  return import(pathToFileURL(v1).href)
}

export async function loadR2Admin(syncRoot?: string): Promise<never> {
  void syncRoot
  throw new Error('Dry-run never loads r2-admin.')
}

export async function startDryMedia(opts: {
  userData: string
  bucket: string
  syncRoot?: string
}): Promise<{ mediaV1: unknown | null; bucket: DirectoryBucket; syncRoot: string }> {
  if (!isMediaDryRun()) throw new Error(DRY_ONLY)
  assertNotR2Url('brain-media://dry-run')
  const root = await resolveMediaSyncRoot(opts.syncRoot)
  const mediaV1 = await loadMediaV1(root)
  const bucket = enableDirectoryBucket(opts.userData, opts.bucket)
  return { mediaV1, bucket, syncRoot: root }
}
