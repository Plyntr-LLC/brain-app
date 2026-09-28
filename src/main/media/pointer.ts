import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

export const POINTER_KEYS = ['brain_media', 'media_id', 'title', 'mime', 'bytes', 'added'] as const
export type PointerKey = (typeof POINTER_KEYS)[number]

export type MediaPointer = {
  brain_media: 1
  media_id: string
  title: string
  mime: string
  bytes: number
  added: string
}

const SENSITIVE_WORD = /^(salary|salaries|payroll|private)$/i
const KEYISH =
  /(?:[A-Za-z0-9+/_-]{40,}={0,2}|\bpbt_|\bpms_|X-Amz-|\bbm-[a-f0-9])/i

export const POINTER_SCHEMA_FAIL = 'Pointer only holds the six media fields.'
export const POINTER_KEY_FAIL = 'Pointer cannot hold key material.'

export function mediaSlug(title: string): string {
  const words = String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !SENSITIVE_WORD.test(w))
  let s = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!s) s = 'file'
  s = s.slice(0, 48).replace(/-+$/g, '')
  return s || 'file'
}

export function mediaId8(mediaId: string): string {
  const hex = String(mediaId || '').toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length < 8) throw new Error(POINTER_SCHEMA_FAIL)
  return hex.slice(0, 8)
}

export function pointerRelPath(root: string, title: string, mediaId: string): string {
  const base = String(root || '').replace(/\\/g, '/').replace(/\/?$/, '/')
  if (!base || base.includes('..')) throw new Error(POINTER_SCHEMA_FAIL)
  return `${base}media/${mediaSlug(title)}--${mediaId8(mediaId)}.media.md`
}

export function prettyBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(POINTER_SCHEMA_FAIL)
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${Math.round((mb / 1024) * 10) / 10} GB`
}

export function kindLabel(mime: string): string {
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('video/')) return 'Video'
  if (m.startsWith('image/')) return 'Image'
  if (m.startsWith('audio/')) return 'Audio'
  return 'File'
}

function assertNotKeyMaterial(value: string): void {
  if (KEYISH.test(value)) throw new Error(POINTER_KEY_FAIL)
}

function assertPointer(fields: MediaPointer): MediaPointer {
  const keys = Object.keys(fields)
  if (keys.length !== POINTER_KEYS.length || POINTER_KEYS.some((k) => !keys.includes(k))) {
    throw new Error(POINTER_SCHEMA_FAIL)
  }
  for (const k of keys) {
    if (!(POINTER_KEYS as readonly string[]).includes(k)) throw new Error(POINTER_SCHEMA_FAIL)
  }
  if (fields.brain_media !== 1) throw new Error(POINTER_SCHEMA_FAIL)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.media_id)) {
    throw new Error(POINTER_SCHEMA_FAIL)
  }
  if (!String(fields.title || '').trim() || !String(fields.mime || '').trim()) throw new Error(POINTER_SCHEMA_FAIL)
  if (/[\r\n]/.test(fields.title) || /[\r\n]/.test(fields.mime)) throw new Error(POINTER_SCHEMA_FAIL)
  if (!Number.isInteger(fields.bytes) || fields.bytes < 0) throw new Error(POINTER_SCHEMA_FAIL)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.added)) throw new Error(POINTER_SCHEMA_FAIL)
  for (const k of POINTER_KEYS) {
    if (k === 'brain_media' || k === 'bytes') continue
    assertNotKeyMaterial(String(fields[k]))
  }
  return fields
}

export function pointerBody(fields: MediaPointer): string {
  return `${fields.title}. ${kindLabel(fields.mime)}, ${prettyBytes(fields.bytes)}, kept in Plyntr storage. Open it in Brain.app to watch.\n`
}

export function serializePointer(fields: MediaPointer): string {
  const f = assertPointer(fields)
  return [
    '---',
    `brain_media: ${f.brain_media}`,
    `media_id: ${f.media_id}`,
    `title: ${f.title}`,
    `mime: ${f.mime}`,
    `bytes: ${f.bytes}`,
    `added: ${f.added}`,
    '---',
    pointerBody(f)
  ].join('\n')
}

export function parsePointer(text: string): MediaPointer {
  const raw = String(text || '').replace(/^\uFEFF/, '')
  if (!raw.startsWith('---\n')) throw new Error(POINTER_SCHEMA_FAIL)
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(POINTER_SCHEMA_FAIL)
  const fm = raw.slice(4, end)
  const got: Record<string, string> = {}
  for (const line of fm.split('\n')) {
    if (!line) continue
    const colon = line.indexOf(': ')
    if (colon < 1) throw new Error(POINTER_SCHEMA_FAIL)
    const key = line.slice(0, colon)
    const value = line.slice(colon + 2)
    if (!(POINTER_KEYS as readonly string[]).includes(key)) throw new Error(POINTER_SCHEMA_FAIL)
    if (key in got) throw new Error(POINTER_SCHEMA_FAIL)
    got[key] = value
  }
  if (Object.keys(got).length !== POINTER_KEYS.length) throw new Error(POINTER_SCHEMA_FAIL)
  const fields: MediaPointer = {
    brain_media: Number(got.brain_media) as 1,
    media_id: got.media_id,
    title: got.title,
    mime: got.mime,
    bytes: Number(got.bytes),
    added: got.added
  }
  return assertPointer(fields)
}

export function writePointer(opts: {
  folder: string
  root: string
  fields: MediaPointer
}): { rel: string; path: string } {
  const rel = pointerRelPath(opts.root, opts.fields.title, opts.fields.media_id)
  const path = join(opts.folder, ...rel.split(posix.sep))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializePointer(opts.fields), 'utf8')
  return { rel, path }
}

export function readPointer(path: string): MediaPointer {
  return parsePointer(readFileSync(path, 'utf8'))
}
