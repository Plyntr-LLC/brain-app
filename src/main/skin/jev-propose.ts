/** Keep in step with `src/shared/skin/catalog.ts` and `hidden-kinds.ts`. Tests run in raw Node. */
const SKIN_COMPONENTS = [
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

type SkinComponentId = (typeof SKIN_COMPONENTS)[number]

const HIDDEN = new Set([
  'tool_call_update',
  'session_info_update',
  'model_changed',
  'config_option_update',
  'available_commands_update',
  'current_mode_update',
  'mode_changed'
])

function isSkinComponent(id: string): id is SkinComponentId {
  return (SKIN_COMPONENTS as readonly string[]).includes(id)
}

function isHiddenStreamKind(kind: string): boolean {
  return HIDDEN.has(kind)
}

/** Conservative. Unmatched stays Raw unless Jev is this sure. */
export const KIND_CONFIDENCE = 0.8
export const PERMISSION_NOUL = 0.55

const PAINT_OK = new Set<SkinComponentId>([
  'UserMessage',
  'AgentMessage',
  'Thought',
  'ToolCard',
  'WorkPulse',
  'Picker',
  'SlashMenu',
  'Plan',
  'ContextMeter',
  'CompactNotice',
  'ErrorNotice',
  'Queue'
])

const KIND_CRITERIA: Record<string, string> = {
  UserMessage: 'The human’s sent text in this turn.',
  AgentMessage: 'The assistant’s reply text.',
  Thought: 'Hidden reasoning or thinking, not the reply.',
  ToolCard: 'A file or tool in use (read, write, search, edit).',
  WorkPulse: 'Live working or busy status while a turn runs.',
  PermissionAsk: 'The CLI is asking Allow / Skip / Always for a path.',
  Picker: 'A model, effort, or mode picker.',
  SlashMenu: 'A list of slash commands.',
  Plan: 'A multi-step plan with titles and statuses.',
  ContextMeter: 'Token or context window usage.',
  CompactNotice: 'Compacting or a compacted-session note.',
  ErrorNotice: 'An error that is not a sign-in prompt.',
  LoginNeed: 'The CLI needs the person to sign in.',
  Queue: 'Queued follow-up messages waiting to send.',
  RawFallback: 'This screen is not a catalog card. Keep it raw.',
  unknown: 'None of the catalog cards fit.'
}

export type JevAnswers = {
  kind?: { choice?: string; confidence?: number }
  is_waiting_for_human?: { noul?: number }
  looks_like_permission?: { noul?: number }
  option_binding?: { choice?: string }
}

export type JevProposal = {
  component: string | null
  confidence: number
  waiting: number
  permission: number
  option: string | null
  paint: boolean
  detail: string
}

export function jevShouldRun(opts: { matched: boolean; eventKind: string }): boolean {
  const kind = String(opts.eventKind || '')
  if (opts.matched) return false
  if (!kind) return false
  if (
    kind === 'text' ||
    kind === 'thought' ||
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'user_message_chunk' ||
    kind === 'done'
  ) {
    return false
  }
  if (isHiddenStreamKind(kind)) return false
  return true
}

export function buildQuestions(optionLabels: string[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    kind: {
      type: 'choice',
      instructions:
        'Which Brain Skin catalog card is this unmatched CLI screen? Copy from the screen. Do not invent a new card. Pick unknown when none fit. Never treat this as permission to Allow a write.',
      criteria: KIND_CRITERIA
    },
    is_waiting_for_human: {
      type: 'noul',
      instructions: 'Is the CLI waiting for a human before it continues?',
      criteria: {
        true: 'A prompt, permission, picker, or login is blocked on a person.',
        false: 'Status, a tool, a plan, or other progress that is not waiting.'
      }
    },
    looks_like_permission: {
      type: 'noul',
      instructions: 'Is this a permission prompt (Allow / Skip / Always for a path or tool)?',
      criteria: {
        true: 'The screen asks the person to allow or skip a file or tool write.',
        false: 'It is not asking for Allow.'
      }
    }
  }
  const labels = uniqLabels(optionLabels)
  if (labels.length) {
    const criteria: Record<string, string> = {
      none: 'No button on this screen should be bound.'
    }
    for (const label of labels) {
      criteria[label] = `The on-screen button labeled ${label}. Copy this label. Do not invent another.`
    }
    questions.option_binding = {
      type: 'choice',
      instructions:
        'If this screen has buttons, which on-screen label is the primary choice? Only pick a label listed in state.options. Never invent Allow, Always, or a new action.',
      criteria
    }
  }
  return questions
}

export function decideProposal(opts: { answers: JevAnswers; optionLabels: string[] }): JevProposal {
  const kind = String(opts.answers.kind?.choice || '')
  const confidence = num(opts.answers.kind?.confidence)
  const waiting = num(opts.answers.is_waiting_for_human?.noul)
  const permission = num(opts.answers.looks_like_permission?.noul)
  const option = copyOption(String(opts.answers.option_binding?.choice || ''), opts.optionLabels)
  const base = { confidence, waiting, permission, option }

  if (!kind || kind === 'unknown' || kind === 'RawFallback') {
    return { ...base, component: kind === 'RawFallback' ? 'RawFallback' : null, paint: false, detail: 'unmatched' }
  }
  if (!isSkinComponent(kind)) {
    return { ...base, component: null, paint: false, detail: 'not in catalog' }
  }
  if (kind === 'PermissionAsk') {
    return {
      ...base,
      component: kind,
      paint: false,
      detail: permission >= PERMISSION_NOUL ? 'permission proposed, not bound' : 'permission low'
    }
  }
  if (kind === 'LoginNeed') {
    return { ...base, component: kind, paint: false, detail: 'propose only' }
  }
  if (confidence < KIND_CONFIDENCE) {
    return { ...base, component: kind, paint: false, detail: 'low confidence' }
  }
  if (!PAINT_OK.has(kind)) {
    return { ...base, component: kind, paint: false, detail: 'no auto paint' }
  }
  return { ...base, component: kind, paint: true, detail: 'catalog hit' }
}

export function shouldLearn(p: JevProposal): boolean {
  return Boolean(p.paint && p.component && isSkinComponent(p.component) && p.component !== 'RawFallback')
}

/** True when drain or live Jev should still look at this unmatched screen. */
export function drainStillOpen(opts: {
  learned: boolean
  matched: boolean
  eventKind: string
  cached?: JevProposal | null
}): boolean {
  if (opts.learned || opts.matched) return false
  if (!jevShouldRun({ matched: false, eventKind: opts.eventKind })) return false
  if (!opts.cached) return true
  return shouldLearn(withCurrentPaintPolicy(opts.cached))
}

/** Recompute paint from the stored choice using today’s policy (Picker/Queue used to be propose-only). */
export function withCurrentPaintPolicy(p: JevProposal): JevProposal {
  return decideProposal({
    answers: {
      kind: { choice: p.component || 'unknown', confidence: p.confidence },
      is_waiting_for_human: { noul: p.waiting },
      looks_like_permission: { noul: p.permission },
      option_binding: p.option ? { choice: p.option } : undefined
    },
    optionLabels: p.option ? [p.option] : []
  })
}

function uniqLabels(labels: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const label = String(raw || '').trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

function copyOption(choice: string, labels: string[]): string | null {
  if (!choice || choice === 'none') return null
  return labels.includes(choice) ? choice : null
}

function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}
