import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { mediaSlug, readPointer, serializePointer } from './pointer.ts'

/** Files over this size under a project or client go to Plyntr storage even when not media. */
export const AUTO_STORE_MIN_BYTES = 256 * 1024
/** One try per file per minute. */
export const AUTO_STORE_RETRY_MS = 60_000
/** Skip files touched this recently (still copying in). */
export const AUTO_STORE_SETTLE_MS = 30_000

const MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff'
])

/** Brain text stays in git even when large. */
const TEXT_EXT = new Set([
  'md', 'mdx', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'xml', 'svg', 'sql', 'log'
])

const SKIP_PREFIX = 'projects/media-live-check/'

export type AutoStoreCandidate = { rel: string; root: string; path: string; bytes: number; mtimeMs: number }

function ext(rel: string): string {
  const n = basename(rel).toLowerCase()
  const dot = n.lastIndexOf('.')
  return dot > 0 ? n.slice(dot + 1) : ''
}

function norm(rel: string): string {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

/** `projects/foo/bar/baz.mp4` -> `projects/foo/`. Anything outside projects/ or clients/ -> null. */
export function autoStoreRoot(rel: string): string | null {
  const parts = norm(rel).split('/')
  if (parts.length < 3) return null
  if (parts[0] !== 'projects' && parts[0] !== 'clients') return null
  const name = parts[1]
  if (!name || name.startsWith('.') || name === '..') return null
  return `${parts[0]}/${name}/`
}

export function autoStoreSkip(rel: string): boolean {
  const r = norm(rel)
  if (!r || r.startsWith(SKIP_PREFIX)) return true
  const parts = r.split('/')
  if (parts.some((p) => !p || p === '..' || p.startsWith('.') || p === 'node_modules')) return true
  return basename(r).toLowerCase().endsWith('.media.md')
}

export function isMediaFile(rel: string): boolean {
  return MEDIA_EXT.has(ext(rel))
}

export function autoStoreQualifies(rel: string, bytes: number): boolean {
  if (autoStoreSkip(rel) || !autoStoreRoot(rel)) return false
  if (!Number.isFinite(bytes) || bytes <= 0) return false
  if (isMediaFile(rel)) return true
  if (TEXT_EXT.has(ext(rel))) return false
  return bytes > AUTO_STORE_MIN_BYTES
}

/** Title liveAdd writes to the pointer. */
export function autoStoreTitle(rel: string): string {
  return basename(norm(rel)).replace(/\.[^.]+$/, '') || 'file'
}

/** Pointers only keep title + bytes, so that pair is how we know a file is already stored. */
export function pointerDedupeKey(title: string, bytes: number): string {
  return `${mediaSlug(title)}|${bytes}`
}

/** The pointer is written after upload; a title it would refuse must never be uploaded. */
export function pointerTitleOk(title: string): boolean {
  try {
    serializePointer({
      brain_media: 1,
      media_id: '00000000-0000-4000-8000-000000000000',
      title,
      mime: 'application/octet-stream',
      bytes: 0,
      added: '2000-01-01'
    })
    return true
  } catch {
    return false
  }
}

export function pointerKeysForRoot(folder: string, root: string): Set<string> {
  const out = new Set<string>()
  const dir = join(folder, ...root.split('/').filter(Boolean), 'media')
  if (!existsSync(dir)) return out
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (!n.endsWith('.media.md')) continue
    try {
      const p = readPointer(join(dir, n))
      out.add(pointerDedupeKey(p.title, p.bytes))
    } catch {
      /* not a pointer */
    }
  }
  return out
}

/** Walk projects/ and clients/ only. No symlinks. Smallest first so a brain-wide refusal costs little. */
export function scanAutoStore(folder: string, now = Date.now()): AutoStoreCandidate[] {
  const out: AutoStoreCandidate[] = []
  const pointers = new Map<string, Set<string>>()
  const walk = (rel: string): void => {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(join(folder, ...rel.split('/')), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = posix.join(rel, e.name)
      if (autoStoreSkip(child)) continue
      if (e.isDirectory()) {
        walk(child)
        continue
      }
      if (!e.isFile()) continue
      const root = autoStoreRoot(child)
      if (!root) continue
      const path = join(folder, ...child.split('/'))
      let st: import('node:fs').Stats
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (!autoStoreQualifies(child, st.size)) continue
      if (now - st.mtimeMs < AUTO_STORE_SETTLE_MS) continue
      const title = autoStoreTitle(child)
      if (!pointerTitleOk(title)) continue
      let keys = pointers.get(root)
      if (!keys) {
        keys = pointerKeysForRoot(folder, root)
        pointers.set(root, keys)
      }
      if (keys.has(pointerDedupeKey(title, st.size))) continue
      out.push({ rel: child, root, path, bytes: st.size, mtimeMs: st.mtimeMs })
    }
  }
  for (const top of ['projects', 'clients']) {
    if (existsSync(join(folder, top))) walk(top)
  }
  return out.sort((a, b) => a.bytes - b.bytes || a.rel.localeCompare(b.rel))
}

const lastTry = new Map<string, number>()
const brainBackoff = new Map<string, number>()
const running = new Set<string>()

/** Outcomes that hold for every file in this brain, so the rest of the scan waits. */
function brainWide(status: number): boolean {
  return status === 409 || status === 413 || status === 423 || status === 401
}

/**
 * Upload qualifying files under projects/<name>/ and clients/<name>/ to Plyntr storage,
 * then remove the original so git never gets it. Live, owner/scout only.
 */
export async function maybeAutoStore(folder: string, opts: { force?: boolean } = {}): Promise<{ stored: string[] }> {
  const stored: string[] = []
  const f = String(folder || '')
  if (!f || running.has(f)) return { stored }
  const now = Date.now()
  if (opts.force) brainBackoff.delete(f)
  if ((brainBackoff.get(f) || 0) > now) return { stored }
  const session = await import('./session.ts')
  if (!session.mediaAutoStoreReady(f)) return { stored }
  running.add(f)
  try {
    for (const c of scanAutoStore(f, now)) {
      if (now - (lastTry.get(c.path) || 0) < AUTO_STORE_RETRY_MS) continue
      lastTry.set(c.path, Date.now())
      let res
      try {
        res = await session.mediaAdd({ folder: f, root: c.root, path: c.path })
      } catch {
        brainBackoff.set(f, Date.now() + AUTO_STORE_RETRY_MS)
        break
      }
      if (!res.ok) {
        if (brainWide(res.status)) {
          brainBackoff.set(f, Date.now() + AUTO_STORE_RETRY_MS)
          break
        }
        continue
      }
      try {
        const st = lstatSync(c.path)
        if (st.isFile() && st.size === c.bytes && st.mtimeMs === c.mtimeMs) unlinkSync(c.path)
      } catch {
        /* already gone */
      }
      lastTry.delete(c.path)
      stored.push(c.rel)
    }
  } finally {
    running.delete(f)
  }
  return { stored }
}

/** Tests only. */
export function resetAutoStoreState(): void {
  lastTry.clear()
  brainBackoff.clear()
  running.clear()
}
