/**
 * Factory builder chain: Grok ACP first, Cursor Grok (extra high) when Grok cannot run, Opus when
 * Cursor cannot run either. Grok or Cursor is the grunt; Claude plans and reviews.
 */

/** Both ACP grunts are unusable: the controller runs the Opus builder turn instead (never a failed run). */
export const FACTORY_NEED_OPUS = 'FACTORY_NEED_OPUS'

export function needOpusError(why: string): Error {
  return new Error(`${FACTORY_NEED_OPUS}: ${String(why || 'Grok and Cursor could not run.').slice(0, 300)}`)
}

export function isNeedOpus(e: unknown): boolean {
  return String((e as Error)?.message ?? e ?? '').startsWith(FACTORY_NEED_OPUS)
}

function messageOf(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  const r = err as Record<string, unknown>
  if (typeof r.message === 'string') return r.message
  if (typeof r.error === 'string') return r.error
  return ''
}

/** creditUsagePercent from a bare { creditUsagePercent } or a `_x.ai/billing` record. */
function creditPct(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const r = err as Record<string, unknown>
  const cfg = (((r.billing as Record<string, unknown>)?.config || r.config || r) as Record<string, unknown>) || {}
  const v = cfg.creditUsagePercent
  return typeof v === 'number' ? v : null
}

/** Not unusable: a cancelled turn, a Factory write refusal, or a permission card. */
const NOT_BLOCKED = /\bcancel(?:led|ed)?\b|Factory edits land in the work repo only|Factory runs do not (?:push|use gh)|\bpermission\b|\breject(?:ed)?_?once\b/i

const BLOCKED = [
  /\b(?:weekly|monthly|daily|hourly)\b[^.]{0,60}\b(?:limit|usage|quota|credits?|allowance)\b/i,
  /\b(?:limit|usage|quota|credits?|allowance)\b[^.]{0,40}\b(?:weekly|monthly|daily)\b/i,
  /\bquota\b/i,
  /\busage (?:limit|cap)\b|\busage[^.]{0,20}\b(?:exceeded|exhausted|reached)\b/i,
  /\b(?:credits?|allowance|tokens)\b[^.]{0,20}\b(?:exhausted|used up|depleted|exceeded|ran out|run out)\b/i,
  /\bout of (?:credits?|usage|quota)\b|\bno (?:credits?|usage) (?:left|remaining)\b/i,
  /\b(?:rate|usage) limit(?:ed)?\b|\btoo many requests\b|\b429\b/i,
  /\binsufficient (?:credits?|balance|quota)\b|\bpayment required\b|\b402\b/i,
  /\bis not installed\b|\bENOENT\b|\bcommand not found\b/i,
  /\b(?:not (?:signed|logged) in|sign in (?:again|first|required)|log ?in required|auth(?:entication)? (?:required|failed|expired)|unauthori[sz]ed|\b401\b)/i
]

/** Grok cannot run for this user right now (usage, credits, missing binary, auth). Then Cursor Grok builds. */
export function grokUsageBlocked(err: unknown): boolean {
  const pct = creditPct(err)
  if (pct != null && pct >= 99) return true
  const msg = messageOf(err)
  if (!msg || NOT_BLOCKED.test(msg)) return false
  return BLOCKED.some((re) => re.test(msg))
}

type Cap = { id: string; label: string }

/**
 * The advertised Cursor Grok model for the Grok session's family (4.6 or 4.7, 4.7 when unknown),
 * any Cursor Grok otherwise. Null: Cursor has no Grok model, so it cannot be the grunt.
 */
export function cursorGrokModel(models: Cap[] | undefined, grokModel?: string): string | null {
  const list = (models || []).filter((m) => /cursor[-\s]?grok|^grok/i.test(m.id) || /\bgrok\b/i.test(m.label))
  if (!list.length) return null
  const fam = /4\.6/.test(String(grokModel || '')) ? '4.6' : '4.7'
  const hasFam = (m: Cap, f: string) => m.id.includes(f) || m.label.includes(f) || m.id.includes(f.replace('.', '-'))
  const hit = list.find((m) => hasFam(m, fam)) || list.find((m) => hasFam(m, fam === '4.6' ? '4.7' : '4.6')) || list[0]
  return hit.id
}
