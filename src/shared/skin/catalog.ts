export const SKIN_COMPONENTS = [
  'UserMessage',
  'AgentMessage',
  'Thought',
  'ToolCard',
  'WorkPulse',
  'PermissionAsk',
  'Picker',
  'SlashMenu',
  'Plan',
  'ContextMeter',
  'CompactNotice',
  'ErrorNotice',
  'LoginNeed',
  'Queue',
  'RawFallback'
] as const

export type SkinComponentId = (typeof SKIN_COMPONENTS)[number]

export const SKIN_ACTIONS = [
  'prompt',
  'stop',
  'allowOnce',
  'skip',
  'alwaysAllowInFolder',
  'selectOption',
  'runSlash',
  'login',
  'openRaw',
  'attach'
] as const

export type SkinActionId = (typeof SKIN_ACTIONS)[number]

export type SkinRisk = 'low' | 'high'

export const HIGH_RISK_ACTIONS: SkinActionId[] = []

export function actionRisk(id: SkinActionId): SkinRisk {
  if (id === 'alwaysAllowInFolder') return 'high'
  return 'low'
}

export function isSkinComponent(id: string): id is SkinComponentId {
  return (SKIN_COMPONENTS as readonly string[]).includes(id)
}
