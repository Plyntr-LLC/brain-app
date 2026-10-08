import type { Activity, RailState } from './activity'
import type { FileHit } from './ptyChat'
import { visibleBgLine } from '../../shared/agent-label'

export const LOG_MAX = 30
const PLACEHOLDERS = new Set(['Working', 'Thinking'])

/** The chat's current action, when it started, and the actions it finished this turn (newest 30). */
export type ActionState = { current?: string; since?: number; log: { at: number; text: string }[] }

/** A new action label. The one it replaces is finished and joins the log; placeholders and repeats change nothing. */
export function nextAction(state: ActionState, label: string, at: number): ActionState {
  const text = label.trim()
  if (!text || PLACEHOLDERS.has(text) || text === state.current) return state
  const log = state.current ? [...state.log, { at: state.since ?? at, text: state.current }].slice(-LOG_MAX) : state.log
  return { current: text, since: at, log }
}

/** The label a file event gives: the tool and the file name, else Reading and the file name. */
export function fileAction(path: string, tool?: string): string {
  const base = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
  return tool ? `${tool} · ${base}` : `Reading ${base}`
}

const STEP: Record<string, RailState> = { completed: 'done', in_progress: 'live' }

/** A later plan may move a step forward. It may not send a finished step back to pending. */
const PLAN_RANK: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 }

/** Keep the steps already on the rail. Update a matching title only when the new status is as far along, and append titles the rail does not have. */
export function mergePlanSteps(
  prev: { title: string; status?: string }[],
  next: { title: string; status?: string }[]
): { title: string; status?: string }[] {
  const out = prev.map((s) => ({ title: s.title, status: s.status }))
  for (const step of next) {
    const title = step.title.trim()
    if (!title) continue
    const i = out.findIndex((s) => s.title.trim() === title)
    if (i < 0) {
      out.push({ title, status: step.status })
      continue
    }
    const oldRank = PLAN_RANK[out[i].status || ''] ?? 0
    const newRank = PLAN_RANK[step.status || ''] ?? 0
    if (newRank >= oldRank) out[i] = { title: out[i].title, status: step.status }
  }
  return out
}

export type BgTask = { label: string; at: number }

/** One line for the CLI's background jobs: the first job, then "(+N more)". */
export function bgLine(bg: BgTask[]): string {
  return visibleBgLine(bg)
}

export function chatActivity(o: {
  busy: boolean
  turnAt: number
  action: ActionState
  permission?: { title?: string } | null
  steps?: { title: string; status?: string }[]
  files: FileHit[]
  bg?: BgTask[]
}): Activity {
  const bg = o.bg || []
  const now: Activity['now'] = o.permission
    ? { text: `Waiting on you: ${o.permission.title || 'a question'}`, tone: 'ask' }
    : o.busy
      ? { text: o.action.current || 'Working', since: o.action.since ?? o.turnAt, tone: 'live' }
      : bg.length
        ? { text: bgLine(bg), since: Math.min(...bg.map((t) => t.at)), tone: 'live' }
        : { text: 'Idle. Waiting for your next message.', tone: 'idle' }
  return {
    now,
    ...(o.steps?.length ? { steps: o.steps.map((s) => ({ title: s.title, state: STEP[s.status || ''] || 'todo' })) } : {}),
    ...(o.action.log.length ? { log: o.action.log } : {}),
    files: o.files,
    filesFolded: true
  }
}
