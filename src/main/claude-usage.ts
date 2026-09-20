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
