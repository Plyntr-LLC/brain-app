import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PACK_MAX_EXCERPT, PACK_MAX_FILES } from '../../shared/desk.ts'
import type { ContextFile, ContextPack } from '../../shared/desk.ts'

/**
 * The briefing a worker gets: at most 8 brain files, the first 1,500 characters of each.
 * Missing, outside the brain, under .git/, named .env*, or not text goes into `dropped`.
 * Used for an assign and for paths named on a send.
 */

/** Enough bytes for 1,500 characters of any UTF-8 text, and for the null-byte check. */
const SNIFF_BYTES = 64 * 1024

/** Brain-relative posix path, or null when it is the brain itself or outside it. */
function inside(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

function secret(rel: string): boolean {
  const parts = rel.toLowerCase().split('/')
  return parts.includes('.git') || parts[parts.length - 1].startsWith('.env')
}

function head(abs: string): Buffer {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    return buf.subarray(0, readSync(fd, buf, 0, SNIFF_BYTES, 0))
  } finally {
    closeSync(fd)
  }
}

/** The first 1,500 characters, cut back to the last line break. One long line keeps the hard cut. */
function excerptOf(text: string): string {
  if (text.length <= PACK_MAX_EXCERPT) return text
  const cut = text.slice(0, PACK_MAX_EXCERPT)
  const nl = cut.lastIndexOf('\n')
  return nl < 0 ? cut : cut.slice(0, nl).replace(/\r$/, '')
}

/** `brain` as given checks the named path; `root` (its realpath) checks where a symlink lands. */
function readable(brain: string, root: string, given: string): ContextFile | null {
  const abs = resolve(brain, given)
  const rel = inside(resolve(brain), abs)
  if (!rel || secret(rel)) return null
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return null
  }
  const realRel = inside(root, real)
  if (!realRel || secret(realRel)) return null
  try {
    if (!statSync(real).isFile()) return null
    const buf = head(real)
    if (buf.includes(0)) return null
    return { path: rel, excerpt: excerptOf(buf.toString('utf8')) }
  } catch {
    return null
  }
}

export function packPaths(brain: string, paths: string[], why: string): ContextPack {
  let root: string
  try {
    root = realpathSync(brain)
  } catch {
    return { why, files: [], dropped: paths.slice() }
  }
  const files: ContextFile[] = []
  const dropped: string[] = []
  for (const given of paths) {
    const file = given.trim() ? readable(brain, root, given.trim()) : null
    if (file && files.length < PACK_MAX_FILES) files.push(file)
    else dropped.push(given)
  }
  return { why, files, dropped }
}
