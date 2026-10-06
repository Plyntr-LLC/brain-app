/**
 * Factory composer. Doors run in the app; case and closing punctuation do not matter, and a paused run
 * restarts on Joe's own words. Everything else goes to one Grok session for this run, one answer at a
 * time. That session watches the run. Its TELL reaches the builder when Joe's sentence is not a question.
 */

import type { RunRecord } from '../../shared/factory.ts'
import {
  appendSentNote,
  conductorBridge,
  decideRun,
  getRun,
  guideRun,
  holdName,
  namedRepoFor,
  pauseRun,
  queueInject,
  resumeRun,
  rewriteGuideAck,
  setRunOverride,
  shipRun,
  statusReport,
  taskRepoOf,
  type Decision,
  type OverrideBoundary
} from './controller.ts'
import { currentBranch } from './git-audit.ts'
import { realish } from './paths.ts'
import { TERMINAL_PHASES } from './run-store.ts'

const NOT_SENT = 'I did not send that to the factory.'
const NO_ANSWER = 'I could not get an answer, so nothing was sent to the run.'
const TASK_CHARS = 1500
const warmed = new Set<string>()

export function conductorPrompt(run: RunRecord, text: string): string {
  const guide = (run.guide || []).map((g) => ({ text: g.text, ack: g.ack || '', sent: !!g.sent }))
  const branch = run.workRepo ? currentBranch(run.workRepo) || '' : ''
  return [
    'You watch this factory run. Answer Joe in sentences using the card below. Do not edit files. Do not set the phase.',
    'Answer from this card. Do not run commands or open files.',
    'If Joe asked to add, change, redirect, restart, or instead do something, end with one line FACTORY_TELL: and the instruction. To move the run to another repo, the instruction names its full path. Otherwise do not write FACTORY_TELL.',
    'A push to a branch a host builds (Vercel, Railway, Netlify) can deploy it. Never say a push will not deploy.',
    `workRepo: ${run.workRepo}`,
    `taskRepo: ${taskRepoOf(run)}`,
    `task: ${JSON.stringify(String(run.task || '').slice(0, TASK_CHARS))}`,
    `shipThrough: ${run.shipThrough ? `on, Brain pushes ${branch || 'this branch'} after a clean Opus review` : 'off'}`,
    `phase: ${run.phase}`,
    `tier: ${run.tier}`,
    `risk: ${run.risk}`,
    `live: ${JSON.stringify(run.live || [])}`,
    `reviewCycles: ${run.reviewCycles || 0}`,
    `voiceCycles: ${run.voiceCycles || 0}`,
    `hold: ${holdName(run)}`,
    `error: ${run.error || ''}`,
    `override: ${JSON.stringify(run.override || {})}`,
    `strict: ${run.strict?.status || ''}`,
    `voice: ${run.voice?.status || ''}`,
    `needsProceed: ${run.needsProceed ? 'yes' : ''}`,
    `suggest: ${run.tripwire?.suggest || ''}`,
    `guide: ${JSON.stringify(guide)}`,
    `Joe: ${text}`
  ].join('\n')
}

type Intent = 'ask' | 'inject' | 'ship' | 'pause' | 'resume' | 'review-on' | 'review-off' | 'voice-on' | 'tier-on' | 'proceed-on' | 'approve-plan'

const INJECT_RE = /we forgot|add it to the run|add this to the (?:run|plan)|put this in the (?:run|plan)|guide the run/i
const CHANGE_RE = /\b(add|change|redirect|instead)\b/i
// Joe's words for "start it again" (run-ae98e1f8: unpause, restart, get it started).
const RESTART_RE =
  /\b(?:resum(?:e|ed|ing)|un-?paus(?:e|ed|ing)|re-?start(?:ed|ing)?|start (?:it|this|the run|this run)(?: (?:again|over|up))?|get (?:it|this|the run|this run) (?:started|going|moving|running)|kick (?:it|this|the run|this run) off)\b/i

/** Case, spacing, and closing punctuation do not matter: "Resume this run" is the Resume door. */
function doorKey(text: string): string {
  return text.trim().replace(/[\s.!?]+$/, '').toLowerCase()
}

const DOORS = new Map<string, Intent>(
  (
    [
      ['Continue fixing and running the review until approval', 'review-on'],
      ['Continue the voice fixes until voice approves', 'voice-on'],
      ['Continue past the tier stop', 'tier-on'],
      ['Proceed past this hold', 'proceed-on'],
      ['Stop', 'review-off'],
      ["Let's get this live", 'ship'],
      ['Approve the plan.', 'approve-plan'],
      ['Pause this run.', 'pause'],
      ['Resume this run.', 'resume']
    ] as const
  ).map(([text, intent]) => [doorKey(text), intent])
)

/** The sentence picks the door. The model does not. */
export function conductorIntent(text: string): Intent {
  const door = DOORS.get(doorKey(text))
  if (door) return door
  if (INJECT_RE.test(text)) return 'inject'
  return 'ask'
}

/** A question, unless it also asks to add or redirect. */
export function questionOnly(text: string): boolean {
  const t = text.trim()
  const q = /\?$/.test(t) || /^(how|what|why|when|is|are)\b/i.test(t)
  return q && !CHANGE_RE.test(t)
}

/** A paused or failed run, and a sentence (not a question) that asks to start it again. */
function restartAsk(run: RunRecord, text: string): boolean {
  return (run.phase === 'paused' || run.phase === 'failed') && RESTART_RE.test(text) && !questionOnly(text)
}

function orchTab(id: string): string {
  return `factory-${id}-orch`
}

async function talk(run: RunRecord, prompt: string): Promise<string> {
  const { driver, emit } = conductorBridge()
  const tabId = orchTab(run.id)
  if (!warmed.has(run.id)) {
    await driver.warm({ tabId, brainPath: run.brainPath, workRepo: run.workRepo, runThrough: false })
    warmed.add(run.id)
  }
  return driver.prompt({
    tabId,
    brainPath: run.brainPath,
    text: prompt,
    onEvent: (ev) => emit({ runId: run.id, kind: 'guide', ev })
  })
}

function splitTell(raw: string): { prose: string; tell: string } {
  const lines = String(raw || '').split('\n')
  let tell = ''
  const kept: string[] = []
  for (const line of lines) {
    if (line.startsWith('FACTORY_TELL:')) tell = line.slice('FACTORY_TELL:'.length).trim()
    else kept.push(line)
  }
  return { prose: kept.join('\n').trim(), tell }
}

// One answer at a time per run: a second prompt on the -orch tab would cancel the first (real ACP).
const lanes = new Map<string, Promise<unknown>>()

function inLane<T>(id: string, job: () => Promise<T>): Promise<T> {
  const next = (lanes.get(id) || Promise.resolve()).catch(() => undefined).then(job)
  lanes.set(id, next)
  return next
}

/** A question gets an answer. Anything else that the model turned into a TELL goes to the run. */
async function answer(id: string, body: string): Promise<RunRecord> {
  const run = getRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  let raw = ''
  try {
    raw = await talk(run, conductorPrompt(run, body))
  } catch {
    raw = ''
  }
  const { prose, tell } = splitTell(raw)
  const current = getRun(id) || run
  const question = questionOnly(body)
  if (tell && !question) {
    if (current.phase === 'paused') return queueInject(id, tell)
    const sent = guideRun(id, tell)
    return prose ? rewriteGuideAck(id, tell, prose) : sent
  }
  if (!prose) return appendSentNote(id, body, question ? statusReport(current) : `${NO_ANSWER} The run is ${current.phase} in ${current.workRepo}.`)
  return appendSentNote(id, body, question && !tell ? prose : `${prose} ${NOT_SENT}`)
}

/** Resume, after a move to the repo the sentence names. The reply says where it runs, or why it did not move. */
function restartDoor(id: string, body: string): RunRecord {
  const before = getRun(id)
  const named = namedRepoFor(id, body)
  appendSentNote(id, body, '', named)
  let after: RunRecord
  try {
    after = resumeRun(id)
  } catch (e) {
    return rewriteGuideAck(id, body, String((e as Error).message || e))
  }
  const moved = !!before && realish(after.workRepo) !== realish(before.workRepo)
  const ack = after.needsPrep
    ? `Moved to ${after.workRepo}. It has uncommitted changes: choose Commit first or Stash first.`
    : after.error && after.phase === 'paused'
      ? after.error
      : moved
        ? `Moved to ${after.workRepo} and resumed.`
        : `Resumed in ${after.workRepo}.`
  return rewriteGuideAck(id, body, ack)
}

async function runDoor(id: string, intent: Intent, body: string): Promise<RunRecord> {
  if (intent === 'ship') {
    try {
      await shipRun(id)
    } catch (e) {
      return appendSentNote(id, body, String((e as Error).message || e))
    }
    const shipped = getRun(id)
    const ack = shipped?.error || shipped?.pushError || shipped?.deployError || 'Committing, then pushing, then deploying.'
    return appendSentNote(id, body, ack)
  }
  try {
    if (intent === 'pause') pauseRun(id)
    else if (intent === 'resume') resumeRun(id)
    else if (intent === 'approve-plan') decideRun(id, 'approve-plan')
    else if (intent === 'review-on') setRunOverride(id, 'review', true)
    else if (intent === 'review-off') setRunOverride(id, 'review', false)
    else if (intent === 'voice-on') setRunOverride(id, 'voice', true)
    else if (intent === 'tier-on') setRunOverride(id, 'tier', true)
    else setRunOverride(id, 'proceed', true)
  } catch (e) {
    return appendSentNote(id, body, String((e as Error).message || e))
  }
  const fallback =
    intent === 'pause' ? 'Paused.' : intent === 'resume' ? 'Resumed.' : intent === 'approve-plan' ? 'Approving the plan.' : intent === 'review-off' ? 'Stopped.' : 'Review continues.'
  return appendSentNote(id, body, fallback)
}

/**
 * One composer send. Doors (pause, resume, restart, ship, overrides, add-to-the-run) act at once. A
 * question answers from the run. Anything else asks the run's chat, and a TELL from it goes to the run.
 */
export async function conduct(id: string, text: string): Promise<RunRecord> {
  const body = String(text || '').trim()
  if (!body) throw new Error('Type a note first.')
  const run = getRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  if (TERMINAL_PHASES.includes(run.phase)) throw new Error('This run is over. Start a new run.')
  const intent = conductorIntent(body)
  if (intent === 'inject') return queueInject(id, body)
  if (intent !== 'ask') return runDoor(id, intent, body)
  if (restartAsk(run, body)) return restartDoor(id, body)
  return inLane(id, () => answer(id, body))
}

export type { Decision, OverrideBoundary }
