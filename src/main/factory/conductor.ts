/**
 * Factory composer. Exact doors run in the app. A question goes to one Grok session for this run.
 * That session watches the run. It talks to the builder only when Joe asks to add or redirect.
 */

import type { RunRecord } from '../../shared/factory.ts'
import {
  appendSentNote,
  conductorBridge,
  decideRun,
  getRun,
  guideRun,
  holdName,
  pauseRun,
  queueInject,
  resumeRun,
  rewriteGuideAck,
  setRunOverride,
  shipRun,
  statusReport,
  type Decision,
  type OverrideBoundary
} from './controller.ts'
import { TERMINAL_PHASES } from './run-store.ts'

const NOT_SENT = 'I did not send that to the factory.'
const warmed = new Set<string>()

export function conductorPrompt(run: RunRecord, text: string): string {
  const guide = (run.guide || []).map((g) => ({ text: g.text, ack: g.ack || '', sent: !!g.sent }))
  return [
    'You watch this factory run. Answer Joe in sentences using the card below. Do not edit files. Do not set the phase.',
    'If Joe asked to add, change, redirect, or instead do something, end with one line FACTORY_TELL: and the instruction. Otherwise do not write FACTORY_TELL.',
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

/** The sentence picks the door. The model does not. */
export function conductorIntent(text: string): Intent {
  const t = text.trim()
  if (t === 'Continue fixing and running the review until approval') return 'review-on'
  if (t === 'Continue the voice fixes until voice approves') return 'voice-on'
  if (t === 'Continue past the tier stop') return 'tier-on'
  if (t === 'Proceed past this hold') return 'proceed-on'
  if (t === 'Stop') return 'review-off'
  if (t === "Let's get this live") return 'ship'
  if (t === 'Approve the plan.') return 'approve-plan'
  if (t === 'Pause this run.') return 'pause'
  if (t === 'Resume this run.') return 'resume'
  if (INJECT_RE.test(t)) return 'inject'
  return 'ask'
}

/** A question, unless it also asks to add or redirect. */
export function questionOnly(text: string): boolean {
  const t = text.trim()
  const q = /\?$/.test(t) || /^(how|what|why|when|is|are)\b/i.test(t)
  return q && !CHANGE_RE.test(t)
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

function wantsChange(text: string): boolean {
  return CHANGE_RE.test(text) && !questionOnly(text)
}

async function answer(id: string, body: string, run: RunRecord): Promise<RunRecord> {
  const prompt = conductorPrompt(run, body)
  let raw = ''
  try {
    raw = await talk(run, prompt)
  } catch {
    raw = ''
  }
  const { prose, tell } = splitTell(raw)
  const current = getRun(id) || run
  if (!prose) return appendSentNote(id, body, statusReport(current))
  const deliver = !!tell && wantsChange(body)
  if (!deliver) {
    const ack = wantsChange(body) ? `${prose} ${NOT_SENT}` : prose
    return appendSentNote(id, body, ack)
  }
  if (current.phase === 'paused') return queueInject(id, tell)
  guideRun(id, tell)
  return rewriteGuideAck(id, tell, prose)
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

/** One composer send. A question answers from the run. Only add-to-the-run language, or a TELL, files a note. */
export async function conduct(id: string, text: string): Promise<RunRecord> {
  const body = String(text || '').trim()
  if (!body) throw new Error('Type a note first.')
  const run = getRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  if (TERMINAL_PHASES.includes(run.phase)) throw new Error('This run is over. Start a new run.')
  const intent = conductorIntent(body)
  if (intent === 'inject') return queueInject(id, body)
  if (intent !== 'ask') return runDoor(id, intent, body)
  return answer(id, body, run)
}

export type { Decision, OverrideBoundary }
