import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MAGIC } from './format.ts'

export const CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024

export function cachePath(userData: string, mediaBrainId: string, mediaId: string): string {
  const brain = String(mediaBrainId || '')
  const id = String(mediaId || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(brain)) throw new Error('Bad media brain id.')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Bad media id.')
  return join(userData, 'media', brain, 'cache', `${id}.bin`)
}

export function cipherCacheExists(userData: string, mediaBrainId: string, mediaId: string): boolean {
  return existsSync(cachePath(userData, mediaBrainId, mediaId))
}

export function writeCipherCache(userData: string, mediaBrainId: string, mediaId: string, object: Buffer): string {
  if (!Buffer.isBuffer(object) || object.length < 8 || !object.subarray(0, 8).equals(MAGIC)) {
    throw new Error('Cache only stores ciphertext objects.')
  }
  const path = cachePath(userData, mediaBrainId, mediaId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, object)
  evictCipherCache(userData, { keepPath: path })
  return path
}

export function readCipherCache(userData: string, mediaBrainId: string, mediaId: string): Buffer {
  const path = cachePath(userData, mediaBrainId, mediaId)
  const buf = readFileSync(path)
  touchCipherCache(userData, mediaBrainId, mediaId)
  return buf
}

export function touchCipherCache(userData: string, mediaBrainId: string, mediaId: string): void {
  const path = cachePath(userData, mediaBrainId, mediaId)
  if (!existsSync(path)) return
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    /* */
  }
}

export function deleteCipherCache(userData: string, mediaBrainId: string, mediaId: string): void {
  try {
    unlinkSync(cachePath(userData, mediaBrainId, mediaId))
  } catch {
    /* */
  }
}

export type CacheEntry = { path: string; size: number; mtimeMs: number }

export function listCipherCaches(userData: string): CacheEntry[] {
  const root = join(userData, 'media')
  if (!existsSync(root)) return []
  const out: CacheEntry[] = []
  let brains: string[] = []
  try {
    brains = readdirSync(root)
  } catch {
    return []
  }
  for (const brain of brains) {
    const dir = join(root, brain, 'cache')
    if (!existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.bin')) continue
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (!st.isFile()) continue
        out.push({ path, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* */
      }
    }
  }
  return out
}

export function evictCipherCache(
  userData: string,
  opts?: { limitBytes?: number; keepPath?: string }
): void {
  const limit = opts?.limitBytes ?? CACHE_LIMIT_BYTES
  const keep = opts?.keepPath ? resolve(opts.keepPath) : ''
  const entries = listCipherCaches(userData)
  let total = entries.reduce((sum, e) => sum + e.size, 0)
  if (total <= limit) return
  const ordered = entries.slice().sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
  for (const e of ordered) {
    if (total <= limit) break
    if (keep && resolve(e.path) === keep) continue
    try {
      unlinkSync(e.path)
      total -= e.size
    } catch {
      /* */
    }
  }
}
