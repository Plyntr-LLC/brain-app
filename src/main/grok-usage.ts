import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resetLabel } from './usage-time.ts'

// Grok TUI `/usage` reads the account allowance from the agent's own `_x.ai/billing` ACP
// extension (the agent calls grok.com with its signed-in login). Brain asks the same warm
// session, so the OAuth token never leaves the Grok process.

type Rec = Record<string, unknown>

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function periodName(type: unknown): string {
  const t = String(type || '').toUpperCase()
  if (t.includes('WEEK')) return 'Weekly'
  if (t.includes('MONTH')) return 'Monthly'
  if (t.includes('DAY')) return 'Daily'
  return ''
}

/** `starting`: the Grok agent is not running yet, or did not finish booting in time. Not an empty account. */
export type GrokAccountRaw = { billing?: unknown; subscription?: unknown; tier?: string; error?: string; starting?: boolean }

export function formatGrokAccount(raw: GrokAccountRaw, opts: { timeZone?: string } = {}): string {
  const billing = rec(raw.billing)
  const config = rec(billing.config)
  const meta = rec(rec(raw.subscription).meta)
  const tier = String(billing.subscription_tier || meta.subscription_tier || raw.tier || '').trim()
  const lines = ['Grok account']
  lines.push(`Plan: ${tier || 'Unknown'}`)

  const pctRaw = config.creditUsagePercent
  const pct = typeof pctRaw === 'number' ? Math.max(0, Math.min(100, Math.round(pctRaw))) : null
  const period = rec(config.currentPeriod)
  const window = periodName(period.type)
  if (pct != null) {
    lines.push(`${window ? `${window} credits` : 'Credits'} used: ${pct}%`)
    lines.push(`Credits left: ${100 - pct}%`)
  }
  const reset = resetLabel(period.end || config.billingPeriodEnd, opts.timeZone)
  if (reset) lines.push(`Resets: ${reset}`)

  // Dollar rows (monthly limit, included and total used, prepaid, pay as you go amounts) stay hidden:
  // the `{ val }` unit is unverified on a nonzero account and could be 100x off.
  const payg = config.onDemandEnabled ?? config.on_demand_enabled
  const cap = Number(rec(config.onDemandCap).val ?? config.onDemandCap)
  if (payg === true || cap > 0) lines.push('Pay as you go: On')
  else if (payg === false || cap === 0) lines.push('Pay as you go: Off')

  const role = String(meta.team_role || '').toLowerCase()
  if (role && !/admin|owner/.test(role)) lines.push('Usage limits are managed by your team.')
  const gate = rec(meta.gate)
  const gateMsg = String(gate.message || gate.gate_message || '').trim()
  if (gateMsg) lines.push(`Notice: ${gateMsg}`)

  if (pct == null && !reset) {
    if (raw.starting) lines.push('Grok is still starting. Try /usage again in a moment.')
    else lines.push(raw.error ? `Could not load the credit meter. ${raw.error}` : 'No billing data available.')
  }
  lines.push('Manage billing: https://grok.com/?_s=usage')
  return lines.join('\n')
}

export type GrokSessionRaw = {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  modelCalls?: number
  costUsdTicks?: number
  turnCount?: number
  primaryModelId?: string
}

/** Output of `grok usage <session-id>` (JSON with a `session` object). */
export function formatGrokSession(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const o = JSON.parse(text.slice(text.indexOf('{'))) as { session?: GrokSessionRaw }
    const s = o.session
    if (!s) return null
    const n = (v?: number) => (v == null ? '' : v.toLocaleString('en-US'))
    const cost = s.costUsdTicks != null ? `$${(Number(s.costUsdTicks) / 1_000_000_000).toFixed(2)}` : ''
    return [
      'This session',
      s.primaryModelId ? `Model: ${s.primaryModelId}` : '',
      s.turnCount != null ? `Turns: ${s.turnCount}` : '',
      s.inputTokens != null ? `Input tokens: ${n(s.inputTokens)}` : '',
      s.outputTokens != null ? `Output tokens: ${n(s.outputTokens)}` : '',
      s.cachedReadTokens != null ? `Cached tokens: ${n(s.cachedReadTokens)}` : '',
      s.reasoningTokens != null ? `Reasoning tokens: ${n(s.reasoningTokens)}` : '',
      s.totalTokens != null ? `Total tokens: ${n(s.totalTokens)}` : '',
      s.modelCalls != null ? `Model calls: ${s.modelCalls}` : '',
      cost ? `Est. cost: ${cost}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return null
  }
}

/** Tier name the Grok CLI caches after sign-in. Only the display string is read. */
export function cachedGrokTier(home = homedir()): string {
  const file = join(home, '.grok', 'settings_cache.json')
  if (!existsSync(file)) return ''
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Rec
    const payload = typeof o.payload === 'string' ? (JSON.parse(o.payload) as Rec) : rec(o.payload)
    return String(rec(payload.settings).subscription_tier_display || '').trim()
  } catch {
    return ''
  }
}

export function grokUsageText(parts: { account: string; session?: string | null; cwd: string }): string {
  return [parts.account, parts.session || '', `This folder: ${parts.cwd}`].filter(Boolean).join('\n\n')
}
