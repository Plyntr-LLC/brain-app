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
    const who = agentInCommand(String(i.command || ''))
    if (!who) return i.run_in_background ? `Started in the background: ${String(i.description || 'a command').slice(0, 60)}` : null
    return i.run_in_background ? `Started in the background: asking ${who}` : `Asking ${who}`
  }
  return null
}

/** An ACP tool title ("Run grok -p ...") as a handoff label, or null. */
export function handoffFromTitle(title: string): string | null {
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
    label.startsWith('In the background:')
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
  const first = tasks[0].label.replace(/^Started in the background: /, '')
  const more = tasks.length > 1 ? ` (+${tasks.length - 1} more)` : ''
  const at = Math.min(...tasks.map((t) => t.at))
  return {
    show: true,
    label: `In the background: ${first}${more}`,
    seconds: Math.max(0, Math.floor((input.now - at) / 1000))
  }
}
