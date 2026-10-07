/**
 * Plain words for a tool call that hands work to another AI or agent, so the chat never shows a bare
 * "Bash" for a ten-minute Grok review. Null when the call is ordinary work.
 */

function flag(cmd: string, name: string): string {
  const m = new RegExp(`--${name}(?:=|\\s+)["']?([\\w.:-]+)`).exec(cmd)
  return m ? m[1] : ''
}

function withRun(who: string, model: string, effort: string): string {
  const parts = [who, model].filter(Boolean).join(' ')
  return effort ? `${parts} (${effort})` : parts
}

const OPUS_REVIEW = 'Opus is reviewing'

/** A tool title that starts a Claude Opus review, with the shell command left off the event. */
function titleStartsReview(text: string): boolean {
  const t = text.trim()
  if (!t || /^(?:Read|Edit|Write|Search|Grep)\b/.test(t)) return false
  if (/[/\\]/.test(t) || /\.[A-Za-z0-9]{1,8}\b/.test(t)) return false
  return /^(?:Start|Run)\b.*\bClaude\b.*\bOpus\b.*\breview/.test(t)
}

/** A shell call that is an Opus review, not an ordinary Opus question. */
export function opusReviewLabel(command: string, title = ''): string | null {
  const cmd = String(command || '')
  const head = String(title || '')
  const opusBin = /(?:^|[\s;&|(]|\/)(?:claude|cursor-agent)(?=\s|$)/.test(cmd) && /--model(?:=|\s+)["']?[^\s"']*opus/i.test(cmd)
  if (opusBin && /\breview/i.test(`${head}\n${cmd}`)) return OPUS_REVIEW
  if (titleStartsReview(head || cmd)) return OPUS_REVIEW
  return null
}

/** The line the chat and the right rail show for background work. */
export function visibleBgLine(tasks: { label: string }[]): string {
  if (!tasks.length) return ''
  const first = tasks[0].label.replace(/^Started in the background: /, '')
  const more = tasks.length > 1 ? ` (+${tasks.length - 1} more)` : ''
  if (first === OPUS_REVIEW) return `${OPUS_REVIEW}${more}`
  return `In the background: ${first}${more}`
}

export type ReviewTask = { id: string; label: string; at: number }

/** Keep an Opus review on the list until its tool call finishes. Null when nothing changed. */
export function nextReviewTasks(
  tasks: ReviewTask[],
  ev: { kind: string; id: string; title: string; command: string; status: string },
  at: number
): ReviewTask[] | null {
  const id = String(ev.id || '')
  const done = /completed|failed|cancelled|canceled|error/i.test(String(ev.status || ''))
  const open = tasks.some((t) => t.id === id)
  if (id && open && done) return tasks.filter((t) => t.id !== id)
  if (ev.kind === 'tool_call' && id && !open && !done && opusReviewLabel(ev.command, ev.title)) {
    return [...tasks, { id, label: OPUS_REVIEW, at }]
  }
  return null
}

/** The AI a shell command talks to, or '' when it talks to none. */
export function agentInCommand(command: string): string {
  const cmd = String(command || '')
  // Only a command word: "grok" at the start or after a pipe, &&, ;, or a path ending in /grok.
  const at = (bin: string) => new RegExp(`(?:^|[\\s;&|(]|/)${bin}(?=\\s|$)`).test(cmd)
  if (at('grok')) {
    const model = flag(cmd, 'model').replace(/^grok-/i, '')
    return withRun('Grok', model, flag(cmd, 'effort'))
  }
  if (at('cursor-agent')) return withRun('Cursor', flag(cmd, 'model'), '')
  if (at('codex')) return withRun('GPT (Codex)', flag(cmd, 'model'), '')
  if (at('claude') && /(?:^|\s)-p(?:\s|$)|--print\b/.test(cmd)) {
    const model = flag(cmd, 'model')
    return withRun('Claude', model ? model[0].toUpperCase() + model.slice(1) : '', flag(cmd, 'effort'))
  }
  return ''
}

/** A Claude tool_use (name + input) as a handoff label, or null. */
export function handoffLabel(name: string, input: unknown): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const tool = String(name || '')
  if (tool === 'Task' || tool === 'Agent') {
    const what = String(i.description || i.subagent_type || 'a task').slice(0, 60)
    return `Subagent: ${what}`
  }
  if (tool === 'SendMessage') return `Messaging ${String(i.to || 'another agent').slice(0, 40)}`
  if (tool === 'Bash') {
    const command = String(i.command || '')
    const title = String(i.description || '')
    const review = opusReviewLabel(command, title)
    if (review) return i.run_in_background ? `Started in the background: ${review}` : review
    const who = agentInCommand(command)
    if (!who) return i.run_in_background ? `Started in the background: ${title.slice(0, 60) || 'a command'}` : null
    return i.run_in_background ? `Started in the background: asking ${who}` : `Asking ${who}`
  }
  return null
}

/** An ACP tool title ("Run grok -p ...") as a handoff label, or null. */
export function handoffFromTitle(title: string): string | null {
  const review = opusReviewLabel(title)
  if (review) return review
  const who = agentInCommand(title)
  return who ? `Asking ${who}` : null
}

/** Skin keeps a handoff or a thinking state. A raw tool name becomes Working. */
export function skinPulseLabel(label: string): string {
  if (
    label === 'Thinking' ||
    label === 'Writing' ||
    label === 'Compacting' ||
    label === 'Picking up background results' ||
    label.startsWith('Asking ') ||
    label.startsWith('Started in the background:') ||
    label.startsWith('Subagent:') ||
    label.startsWith('Messaging ') ||
    label.startsWith('In the background:') ||
    label === OPUS_REVIEW
  ) {
    return label
  }
  return 'Working'
}

export type SkinBgTask = { label: string; at: number }

/**
 * The only Skin pulse. Busy is one handoff on the turn clock. Idle with background tasks is one
 * strip timed from the earliest start. Idle with none is no strip.
 */
export function skinActivity(input: {
  busy: boolean
  waitLabel: string
  waitSec: number
  bgTasks: SkinBgTask[]
  now: number
}): { show: false } | { show: true; label: string; seconds: number } {
  if (input.busy) {
    return { show: true, label: skinPulseLabel(input.waitLabel), seconds: input.waitSec }
  }
  const tasks = input.bgTasks
  if (!tasks.length) return { show: false }
  const at = Math.min(...tasks.map((t) => t.at))
  return {
    show: true,
    label: visibleBgLine(tasks),
    seconds: Math.max(0, Math.floor((input.now - at) / 1000))
  }
}
