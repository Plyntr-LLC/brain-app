/**
 * Factory triage rules: keywords and counts only (no model). Sizes a task T0..T3 and a risk
 * none / elevated / critical. T3 is allowed (slices, parallel builders). Model triage (triage-llm.ts)
 * may only raise what these rules find.
 */

export type Size = 'T0' | 'T1' | 'T2' | 'T3'
export type Risk = 'none' | 'elevated' | 'critical'

export type Triage = {
  size: Size
  /** Same as size (T3 is no longer capped). Kept for older run records. */
  original: Size
  risk: Risk
  capped: boolean
  reasons: string[]
  ms: number
}

export type TriageHints = { files?: number; lines?: number }

const CRITICAL: [RegExp, string][] = [
  [/\b(payments?|stripe|billing|checkout|invoic\w*|refunds?|subscriptions?|payouts?)\b/i, 'payments'],
  [/\b(auth|authentication|login|log in|sign[- ]?in|passwords?|oauth|sso|2fa|mfa)\b/i, 'auth'],
  [/\b(secrets?|credentials?|api keys?|tokens?|encrypt\w*|decrypt\w*)\b/i, 'secrets'],
  [/\b(migrations?|schema|drop table|alter table|database)\b/i, 'database'],
  [/\bkennel out\b/i, 'Kennel Out'],
  [/\b(delete (all|users?|accounts?)|wipe|purge|gdpr|pii)\b/i, 'user data'],
  [/\b(permissions?|rbac|roles? and access|access control)\b/i, 'access control']
]

const ELEVATED: [RegExp, string][] = [
  [/\b(api|endpoint|webhooks?)\b/i, 'API'],
  [/\b(env|environment variables?|config(uration)?)\b/i, 'config'],
  [/\b(dependency|dependencies|upgrade|npm install|package)\b/i, 'dependencies'],
  [/\b(cache|caching|cron|queue|rate limit\w*)\b/i, 'runtime behavior'],
  [/\b(emails?|sms|notifications?)\b/i, 'outbound messages'],
  [/\b(security|cors|csp|xss|csrf)\b/i, 'security'],
  [/\b(session|cookies?)\b/i, 'sessions']
]

const T3_WORDS = /\b(rewrite|redesign|overhaul|re-?architect\w*|architecture|from scratch|platform|cross[- ]repo|across (repos|repositories|services)|every page|all pages|whole (app|site|codebase)|entire (app|site|codebase)|multi[- ]?slice|migrations?|program)\b/i
const T2_WORDS = /\b(feature|new (page|route|screen|endpoint|api|component|service|table|module)|add support|integrat\w*|dashboard|shared types?|refactor\w*|new dependency|add (a )?library|install|onboarding flow|signup flow|wizard)\b/i
const T0_WORDS = /\b(typos?|spelling|misspel\w*|wording|copy|text|colou?r|font|padding|margin|spacing|label|footer|header|button text|capitali[sz]\w*|punctuation|comma|alt text|link text|css|style)\b/i
const FILE_RE = /\b[\w./-]+\.(tsx?|jsx?|mjs|cjs|css|scss|html?|md|json|ya?ml|py|rb|go|rs|sql|swift|kt|java|php|vue|svelte)\b/gi

export const RANK: Record<Size, number> = { T0: 0, T1: 1, T2: 2, T3: 3 }

function bump(cur: Size, next: Size): Size {
  return RANK[next] > RANK[cur] ? next : cur
}

export function triage(text: string, hints: TriageHints = {}): Triage {
  const t0 = performance.now()
  const body = String(text || '').slice(0, 20_000)
  const reasons: string[] = []
  let risk: Risk = 'none'
  for (const [re, name] of CRITICAL) {
    if (re.test(body)) {
      risk = 'critical'
      reasons.push(`Critical risk: ${name}.`)
    }
  }
  if (risk === 'none') {
    for (const [re, name] of ELEVATED) {
      if (re.test(body)) {
        risk = 'elevated'
        reasons.push(`Elevated risk: ${name}.`)
        break
      }
    }
  }
  const files = new Set((body.match(FILE_RE) || []).map((f) => f.toLowerCase()))
  const fileCount = Math.max(files.size, Number(hints.files || 0))
  let size: Size = 'T1'
  let bigger = false
  if (T3_WORDS.test(body)) {
    size = bump(size, 'T3')
    bigger = true
    reasons.push('Reads like a program (rewrite, migration, cross-repo, or whole app).')
  }
  if (T2_WORDS.test(body)) {
    size = bump(size, 'T2')
    bigger = true
    reasons.push('Reads like a standard feature (new route, API, component, or refactor).')
  }
  if (fileCount > 10) {
    size = bump(size, 'T3')
    bigger = true
    reasons.push(`Names ${fileCount} files.`)
  } else if (fileCount >= 4) {
    size = bump(size, 'T2')
    bigger = true
    reasons.push(`Names ${fileCount} files.`)
  } else if (fileCount >= 2) {
    reasons.push(`Names ${fileCount} files.`)
  }
  const lines = Number(hints.lines || 0)
  if (lines > 150) {
    size = bump(size, 'T2')
    bigger = true
    reasons.push(`About ${lines} lines.`)
  }
  if (body.length > 1500) {
    size = bump(size, 'T2')
    bigger = true
    reasons.push('Long request.')
  }
  const small = T0_WORDS.test(body) && !bigger && fileCount <= 1 && (!lines || lines <= 20) && body.length <= 400
  if (small && size === 'T1') {
    size = 'T0'
    reasons.push('Micro copy or style change in one place.')
  } else if (size === 'T1' && !bigger) {
    reasons.push('Small fix in existing patterns.')
  }
  return { size, original: size, risk, capped: false, reasons, ms: performance.now() - t0 }
}
