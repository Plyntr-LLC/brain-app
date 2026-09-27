// Grok plan approval. In plan mode the agent calls its `exit_plan_mode` tool, which reaches the
// client as the ACP extension request `x.ai/exit_plan_mode` (`_x.ai/…` on the wire). The TUI opens
// its plan approval view. Brain shows an Approve / Keep planning card and answers the request.

type Rec = Record<string, unknown>

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

export const PLAN_APPROVE = 'plan-approve'
export const PLAN_KEEP = 'plan-keep'

export const PLAN_OPTIONS = [
  { id: PLAN_APPROVE, label: 'Approve' },
  { id: PLAN_KEEP, label: 'Keep planning' }
]

export function isExitPlanModeMethod(method: unknown): boolean {
  return /^_?x\.ai\/exit_plan_mode$/.test(String(method || ''))
}

/** Session and plan text from the request params. The plan may be missing; the caller reads plan.md then. */
export function planApprovalAsk(params: unknown): { sessionId: string; plan: string; toolCallId: string } {
  const p = rec(params)
  const plan = [p.planContent, p.plan_content, p.plan].find((v) => typeof v === 'string' && v.trim())
  return {
    sessionId: String(p.sessionId || p.session_id || ''),
    plan: typeof plan === 'string' ? plan : '',
    toolCallId: String(p.toolCallId || p.tool_call_id || '')
  }
}

/**
 * Reply to `x.ai/exit_plan_mode`. Grok 1.0.42's ExitPlanModeExtResponse has two fields: a decision
 * and the feedback text (its TUI shows "Additional feedback:"). The field names are not in the
 * stripped binary's strings, so this sends `approved` plus `outcome` as two decision names; serde
 * ignores the extra field unless deny_unknown_fields. Still unverified against a live plan turn.
 * If the shape is wrong, Grok fails the exit_plan_mode tool call and planToolError shows it.
 * Keep planning sends no feedback: Grok then continues planning and asks what to change.
 */
export function planApprovalReply(approve: boolean, feedback?: string): Rec {
  const note = String(feedback || '').trim()
  return {
    approved: approve,
    outcome: approve ? 'approved' : 'rejected',
    ...(note ? { feedback: note } : {})
  }
}

/** Text from an ACP tool content value: a string, `{ text }`, `{ content }`, or an array of those. */
function flatText(v: unknown, depth = 0): string {
  if (depth > 4 || v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => flatText(x, depth + 1)).filter(Boolean).join('\n')
  const r = rec(v)
  if (typeof r.text === 'string') return r.text
  if (typeof r.error === 'string') return r.error
  if (typeof r.message === 'string') return r.message
  return flatText(r.content, depth + 1)
}

/**
 * A failed `exit_plan_mode` tool update as thread text, else null. Only the plan tool: other tools
 * fail in normal work (a shell exit code) and an error event there would end the turn in the UI.
 * The update may carry no title, so the tool call id from the approval request also counts.
 */
export function planToolError(update: Rec, planToolId?: string): string | null {
  const status = String(update.status || '').toLowerCase()
  if (status !== 'failed' && status !== 'error') return null
  const title = String(update.title || '').trim()
  const id = String(update.toolCallId || update.tool_call_id || '')
  if (!/exit_plan_mode/i.test(title) && !(planToolId && id === planToolId)) return null
  const why = [flatText(update.content), flatText(update.rawOutput)].map((t) => String(t || '').trim()).filter(Boolean).join('\n')
  return `Grok could not leave plan mode (${title || 'exit_plan_mode'} ${status}).${why ? ' ' + why.slice(0, 600) : ''} Plan mode is still on.`
}

export function planDecision(optionId: string): boolean | null {
  if (optionId === PLAN_APPROVE || optionId === 'allowOnce' || optionId === 'alwaysAllowInFolder') return true
  if (optionId === PLAN_KEEP || optionId === 'skip') return false
  return null
}

/**
 * A loaded or resumed session starts with plan mode off. If that session really is in plan mode,
 * Grok says so with `current_mode_update` and the tab turns it back on.
 */
export function clearPlanState(tab: { planMode?: boolean }): void {
  tab.planMode = false
}
