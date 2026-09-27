import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resetLabel } from './usage-time.ts'

function claudePlanLabel(status: Record<string, unknown>): string {
  const sub = String(status.subscriptionType || '')
    .trim()
    .toLowerCase()
  if (sub === 'pro') return 'Claude Pro'
  if (sub === 'max') return 'Claude Max'
  if (sub === 'team') return 'Claude Team'
  if (sub === 'enterprise') return 'Claude Enterprise'
  if (sub) return `Claude ${sub}`
  if (String(status.authMethod || '') === 'claude.ai') return 'Claude account'
  return ''
}

type Rec = Record<string, unknown>

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

/** Reply from `GET https://api.anthropic.com/api/oauth/usage` (the Claude Code TUI `/usage` meter), or why it failed. */
export type ClaudeOAuthRaw = { usage?: unknown; error?: string }

type Meter = { key: string; pct: number; reset: string }

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.floor(n)))
}

// The usage endpoint body reports `utilization` as 0-100 and `resets_at` as ISO. The header-derived
// shape (`unifiedWindows`, camelCase) reports a 0-1 fraction and unix seconds.
function bodyWindow(v: unknown): { pct: number; reset: unknown } | null {
  const w = rec(v)
  const raw = w.used_percentage ?? w.utilization ?? w.percent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return { pct: clampPct(raw), reset: w.resets_at ?? w.resetsAt }
}

function headerWindow(v: unknown): { pct: number; reset: unknown } | null {
  const w = rec(v)
  if (typeof w.used_percentage === 'number') return { pct: clampPct(w.used_percentage), reset: w.resetsAt ?? w.resets_at }
  const raw = w.utilization
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return { pct: clampPct(raw <= 1 ? raw * 100 : raw), reset: w.resetsAt ?? w.resets_at }
}

function modelLabel(v: unknown): string {
  return String(v || '')
    .replace(/[^A-Za-z0-9 .'-]/g, '')
    .trim()
    .slice(0, 20)
}

function money(minor: number, currency: string): string {
  const cur = currency.toUpperCase()
  const n = (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cur === 'USD' || !cur ? `$${n}` : `${n} ${cur}`
}

/** Meter rows for the Claude account popup. Keys end in `used` with a bare percent so the popup draws a meter. */
export function formatClaudeOAuthUsage(usage: unknown, opts: { timeZone?: string } = {}): string[] {
  const body = rec(usage)
  const unified = rec(body.unifiedWindows)
  const limits = Array.isArray(body.limits) ? body.limits.map(rec) : []
  const fromLimits = (kind: string) => bodyWindow(limits.find((r) => r.kind === kind))
  const single = body.rateLimitType ? headerWindow(body) : null

  const session =
    bodyWindow(body.five_hour) ||
    fromLimits('session') ||
    headerWindow(unified.five_hour) ||
    (body.rateLimitType === 'five_hour' ? single : null)
  const weekly =
    bodyWindow(body.seven_day) ||
    fromLimits('weekly_all') ||
    headerWindow(unified.seven_day) ||
    (body.rateLimitType === 'seven_day' ? single : null)

  const meters: Meter[] = []
  const add = (key: string, w: { pct: number; reset: unknown } | null) => {
    if (w) meters.push({ key, pct: w.pct, reset: resetLabel(w.reset, opts.timeZone) })
  }
  add('Session (5-hour)', session)
  add('Weekly (all models)', weekly)
  add('Weekly (Sonnet only)', bodyWindow(body.seven_day_sonnet))
  add('Weekly (Opus only)', bodyWindow(body.seven_day_opus))
  for (const row of limits.filter((r) => r.kind === 'weekly_scoped')) {
    const name = modelLabel(rec(rec(row.scope).model).display_name)
    if (name && !/^(sonnet|opus)( only)?$/i.test(name)) add(`Weekly (${name})`, bodyWindow(row))
  }

  // One reset line per window (Weekly model rows share the weekly reset).
  const out: string[] = []
  const reset = new Set<string>()
  for (const m of meters) {
    out.push(`${m.key} used: ${m.pct}%`)
    const group = m.key.split(' (')[0]
    if (m.reset && !reset.has(group)) {
      reset.add(group)
      out.push(`${group} resets: ${m.reset}`)
    }
  }

  const tight = [session?.pct, weekly?.pct].filter((n): n is number => typeof n === 'number')
  if (tight.length) out.push(`Credits left: ${100 - Math.max(...tight)}%`)

  const extra = rec(body.extra_usage)
  if (extra.is_enabled === false) out.push('Extra usage: Off')
  else if (extra.is_enabled === true) {
    const cur = String(extra.currency || 'USD')
    const used = Number(extra.used_credits)
    const cap = Number(extra.monthly_limit)
    if (Number.isFinite(used) && extra.monthly_limit != null && Number.isFinite(cap) && cap > 0) {
      out.push(`Extra usage: ${money(used, cur)} of ${money(cap, cur)} this month`)
    } else if (Number.isFinite(used)) out.push(`Extra usage: ${money(used, cur)} this month`)
    else out.push('Extra usage: On')
  }
  return out
}

/** Account lines from `claude auth status --json`, plus the account meter from the usage endpoint when given. Never dump the raw JSON. */
export function formatClaudeUsage(
  status: Record<string, unknown>,
  cwd: string,
  oauth?: ClaudeOAuthRaw,
  opts: { timeZone?: string } = {}
): string {
  if (status.loggedIn === false) return 'Claude is not signed in on this Mac.'
  const email = String(status.email || '').trim()
  const org = String(status.orgName || '').trim()
  const plan = claudePlanLabel(status)
  const lines = ['Claude account']
  if (plan) lines.push(`Plan: ${plan}`)
  if (email) lines.push(`Email: ${email}`)
  if (org && org !== email) lines.push(`Organization: ${org}`)
  const meter = oauth?.usage ? formatClaudeOAuthUsage(oauth.usage, opts) : []
  lines.push(...meter)
  if (oauth && !meter.length) {
    lines.push(oauth.error ? `Could not load the usage meter. ${oauth.error}` : 'The usage meter came back empty.')
  }
  if (!meter.length) lines.push('', 'Session limits and billing live on the Claude account, not this chat.')
  lines.push('Open: https://claude.ai/settings/usage', '', `This folder: ${cwd}`)
  return lines.join('\n')
}

type ModelUse = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

/** Totals from Claude Code's own `~/.claude/stats-cache.json` on this Mac. Empty when the cache has nothing. */
export function formatClaudeStats(stats: Record<string, unknown> | null | undefined): string {
  if (!stats || typeof stats !== 'object') return ''
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '')
  const lines = ['This Mac’s Claude Code cache (~/.claude/stats-cache.json)']
  const asOf = String(stats.lastComputedDate || '').trim()
  if (asOf) lines.push(`Updated: ${asOf}`)
  if (n(stats.totalSessions)) lines.push(`Sessions: ${n(stats.totalSessions)}`)
  if (n(stats.totalMessages)) lines.push(`Messages: ${n(stats.totalMessages)}`)
  const byModel = (stats.modelUsage && typeof stats.modelUsage === 'object' ? stats.modelUsage : {}) as Record<
    string,
    ModelUse
  >
  const rows = Object.entries(byModel)
    .map(([model, u]) => {
      const bits = [
        u.inputTokens ? `in ${n(u.inputTokens)}` : '',
        u.outputTokens ? `out ${n(u.outputTokens)}` : '',
        u.cacheReadInputTokens ? `cache read ${n(u.cacheReadInputTokens)}` : '',
        u.cacheCreationInputTokens ? `cache write ${n(u.cacheCreationInputTokens)}` : '',
        u.costUSD && u.costUSD > 0 ? `$${u.costUSD.toFixed(2)}` : ''
      ].filter(Boolean)
      return bits.length ? `${model}: ${bits.join(', ')}` : ''
    })
    .filter(Boolean)
  if (rows.length) lines.push('', 'Tokens by model', ...rows)
  return lines.length > 1 ? lines.join('\n') : ''
}

export function readClaudeStats(home = homedir()): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(home, '.claude', 'stats-cache.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
