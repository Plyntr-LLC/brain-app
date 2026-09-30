import type { UsageRow } from '../../shared/factory.ts'
import type { JevReply } from '../skin/typesafe.ts'
import type { Risk, Size } from './triage.ts'
import { RISK_CRITERIA, RISKS, SIZE_CRITERIA, SIZES, type LlmTriage } from './triage-llm.ts'
import { usageRow } from './usage.ts'

/**
 * Model triage by Jev (TypeSafe System One): two typed choices, about a second and a few hundred
 * tokens. Same raise-only merge as Grok. A miss (no key, error, junk, timeout) returns llm null so
 * the controller falls back to the Grok one-shot.
 */

export const JEV_TRIAGE_TIMEOUT_MS = 10_000

export type JevAsk = (o: { state: unknown; questions: Record<string, unknown>; signal?: AbortSignal }) => Promise<JevReply | null>

export const JEV_TRIAGE_QUESTIONS = {
  size: { type: 'choice', instructions: 'How big is the code change this task asks for, in a software factory that sizes work before building?', criteria: SIZE_CRITERIA },
  risk: { type: 'choice', instructions: 'What is the riskiest thing this change touches?', criteria: RISK_CRITERIA }
}

type ChoiceAnswer = { choice?: unknown; confidence?: unknown }

function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}` : `${Math.round(ms / 100) / 10}`
}

function pick<T extends string>(a: unknown, set: T[]): { value: T; confidence: number } | null {
  const c = (a || {}) as ChoiceAnswer
  const value = String(c.choice ?? '') as T
  if (!set.includes(value)) return null
  return { value, confidence: Number(c.confidence) || 0 }
}

export async function jevTriage(o: { task: string; ask: JevAsk; timeoutMs?: number; questions?: typeof JEV_TRIAGE_QUESTIONS }): Promise<{ llm: LlmTriage | null; why: string; usage: UsageRow }> {
  const started = Date.now()
  const timeoutMs = o.timeoutMs ?? JEV_TRIAGE_TIMEOUT_MS
  const ctl = new AbortController()
  let reply: JevReply | null = null
  const row = (ok: boolean) =>
    usageRow({ phase: 'triage', cli: 'jev', effort: '', ms: Date.now() - started }, { counts: reply?.usage, model: reply?.model, turns: 1, ok })
  const done = (llm: LlmTriage | null, why: string) => ({ llm, why, usage: row(!!llm) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  try {
    const out = await Promise.race([o.ask({ state: { task: String(o.task || '').slice(0, 4000) }, questions: o.questions ?? JEV_TRIAGE_QUESTIONS, signal: ctl.signal }), timedOut])
    if (out === 'timeout') return done(null, `Jev timed out after ${secs(timeoutMs)} s`)
    if (!out) return done(null, 'Jev did not answer')
    reply = out
  } catch (e) {
    if (ctl.signal.aborted) return done(null, `Jev timed out after ${secs(timeoutMs)} s`)
    return done(null, String((e as Error)?.message || e).split('\n')[0].slice(0, 200))
  } finally {
    clearTimeout(timer)
  }
  const size = pick<Size>(reply.answers?.size, SIZES)
  const risk = pick<Risk>(reply.answers?.risk, RISKS)
  if (!size || !risk) return done(null, 'Jev answer was not a size and risk')
  return done({ size: size.value, risk: risk.value, reason: `Jev ${size.value} (${size.confidence.toFixed(2)}) · risk ${risk.value} (${risk.confidence.toFixed(2)})` }, '')
}
