/** Chat default for Grok (Joe’s TUI stays extra high). */
export const GROK_DEFAULT_EFFORT = 'high'

export function defaultEffort(kind?: string): string | undefined {
  if (kind === 'cursor') return undefined
  if (kind === 'claude') return 'low'
  if (kind === 'grok' || kind === 'gpt') return GROK_DEFAULT_EFFORT
  return GROK_DEFAULT_EFFORT
}

export function normalizeEffort(id?: string): string | undefined {
  if (!id) return undefined
  const k = id.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
  if (k === 'extra-high' || k === 'x-high' || k === 'extra') return 'xhigh'
  return k
}

export function prettyEffort(id?: string, kind?: string): string {
  const k = normalizeEffort(id) || defaultEffort(kind)
  if (!k) return 'High'
  const map: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max'
  }
  return map[k] || k
}

/** Restore a saved tab’s effort. Keep an explicit pick, including high. */
export function hydrateEffort(kind: string | undefined, saved?: string): string | undefined {
  if (kind === 'cursor') return undefined
  const have = normalizeEffort(saved)
  if (have) return have
  return defaultEffort(kind)
}
