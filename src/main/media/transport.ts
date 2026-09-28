import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { enableDirectoryBucket, type DirectoryBucket } from './dry-worker.ts'

export const R2_HOST = 'r2.cloudflarestorage.com'
export const R2_REFUSE = 'Dry-run refuses Cloudflare R2 URLs.'
export const DRY_ONLY = 'Media worker load is dry-run only in this slice.'

export function isMediaDryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

export function assertNotR2Url(url: string): void {
  if (/r2\.cloudflarestorage\.com/i.test(String(url || ''))) throw new Error(R2_REFUSE)
}

export function mediaSyncRoot(override?: string): string {
  if (override) return override
  return join(process.cwd(), 'vendor', 'brain-sync')
}

export async function resolveMediaSyncRoot(override?: string): Promise<string> {
  if (override) return override
  try {
    const hq = await import('../hq-sync.ts')
    return hq.syncRoot()
  } catch {
    return mediaSyncRoot()
  }
}

export function r2AdminPath(syncRoot: string): string {
  return join(syncRoot, 'src', 'r2-admin.js')
}

export function mediaV1Path(syncRoot: string): string {
  return join(syncRoot, 'src', 'media-v1.js')
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
  const root = await resolveMediaSyncRoot(opts.syncRoot)
  const mediaV1 = await loadMediaV1(root)
  const bucket = enableDirectoryBucket(opts.userData, opts.bucket)
  return { mediaV1, bucket, syncRoot: root }
}
