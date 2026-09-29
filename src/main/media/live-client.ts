export const MEDIA_ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

export function isLiveR2Url(url: string): boolean {
  try {
    const host = new URL(String(url || '')).host
    return /(^|\.)r2\.cloudflarestorage\.com$/i.test(host)
  } catch {
    return false
  }
}

export type LiveJson = {
  status: number
  json: Record<string, unknown>
}

function headerMap(token?: string, deviceId?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  if (deviceId) h['x-media-device-id'] = deviceId
  return h
}

export async function mediaLiveJson(opts: {
  method: string
  path: string
  token?: string
  deviceId?: string
  body?: unknown
  origin?: string
}): Promise<LiveJson> {
  const origin = String(opts.origin || MEDIA_ORIGIN).replace(/\/+$/, '')
  const headers = headerMap(opts.token, opts.deviceId)
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(`${origin}${opts.path}`, { method: opts.method, headers, body })
  let json: Record<string, unknown> = {}
  const text = await res.text()
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = { error: 'bad json' }
    }
  }
  return { status: res.status, json }
}

export async function mediaLivePut(url: string, bytes: Buffer): Promise<{ status: number; etag: string }> {
  if (!isLiveR2Url(url)) throw new Error('Upload URL is not R2.')
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) })
  const etag = String(res.headers.get('etag') || '').replace(/"/g, '')
  return { status: res.status, etag }
}

export async function mediaLiveGet(url: string): Promise<{ status: number; body: Buffer }> {
  if (!isLiveR2Url(url)) throw new Error('Download URL is not R2.')
  const res = await fetch(url)
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body: buf }
}

export function hexBuf(buf: Buffer): string {
  return buf.toString('hex')
}
