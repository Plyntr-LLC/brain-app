/** Brain.app Claude start. Not ~/.claude/settings.json (that may be Fable). */

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5'
export const CLAUDE_DEFAULT_EFFORT = 'low'

export function pickClaudeDefaultModel(models: { id: string }[]): string {
  const ids = models.map((m) => String(m.id || '').trim()).filter(Boolean)
  const hit = (re: RegExp) => ids.find((id) => re.test(id))
  return (
    hit(/^(claude-)?opus-5-5(\[|$)/i) ||
    hit(/^(claude-)?opus-5\.5(\[|$)/i) ||
    hit(/^(claude-)?opus-5(\[|$)/i) ||
    hit(/^(claude-)?opus(\[|$)/i) ||
    CLAUDE_DEFAULT_MODEL
  )
}

export function isClaudeDefaultAlias(id: string): boolean {
  const s = String(id || '').trim()
  if (!s) return true
  if (/^(claude-)?opus-5-5(\[|$)/i.test(s) || /^(claude-)?opus-5\.5(\[|$)/i.test(s)) return false
  return /^(claude-)?opus(-5)?(\[|$)/i.test(s) || /^claude-opus-5(\[|$)/i.test(s)
}

/** Keep an explicit pick (Fable, Sonnet, Opus 4). Fill only a missing or default-alias id. */
export function keepClaudeModel(id: string | undefined, list: { id: string; label?: string }[]): string {
  const want = String(id || '').trim()
  if (want && list.some((m) => m.id === want || m.label === want)) return want
  if (want && !isClaudeDefaultAlias(want)) return want
  return list.length ? pickClaudeDefaultModel(list) : want || CLAUDE_DEFAULT_MODEL
}

export function resolveClaudeRun(opts: { model?: string; effort?: string }): { model: string; effort: string } {
  return {
    model: String(opts.model || '').trim() || CLAUDE_DEFAULT_MODEL,
    effort: String(opts.effort || '').trim() || CLAUDE_DEFAULT_EFFORT
  }
}
