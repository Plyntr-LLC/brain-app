function prettyClaudeLabel(id: string, hint?: string): string {
  const named = String(hint || '').trim()
  if (named) return named
  const s = String(id || '')
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/i, '')
  const bits = s.split('-').filter(Boolean)
  if (!bits.length) return id
  const family = bits[0].charAt(0).toUpperCase() + bits[0].slice(1)
  const rest = bits.slice(1).join('.')
  return rest ? `${family} ${rest}` : family
}

function claudeId(raw: string): string {
  const id = String(raw || '').trim()
  if (!id) return ''
  if (id.startsWith('claude-') || /^(fable|opus|sonnet|haiku)(\[|$)/i.test(id)) return id
  return `claude-${id}`
}

function pushClaude(
  out: { id: string; label: string }[],
  seen: Set<string>,
  raw: string,
  label?: string
): void {
  const id = claudeId(raw)
  if (!id || seen.has(id)) return
  seen.add(id)
  out.push({ id, label: prettyClaudeLabel(id, label) })
}

function helpAliases(help: string): string[] {
  const out: string[] = []
  const quoted = [...String(help || '').matchAll(/'([a-z][a-z0-9.-]+)'/gi)].map((m) => m[1])
  for (const id of quoted) {
    if (/^(fable|opus|sonnet|haiku)([.-]|$)/i.test(id) || id.startsWith('claude-')) out.push(id)
  }
  return out
}

function growthbookModels(cache: Record<string, unknown> | null): string[] {
  const gb = cache?.cachedGrowthBookFeatures
  if (!gb || typeof gb !== 'object') return []
  const raw = (gb as Record<string, unknown>).tengu_curious_tower_stateless_models
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(raw)) return raw.map((s) => String(s || '').trim()).filter(Boolean)
  return []
}

/** Claude models this Mac's plan actually lists. Never Grok. */
export function claudeModelsFromCache(
  cache: Record<string, unknown> | null,
  extra?: { help?: string; settingsModel?: string }
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const seen = new Set<string>()
  const extras = Array.isArray(cache?.additionalModelOptionsCache)
    ? (cache?.additionalModelOptionsCache as { value?: string; label?: string }[])
    : []
  for (const row of extras) {
    if (row?.value) pushClaude(out, seen, String(row.value), String(row.label || ''))
  }
  for (const slug of growthbookModels(cache)) pushClaude(out, seen, slug)
  const gb = cache?.cachedGrowthBookFeatures
  const notes = gb && typeof gb === 'object' ? JSON.stringify((gb as Record<string, unknown>).tengu_startup_announcements || '') : ''
  if (/Opus 5\.5/i.test(notes)) pushClaude(out, seen, 'claude-opus-5-5', 'Opus 5.5')
  const setting = String(extra?.settingsModel || '').trim()
  if (setting) pushClaude(out, seen, setting)
  for (const alias of helpAliases(String(extra?.help || ''))) pushClaude(out, seen, alias)
  return out
}
