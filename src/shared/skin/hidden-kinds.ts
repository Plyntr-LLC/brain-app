/** ACP / stream noise — never paint cards or RawFallback for these. */
const HIDDEN = new Set([
  'tool_call_update',
  'session_info_update',
  'model_changed',
  'config_option_update',
  'available_commands_update',
  'current_mode_update',
  'mode_changed',
  'response_started',
  'response_completed',
  'hook_run_started',
  'hook_run_completed',
  'hook_started',
  'hook_completed'
])

export function isHiddenStreamKind(kind: string): boolean {
  const k = String(kind || '')
  if (!k) return false
  if (HIDDEN.has(k)) return true
  if (/^(hook_|response_|turn_|agent_)/.test(k)) return true
  if (/_(started|completed|finished|cancelled)$/.test(k)) return true
  return false
}

/** One-token protocol lines that showed up as chat text. */
export function isProtocolNoise(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (/^\{"(?:jsonrpc|method|id)"/.test(t) && t.length < 400 && !/\n/.test(t)) return true
  if (/\s/.test(t)) return false
  return isHiddenStreamKind(t)
}
