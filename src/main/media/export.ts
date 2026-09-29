import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { decryptRangeFromPath } from './format.ts'
import { readPointer } from './pointer.ts'
import { prepareMediaPlay } from './session.ts'

/**
 * A stored object as a normal file: decrypt through the viewer's own gate (prepareMediaPlay, so the same
 * approval, revoked, removed, and wrong-project checks) into a temp copy that Open, Save a copy, Put a
 * copy in this folder, and drag all use. Plain copies live only under tmp and are cleared at start and quit.
 */

const CHUNK = 8 * 1024 * 1024

export function mediaTempRoot(): string {
  return join(tmpdir(), 'brain-media-open')
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aiff': 'aiff',
  'application/pdf': 'pdf',
  'application/zip': 'zip'
}

/** One file name, never a path: separators and dot runs are gone, and the extension follows the mime. */
export function safeName(title: string, mime: string): string {
  const base =
    String(title || '')
      .replace(/[/\\:\0]/g, ' ')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 120) || 'file'
  const ext = EXT[String(mime || '').toLowerCase()]
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base
}

export type PointerHit = { path: string; root: string; title: string }

/** The pointer for this object inside the open brain: projects/<p>/media/ or clients/<c>/media/. */
export function findPointer(folder: string, mediaId: string): PointerHit | null {
  for (const top of ['projects', 'clients']) {
    const topDir = join(folder, top)
    if (!existsSync(topDir)) continue
    for (const name of readdirSync(topDir)) {
      if (name.startsWith('.')) continue
      const mediaDir = join(topDir, name, 'media')
      if (!existsSync(mediaDir)) continue
      for (const f of readdirSync(mediaDir)) {
        if (!f.endsWith('.media.md')) continue
        try {
          const p = readPointer(join(mediaDir, f))
          if (p.media_id === mediaId) return { path: join(mediaDir, f), root: join(topDir, name), title: p.title }
        } catch {
          /* not a pointer */
        }
      }
    }
  }
  return null
}

export type Exported = { path: string; name: string; mime: string; bytes: number }

const inflight = new Map<string, Promise<unknown>>()

/**
 * Decrypt to tmp. Always passes the viewer's gate first; a finished copy is reused only after that.
 * One export per object at a time, so tab-open prepare and an Open click never write the same file.
 */
export async function exportMedia(opts: { folder: string; mediaId: string; title?: string }): Promise<Exported> {
  const before = inflight.get(opts.mediaId) || Promise.resolve()
  const mine = before.catch(() => undefined).then(() => exportOnce(opts))
  inflight.set(opts.mediaId, mine)
  try {
    return await mine
  } finally {
    if (inflight.get(opts.mediaId) === mine) inflight.delete(opts.mediaId)
  }
}

async function exportOnce(opts: { folder: string; mediaId: string; title?: string }): Promise<Exported> {
  const prep = await prepareMediaPlay({ folder: opts.folder, mediaId: opts.mediaId })
  try {
    const title = opts.title ?? findPointer(opts.folder, opts.mediaId)?.title ?? opts.mediaId
    const name = safeName(title, prep.mime)
    const dir = join(mediaTempRoot(), opts.mediaId)
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, name)
    if (existsSync(dest) && statSync(dest).size === prep.plainLen) return { path: dest, name, mime: prep.mime, bytes: prep.plainLen }
    const part = `${dest}.part`
    // A .part left by a crash is never finished work; this export owns the only writer now.
    if (existsSync(part)) unlinkSync(part)
    const fd = openSync(part, 'wx')
    try {
      for (let start = 0; start < prep.plainLen; start += CHUNK) {
        const end = Math.min(start + CHUNK, prep.plainLen) - 1
        const bytes = decryptRangeFromPath({ path: prep.cacheFile, mediaId: opts.mediaId, dek: prep.dek, start, end })
        writeSync(fd, bytes)
      }
    } finally {
      closeSync(fd)
    }
    renameSync(part, dest)
    return { path: dest, name, mime: prep.mime, bytes: prep.plainLen }
  } finally {
    prep.dek.fill(0)
  }
}

/** A free name in dir: name.ext, then "name (2).ext", "name (3).ext"... Never an existing file. */
export function freeName(dir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  if (!existsSync(join(dir, name))) return join(dir, name)
  for (let n = 2; ; n++) {
    const p = join(dir, `${stem} (${n})${ext}`)
    if (!existsSync(p)) return p
  }
}

/** Put a normal copy beside its project: the root that holds the pointer's media/ folder. */
export async function copyMediaHere(opts: { folder: string; mediaId: string; title?: string }): Promise<string> {
  const exp = await exportMedia(opts)
  const hit = findPointer(opts.folder, opts.mediaId)
  if (!hit) throw new Error('This file has no note in a project or client folder.')
  const dest = freeName(hit.root, basename(exp.name))
  if (dirname(dest) !== hit.root) throw new Error('That name would leave the project folder.')
  copyFileSync(exp.path, dest)
  return dest
}

export function clearMediaTemp(): void {
  rmSync(mediaTempRoot(), { recursive: true, force: true })
}
