const BAD_KEY = /^(token|seattoken|key|wrap|dek|url)$/i
const BAD_VALUE = /\bpbt_|\bpms_|X-Amz-|r2\.cloudflarestorage\.com|[A-Za-z0-9+/]{43,44}={0,2}/

export const RENDERER_UNSAFE = 'Unsafe media IPC value.'

export function assertRendererSafe(value: unknown): unknown {
  walk(value)
  return value
}

function walk(value: unknown): void {
  if (value == null) return
  if (typeof value === 'number' || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.startsWith('brain-media://')) return
    if (BAD_VALUE.test(value)) throw new Error(RENDERER_UNSAFE)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item)
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BAD_KEY.test(k)) {
        if (k.toLowerCase() === 'url') {
          if (typeof v === 'string' && v.startsWith('brain-media://')) continue
          throw new Error(RENDERER_UNSAFE)
        }
        throw new Error(RENDERER_UNSAFE)
      }
      walk(v)
    }
  }
}
