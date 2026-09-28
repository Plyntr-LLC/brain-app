import { app } from 'electron'
import {
  MEDIA_NEEDS_NET,
  MEDIA_NOT_APPROVED,
  MEDIA_OPEN_FAIL,
  MEDIA_PLAY_NOTES,
  MEDIA_REMOVED,
  MEDIA_WRONG_PROJECT,
  mediaPlayStatus
} from '../../shared/media.ts'
import { currentBrainFolder } from '../brains.ts'
import { MEDIA_OPEN_FAIL as CRYPTO_OPEN_FAIL, assertMediaId } from './crypto.ts'
import { deleteCipherCache, touchCipherCache } from './cache.ts'
import { decryptRangeFromPath } from './format.ts'
import { prepareMediaPlay } from './session.ts'

export { MEDIA_NEEDS_NET, MEDIA_NOT_APPROVED, MEDIA_OPEN_FAIL, MEDIA_REMOVED, MEDIA_WRONG_PROJECT }

export function parseBrainMediaUrl(url: string): string {
  const raw = String(url || '').trim()
  const rest = raw.replace(/^brain-media:\/\//i, '').split(/[?#]/)[0]
  const id = rest.replace(/^\/+/, '').replace(/\/+$/, '')
  return assertMediaId(id)
}

function headerGet(headers: unknown, name: string): string {
  if (!headers) return ''
  if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    return String((headers as { get: (k: string) => string | null }).get(name) || '')
  }
  const rec = headers as Record<string, string | string[] | undefined>
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] || '' : String(v || '')
  }
  return ''
}

function parseRange(header: string): { start: number; end?: number } | null {
  const raw = String(header || '').trim()
  if (!raw) return null
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(raw)
  if (!m) return null
  const start = Number(m[1])
  if (!Number.isInteger(start) || start < 0) return null
  if (m[2] != null && m[2] !== '') {
    const end = Number(m[2])
    if (!Number.isInteger(end)) return null
    return { start, end }
  }
  return { start }
}

export type PlayResult = {
  bytes: Buffer
  mime: string
  total: number
  start: number
  end: number
}

export function playMedia(opts: {
  mediaId: string
  folder?: string
  range?: { start: number; end?: number }
}): PlayResult {
  const folder = String(opts.folder || currentBrainFolder() || '')
  const mediaId = assertMediaId(opts.mediaId)
  const prep = prepareMediaPlay({ folder, mediaId })
  const total = prep.plainLen
  const start = opts.range?.start ?? 0
  const end = opts.range && opts.range.end != null ? opts.range.end : total === 0 ? -1 : total - 1
  try {
    const bytes = decryptRangeFromPath({
      path: prep.cacheFile,
      mediaId,
      dek: prep.dek,
      start,
      end
    })
    touchCipherCache(app.getPath('userData'), prep.mediaBrainId, mediaId)
    return {
      bytes,
      mime: prep.mime,
      total,
      start,
      end: total === 0 ? -1 : Math.min(end, total - 1)
    }
  } catch (err) {
    deleteCipherCache(app.getPath('userData'), prep.mediaBrainId, mediaId)
    const msg = String((err as Error).message || err)
    if (MEDIA_PLAY_NOTES.includes(msg as (typeof MEDIA_PLAY_NOTES)[number]) || msg === MEDIA_REMOVED) throw err
    throw new Error(CRYPTO_OPEN_FAIL)
  } finally {
    prep.dek.fill(0)
  }
}

export async function handleBrainMediaRequest(request: {
  url: string
  method?: string
  headers?: unknown
}): Promise<Response> {
  try {
    const mediaId = parseBrainMediaUrl(request.url)
    const folder = currentBrainFolder()
    const played = playMedia({
      mediaId,
      folder,
      range: parseRange(headerGet(request.headers, 'range')) || undefined
    })
    const method = String(request.method || 'GET').toUpperCase()
    const headers = new Headers()
    headers.set('Content-Type', played.mime || 'application/octet-stream')
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', 'no-store')
    const ranged = Boolean(headerGet(request.headers, 'range'))
    if (ranged) {
      headers.set('Content-Range', `bytes ${played.start}-${played.end}/${played.total}`)
      headers.set('Content-Length', String(played.bytes.length))
      if (method === 'HEAD') return new Response(null, { status: 206, headers })
      return new Response(new Uint8Array(played.bytes), { status: 206, headers })
    }
    headers.set('Content-Length', String(played.bytes.length))
    if (method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(new Uint8Array(played.bytes), { status: 200, headers })
  } catch (err) {
    const message = String((err as Error).message || err)
    const known =
      MEDIA_PLAY_NOTES.includes(message as (typeof MEDIA_PLAY_NOTES)[number]) || message === MEDIA_REMOVED
        ? message
        : MEDIA_OPEN_FAIL
    return new Response(known, {
      status: mediaPlayStatus(known),
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    })
  }
}
