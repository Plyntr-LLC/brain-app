/**
 * Factory conductor. One Grok 4.6 call per Guide send. It watches the run and may file an edit,
 * set one boundary for this run, take one factory door, or ship. It does not set the phase itself.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { parseGrokLine, resolveBin } from '../ai-cli.ts'
import type { RunRecord } from '../../shared/factory.ts'
import {
  appendSentNote,
  askConductorHook,
  decideRun,
  getRun,
  guideRun,
  holdName,
  pauseRun,
  resumeRun,
  rewriteGuideAck,
  setRunOverride,
  shipRun,
  type Decision,
  type OverrideBoundary
} from './controller.ts'
import { TERMINAL_PHASES } from './run-store.ts'

const CONDUCTOR_MODEL = 'grok-4.6'
const CONDUCTOR_EFFORT = 'high'
const CONDUCTOR_TIMEOUT_MS = 120_000

export type ConductorAction =
  | { kind: 'none'; reply: string }
  | { kind: 'guide'; text: string; reply: string }
  | { kind: 'override'; boundary: OverrideBoundary; on: boolean; reply: string }
  | { kind: 'ship'; reply: string }
  | { kind: 'decide'; choice: Decision; reply: string }
  | { kind: 'pause'; reply: string }
  | { kind: 'resume'; reply: string }

const BOUNDS = new Set<OverrideBoundary>(['review', 'voice', 'tier', 'proceed'])
const DECISIONS = new Set<Decision>([
  'upgrade',
  'trim',
  'stop',
  'approve-plan',
  'reject-plan',
  'proceed',
  'fix-copy',
  'prep-commit',
  'prep-stash',
  'keep-fix',
  're-review',
  'retry-triage'
])

export function conductorArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--effort',
    CONDUCTOR_EFFORT,
    '--max-turns',
    '1',
    '--permission-mode',
    'plan',
    '--no-subagents',
    '--disable-web-search',
    '--output-format',
    'streaming-json',
    '-m',
    CONDUCTOR_MODEL
  ]
}

export function conductorPrompt(run: RunRecord, text: string): string {
  const guide = (run.guide || []).map((g) => ({ text: g.text, ack: g.ack || '', sent: !!g.sent }))
  return [
    'You are the Factory conductor. Reply with one JSON object and nothing else. At most one action. Do not set phase.',
    'none: a status question, or you are unsure. guide: an edit; text is the only instruction the factory gets. override: Joe named one boundary (review, voice, tier, or proceed); on true keeps going past it, on false clears it. ship: he told you to commit, push, and deploy. decide: one factory door; choice is keep-fix, re-review, trim, approve-plan, reject-plan, fix-copy, proceed, upgrade, stop, prep-commit, prep-stash, or retry-triage. pause: pause the run. resume: resume the run.',
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

function lastObject(text: string): Record<string, unknown> | null {
  const s = String(text || '')
  let found: Record<string, unknown> | null = null
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    let depth = 0
    for (let j = i; j < s.length; j++) {
      const ch = s[j]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(i, j + 1)) as unknown
            if (o && typeof o === 'object' && !Array.isArray(o)) found = o as Record<string, unknown>
          } catch {
            /* not this span */
          }
          break
        }
      }
    }
  }
  return found
}

/** Unknown kind, an unknown decide choice, or any phase field, is not a door. */
export function parseConductor(text: string): ConductorAction | null {
  const o = lastObject(text)
  if (!o || 'phase' in o) return null
  const reply = String(o.reply || '')
  if (o.kind === 'none') return { kind: 'none', reply }
  if (o.kind === 'guide') {
    const body = String(o.text || '').trim()
    if (!body) return null
    return { kind: 'guide', text: body, reply }
  }
  if (o.kind === 'override') {
    const boundary = String(o.boundary || '') as OverrideBoundary
    if (!BOUNDS.has(boundary) || typeof o.on !== 'boolean') return null
    return { kind: 'override', boundary, on: o.on, reply }
  }
  if (o.kind === 'ship') return { kind: 'ship', reply }
  if (o.kind === 'decide') {
    const choice = String(o.choice || '') as Decision
    if (!DECISIONS.has(choice)) return null
    return { kind: 'decide', choice, reply }
  }
  if (o.kind === 'pause') return { kind: 'pause', reply }
  if (o.kind === 'resume') return { kind: 'resume', reply }
  return null
}

function askGrok(run: RunRecord, prompt: string): Promise<string> {
  const bin = resolveBin('grok')
  if (!bin) return Promise.reject(new Error('grok CLI not found'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(text || '')
    }
    let child: ChildProcess
    try {
      child = spawn(bin, conductorArgs(prompt), { cwd: run.workRepo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      finish(e as Error)
      return
    }
    let raw = ''
    let text = ''
    let buf = ''
    const line = (l: string) => {
      const ev = parseGrokLine(l)
      if (ev && ev.kind === 'text' && ev.data) text += ev.data
    }
    child.stdout?.on('data', (d: Buffer) => {
      raw = (raw + String(d)).slice(-50_000)
      buf += String(d)
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const l of parts) line(l)
    })
    child.stderr?.on('data', () => {})
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      finish(new Error('grok timed out'))
    }, CONDUCTOR_TIMEOUT_MS)
    child.on('error', (e) => finish(e))
    child.on('close', (code) => {
      if (buf) line(buf)
      if (code !== 0) return finish(new Error(`grok exited ${code}`))
      const body = (text || raw).trim()
      if (!body) return finish(new Error('grok returned nothing'))
      finish(null, body)
    })
  })
}

/** One Guide send. A status question does not interrupt the run. A bad reply runs no door. */
export async function conduct(id: string, text: string): Promise<RunRecord> {
  const body = String(text || '').trim()
  if (!body) throw new Error('Type a note first.')
  const run = getRun(id)
  if (!run) throw new Error('That Factory run is gone.')
  if (TERMINAL_PHASES.includes(run.phase)) throw new Error('This run is over. Start a new run.')
  const prompt = conductorPrompt(run, body)
  let raw = ''
  try {
    const hook = askConductorHook()
    raw = hook ? await hook(prompt) : await askGrok(run, prompt)
  } catch (e) {
    return appendSentNote(id, body, String((e as Error).message || e))
  }
  const action = parseConductor(raw)
  if (!action) return appendSentNote(id, body, raw.trim() || 'That reply was not a door.')
  if (action.kind === 'none') return appendSentNote(id, body, action.reply)
  if (action.kind === 'guide') {
    guideRun(id, action.text)
    return rewriteGuideAck(id, action.text, action.reply)
  }
  if (action.kind === 'override') {
    setRunOverride(id, action.boundary, action.on)
    return appendSentNote(id, body, action.reply)
  }
  if (action.kind === 'decide' || action.kind === 'pause' || action.kind === 'resume') {
    try {
      if (action.kind === 'decide') decideRun(id, action.choice)
      else if (action.kind === 'pause') pauseRun(id)
      else resumeRun(id)
    } catch (e) {
      return appendSentNote(id, body, String((e as Error).message || e))
    }
    return appendSentNote(id, body, action.reply)
  }
  await shipRun(id)
  const shipped = getRun(id)
  const ack = shipped?.error || shipped?.pushError || shipped?.deployError || action.reply
  return appendSentNote(id, body, ack)
}
