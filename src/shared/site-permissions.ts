/**
 * What a page in Brain's browser may ask a person for, and what Brain remembers. Pure: browser-ui.ts keeps the store
 * on disk and asks; desk/inapp.ts maps Electron's permission names through `usesAsked`.
 */

export type SiteUse = 'camera' | 'microphone' | 'clipboard'

/** Camera and microphone can be remembered per login and site; clipboard read never is, each read asks again. */
export const REMEMBERED: ReadonlySet<SiteUse> = new Set(['camera', 'microphone'])

/** The uses a permission request asks for. null for anything Brain never puts to a person (it is refused). */
export function usesAsked(permission: string, mediaTypes?: string[]): SiteUse[] | null {
  if (permission === 'clipboard-read') return ['clipboard']
  if (permission !== 'media') return null
  const uses: SiteUse[] = []
  if (mediaTypes?.includes('video')) uses.push('camera')
  if (mediaTypes?.includes('audio')) uses.push('microphone')
  return uses.length ? uses : null
}

/** A page address's origin (scheme, host, port), only for http and https. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Remembered Allows: login (partition) → site → uses. */
export type SiteStore = Record<string, Record<string, SiteUse[]>>

export function remembered(store: SiteStore, partition: string, site: string, use: SiteUse): boolean {
  return REMEMBERED.has(use) && !!store[partition]?.[site]?.includes(use)
}

/** The store with these uses remembered. Only camera and microphone are ever written. */
export function remember(store: SiteStore, partition: string, site: string, uses: SiteUse[]): SiteStore {
  const keep = uses.filter((u) => REMEMBERED.has(u))
  if (!keep.length) return store
  const had = store[partition]?.[site] ?? []
  return { ...store, [partition]: { ...store[partition], [site]: [...new Set([...had, ...keep])].sort() } }
}

export function forget(store: SiteStore, partition: string, site: string): SiteStore {
  if (!store[partition]?.[site]) return store
  const { [site]: _gone, ...rest } = store[partition]
  return { ...store, [partition]: rest }
}

/** Reads a stored file's contents, keeping only well-formed rows. Anything else is an empty store. */
export function parseStore(text: string): SiteStore {
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const out: SiteStore = {}
    for (const [partition, sites] of Object.entries(raw as Record<string, unknown>)) {
      if (!sites || typeof sites !== 'object') continue
      for (const [site, uses] of Object.entries(sites as Record<string, unknown>)) {
        if (!originOf(site) || originOf(site) !== site || !Array.isArray(uses)) continue
        const ok = uses.filter((u): u is SiteUse => typeof u === 'string' && REMEMBERED.has(u as SiteUse))
        if (ok.length) out[partition] = { ...out[partition], [site]: ok }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** One open card per login, site and exact set asked: a camera-only ask never joins a camera-and-microphone card. */
export function cardKey(partition: string, site: string, uses: SiteUse[]): string {
  return `${partition}\n${site}\n${[...uses].sort().join(',')}`
}

/** "camera and microphone", for the card. */
export function usesText(uses: SiteUse[]): string {
  const words = uses.map((u) => (u === 'clipboard' ? 'clipboard' : u))
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}
