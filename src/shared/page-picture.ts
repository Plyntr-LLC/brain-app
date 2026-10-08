/** A message whose whole text is one http(s) address. Anything else is null. The text is returned unchanged. */
export function onlyWebAddress(text: string): string | null {
  const t = String(text || '').trim()
  if (!/^https?:\/\/\S+$/i.test(t)) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch {
    return null
  }
  return t
}

/** web.whatsapp.com, including a path or a query. A bad address is not WhatsApp. */
export function isWhatsApp(url: string): boolean {
  try {
    return new URL(url).hostname === 'web.whatsapp.com'
  } catch {
    return false
  }
}

/** WhatsApp is one window for the whole app. Every other address uses the place that opened it. */
export function windowKey(owner: string, url?: string): string {
  if (url && isWhatsApp(url)) return 'wa'
  return owner
}

/** A send whose whole text is one web address opens the shared page and shows it small. */
export function pageAfterSend(text: string, at: number): { at: number; view: 'small' } | null {
  if (!onlyWebAddress(text)) return null
  return { at, view: 'small' }
}

export type PicturePoint = { x: number; y: number }
export type PictureBox = { width: number; height: number }

/**
 * A click on the picture, in the picture's content box, mapped onto the page.
 * object-fit is contain: the empty bands around the page are null.
 */
export function mapClick(point: PicturePoint, box: PictureBox, natural: PictureBox): PicturePoint | null {
  if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0) return null
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const contentW = natural.width * scale
  const contentH = natural.height * scale
  const left = (box.width - contentW) / 2
  const top = (box.height - contentH) / 2
  if (point.x < left || point.y < top || point.x > left + contentW || point.y > top + contentH) return null
  return {
    x: Math.round((point.x - left) / scale),
    y: Math.round((point.y - top) / scale)
  }
}
