import { callCount, type UsageRow } from '../../shared/factory.ts'

/**
 * Usage rows from what the CLIs print: Claude's `--output-format json` envelope and the Grok CLI's
 * streaming-json `end` event. The model is the one the answer names, never the configured one.
 */

type Counts = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
}
type ModelUsage = Record<string, { costUSD?: number }>
export type ClaudeEnvelope = {
  type?: string
  result?: string
  usage?: Counts
  modelUsage?: ModelUsage
  total_cost_usd?: number
  num_turns?: number
  is_error?: boolean
}
type GrokEnd = { type?: string; usage?: Counts; modelUsage?: ModelUsage; total_cost_usd?: number; num_turns?: number }

export const USAGE_MAX = 200

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The model that did most of the work (highest cost), else the first one named. */
export function servedModel(m: ModelUsage | undefined): string {
  const ids = Object.keys(m || {})
  if (!ids.length) return ''
  return [...ids].sort((a, b) => num(m?.[b]?.costUSD) - num(m?.[a]?.costUSD))[0]
}

export type RowBase = Pick<UsageRow, 'phase' | 'cli' | 'effort' | 'ms'>

export function usageRow(base: RowBase, o: { counts?: Counts; model?: string; costEq?: number; turns?: number; ok: boolean }): UsageRow {
  const c = o.counts
  return {
    ...base,
    model: o.model || '',
    inTokens: num(c?.input_tokens),
    outTokens: num(c?.output_tokens) + num(c?.reasoning_tokens),
    cacheRead: num(c?.cache_read_input_tokens),
    cacheWrite: num(c?.cache_creation_input_tokens),
    costEq: num(o.costEq),
    turns: num(o.turns),
    ok: o.ok,
    at: Date.now()
  }
}

/** The whole stdout as one Claude result envelope, or null. Never a guess from part of it. */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const s = String(stdout || '').trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return null
  try {
    const o = JSON.parse(s) as ClaudeEnvelope
    if (!o || typeof o !== 'object' || typeof o.result !== 'string') return null
    return o
  } catch {
    return null
  }
}

export function claudeRow(base: RowBase, env: ClaudeEnvelope | null): UsageRow {
  if (!env) return usageRow(base, { ok: false })
  return usageRow(base, { counts: env.usage, model: servedModel(env.modelUsage), costEq: env.total_cost_usd, turns: env.num_turns, ok: true })
}

/** The Grok CLI's final `{"type":"end"}` line, if one came. */
export function grokEnd(line: string): GrokEnd | null {
  const t = String(line || '').trim()
  if (!t.startsWith('{') || !t.includes('"end"')) return null
  try {
    const o = JSON.parse(t) as GrokEnd
    return o && o.type === 'end' ? o : null
  } catch {
    return null
  }
}

export function grokRow(base: RowBase, end: GrokEnd | null, ok: boolean): UsageRow {
  if (!end) return usageRow(base, { ok: false })
  return usageRow(base, { counts: end.usage, model: servedModel(end.modelUsage), costEq: end.total_cost_usd, turns: end.num_turns, ok })
}

/** ACP turn usage when the prompt result carries it; tokens stay 0 otherwise. */
export function acpRow(base: RowBase, o: { model?: string; usage?: Record<string, unknown> | null; ok: boolean }): UsageRow {
  const u = o.usage || {}
  const pick = (...keys: string[]) => keys.reduce((n, k) => n || num(u[k]), 0)
  return usageRow(base, {
    counts: {
      input_tokens: pick('input_tokens', 'inputTokens'),
      output_tokens: pick('output_tokens', 'outputTokens'),
      cache_read_input_tokens: pick('cache_read_input_tokens', 'cacheReadInputTokens'),
      cache_creation_input_tokens: pick('cache_creation_input_tokens', 'cacheCreationInputTokens'),
      reasoning_tokens: pick('reasoning_tokens', 'reasoningTokens')
    },
    model: o.model,
    turns: 1,
    ok: o.ok
  })
}

/**
 * Approver calls by the same model in a row fold into one row (turns = calls), so a run with many asks
 * never pushes its build and review rows out of USAGE_MAX.
 */
export function withUsage(rows: UsageRow[] | undefined, row: UsageRow): UsageRow[] {
  const all = rows || []
  const last = all.at(-1)
  if (row.phase !== 'approve') return [...all, row].slice(-USAGE_MAX)
  if (last?.phase !== 'approve' || last.model !== row.model || last.cli !== row.cli) return [...all, { ...row, turns: 1 }].slice(-USAGE_MAX)
  const merged: UsageRow = {
    ...row,
    inTokens: last.inTokens + row.inTokens,
    outTokens: last.outTokens + row.outTokens,
    cacheRead: last.cacheRead + row.cacheRead,
    cacheWrite: last.cacheWrite + row.cacheWrite,
    costEq: last.costEq + row.costEq,
    ms: last.ms + row.ms,
    turns: last.turns + 1
  }
  return [...all.slice(0, -1), merged]
}

export function usageTotals(rows: UsageRow[] | undefined): { tokens: number; ms: number; calls: number; costEq: number } {
  const all = rows || []
  return {
    tokens: all.reduce((n, r) => n + r.inTokens + r.outTokens + r.cacheRead + r.cacheWrite, 0),
    ms: all.reduce((n, r) => n + r.ms, 0),
    calls: callCount(all),
    costEq: all.reduce((n, r) => n + r.costEq, 0)
  }
}
