import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** Account lines from `claude auth status --json`. Never dump the raw JSON. */
export function formatClaudeUsage(status: Record<string, unknown>, cwd: string): string {
  if (status.loggedIn === false) return 'Claude is not signed in on this Mac.'
  const email = String(status.email || '').trim()
  const org = String(status.orgName || '').trim()
  const plan = claudePlanLabel(status)
  const lines = ['Claude account']
  if (plan) lines.push(`Plan: ${plan}`)
  if (email) lines.push(`Email: ${email}`)
  if (org && org !== email) lines.push(`Organization: ${org}`)
  lines.push(
    '',
    'Session limits and billing live on the Claude account, not this chat.',
    'Open: https://claude.ai/settings/usage',
    '',
    `This folder: ${cwd}`
  )
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
