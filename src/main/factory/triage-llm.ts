import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { UsageRow } from '../../shared/factory.ts'
import { RANK, type Risk, type Size, type Triage } from './triage.ts'
import { grokEnd, grokRow } from './usage.ts'

/**
 * Model triage at Start: one Grok low one-shot, raise-only on top of the rules. Never uses the
 * Factory ACP session, never --always-approve. Timeout, exit, missing binary, or junk keeps the
 * rules result.
 */

export const TRIAGE_TIMEOUT_MS = 60_000
/** Empty means the Grok CLI default model (grok-4.6-build on 2026-09-29, per the CLI's own answer). */
export const TRIAGE_MODEL = ''
export const TRIAGE_EFFORT = 'low'

export type TriageRun = { model?: string; effort?: string }

export type LlmTriage = { size: Size; risk: Risk; reason: string }

type LineEvent = { kind: string; data?: string } | null
export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess

export const SIZES: Size[] = ['T0', 'T1', 'T2', 'T3']
export const RISKS: Risk[] = ['none', 'elevated', 'critical']

/** What each size and risk means. One source: the Grok prompt renders it and Jev's criteria are these objects. */
export const SIZE_CRITERIA: Record<Size, string> = {
  T0: 'One-file copy, wording, or style fix. No logic change.',
  T1: 'Small fix inside existing patterns: up to 3 files, no new dependency, no migration.',
  T2: 'Standard feature or refactor: new route, component, API, or shared types; up to about 10 files.',
  T3: 'Program: rewrite, migration, cross-repo work, or many slices across the app.'
}

export const RISK_CRITERIA: Record<Risk, string> = {
  none: 'None of the others: UI, copy, tests, docs, internal refactors.',
  elevated: 'API endpoints, config or env, dependencies, runtime behavior (cache, cron, queues), outbound email or SMS, security headers, sessions.',
  critical: 'Payments, authentication, secrets or keys or encryption, database schema or migrations, user data deletion, access control.'
}

export function triagePrompt(task: string, rules: Triage): string {
  return [
    'Size this code change for a software factory. Do not edit files. Do not run tools.',
    SIZES.map((k) => `${k}: ${SIZE_CRITERIA[k]}`).join(' '),
    'Risk: ' + (['critical', 'elevated', 'none'] as Risk[]).map((k) => `${k}: ${RISK_CRITERIA[k]}`).join(' '),
    `Rules said: ${rules.original} (${rules.risk}).`,
    'Answer with one JSON object and nothing else: {"size":"T0|T1|T2|T3","risk":"none|elevated|critical","reason":"one sentence"}',
    '',
    `Task: ${String(task || '').slice(0, 4000)}`
  ].join('\n')
}

export function grokTriageArgs(prompt: string, o: TriageRun = {}): string[] {
  const model = o.model ?? TRIAGE_MODEL
  return [
    '-p',
    prompt,
    '--effort',
    o.effort || TRIAGE_EFFORT,
    '--max-turns',
    '1',
    '--permission-mode',
    'plan',
    '--no-subagents',
    '--disable-web-search',
    '--output-format',
    'streaming-json',
    ...(model ? ['-m', model] : [])
  ]
}

const RISK_RANK: Record<Risk, number> = { none: 0, elevated: 1, critical: 2 }

/** The last JSON object in the text with a valid size and risk, or null. */
export function parseLlmTriage(text: string): LlmTriage | null {
  const s = String(text || '')
  const found: LlmTriage[] = []
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = s.indexOf('}', i)
    if (end < 0) break
    try {
      const o = JSON.parse(s.slice(i, end + 1)) as { size?: unknown; risk?: unknown; reason?: unknown }
      const size = String(o.size || '').toUpperCase() as Size
      const risk = String(o.risk || '').toLowerCase() as Risk
      if (SIZES.includes(size) && RISKS.includes(risk)) found.push({ size, risk, reason: String(o.reason || '').slice(0, 300) })
    } catch {
      /* not an object */
    }
  }
  return found.at(-1) || null
}

/** Rules plus model: the higher size and the higher risk, never lower. It may raise to T3. */
export function mergeTriage(rules: Triage, llm: LlmTriage | null, why?: string, label = 'Grok'): Triage {
  if (!llm) return { ...rules, reasons: [...rules.reasons, `Model triage skipped: ${why || 'no answer'}.`] }
  const reasons = [...rules.reasons]
  const original = RANK[llm.size] > RANK[rules.original] ? llm.size : rules.original
  const risk = RISK_RANK[llm.risk] > RISK_RANK[rules.risk] ? llm.risk : rules.risk
  if (original !== rules.original || risk !== rules.risk) {
    reasons.push(`${label} raised this to ${original} · risk ${risk}${llm.reason ? `: ${llm.reason}` : '.'}`)
  }
  return { ...rules, size: original, original, risk, capped: false, reasons }
}

export async function llmTriage(o: {
  task: string
  rules: Triage
  cwd: string
  env: NodeJS.ProcessEnv
  bin?: string | null
  timeoutMs?: number
  /** Chat's Grok line reader (parseGrokLine). Without it the raw stdout is read. */
  parseLine?: (line: string) => LineEvent
  spawnFn?: SpawnFn
  run?: TriageRun
}): Promise<{ llm: LlmTriage | null; why: string; usage: UsageRow }> {
  const started = Date.now()
  let end: ReturnType<typeof grokEnd> = null
  const row = (ok: boolean) => grokRow({ phase: 'triage', cli: 'grok', effort: o.run?.effort || TRIAGE_EFFORT, ms: Date.now() - started }, end, ok)
  if (!o.bin) return { llm: null, why: 'grok CLI not found', usage: row(false) }
  const args = grokTriageArgs(triagePrompt(o.task, o.rules), o.run)
  const timeoutMs = o.timeoutMs ?? TRIAGE_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { llm: LlmTriage | null; why: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...r, usage: row(!!r.llm) })
    }
    let child: ChildProcess
    try {
      child = (o.spawnFn || spawn)(o.bin as string, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      resolve({ llm: null, why: String((e as Error).message || e), usage: row(false) })
      return
    }
    let raw = ''
    let text = ''
    let buf = ''
    const line = (l: string) => {
      end = grokEnd(l) || end
      const ev = o.parseLine?.(l)
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
      finish({ llm: null, why: `timed out after ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    child.on('error', (e) => finish({ llm: null, why: String(e.message || e) }))
    child.on('close', (code) => {
      if (buf) line(buf)
      if (code !== 0) return finish({ llm: null, why: `grok exited ${code}` })
      const llm = parseLlmTriage(o.parseLine ? text || raw : raw)
      finish(llm ? { llm, why: '' } : { llm: null, why: 'answer was not JSON' })
    })
  })
}
