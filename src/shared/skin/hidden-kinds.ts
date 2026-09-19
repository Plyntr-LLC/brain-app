/** ACP / stream noise — never paint cards or RawFallback for these. */
const HIDDEN = new Set([
  'tool_call_update',
  'session_info_update',
  'model_changed',
  'config_option_update',
  'available_commands_update',
  'current_mode_update',
  'mode_changed'
])

export function isHiddenStreamKind(kind: string): boolean {
  return HIDDEN.has(kind)
}
