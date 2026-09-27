import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { RANK, type Risk, type Size, type Triage } from './triage.ts'

/**
 * Model triage at Start: one Grok low one-shot, raise-only on top of the rules. Never uses the
 * Factory ACP session, never --always-approve. Timeout, exit, missing binary, or junk keeps the
 * rules result.
 */

export const TRIAGE_TIMEOUT_MS = 8000
/** Empty means the Grok CLI default model (4.7). Set if the CLI default ever moves. */
export const TRIAGE_MODEL = ''

export type LlmTriage = { size: Size; risk: Risk; reason: string }

type LineEvent = { kind: string; data?: string } | null
export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess

export function triagePrompt(task: string, rules: Triage): string {
  return [
    'Size this code change for a software factory. Do not edit files. Do not run tools.',
    'T0: one-file copy or style fix. T1: small fix in existing patterns (up to 3 files). T2: standard feature (new route, component, API, refactor; up to 10 files). T3: program (rewrite, migration, cross-repo).',
    'Risk: critical for payments, auth, secrets, database or schema, user data, access control. elevated for API, config, dependencies, runtime behavior, outbound messages, security, sessions. none otherwise.',
    `Rules said: ${rules.original} (${rules.risk}).`,
    'Answer with one JSON object and nothing else: {"size":"T0|T1|T2|T3","risk":"none|elevated|critical","reason":"one sentence"}',
    '',
    `Task: ${String(task || '').slice(0, 4000)}`
  ].join('\n')
}

export function grokTriageArgs(prompt: string): string[] {
  return ['-p', prompt, '--effort', 'low', '--output-format', 'streaming-json', ...(TRIAGE_MODEL ? ['-m', TRIAGE_MODEL] : [])]
}

const SIZES: Size[] = ['T0', 'T1', 'T2', 'T3']
const RISKS: Risk[] = ['none', 'elevated', 'critical']
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

/** Rules plus model: the higher size and the higher risk, never lower. T3 caps at T2. */
export function mergeTriage(rules: Triage, llm: LlmTriage | null, why?: string): Triage {
  if (!llm) return { ...rules, reasons: [...rules.reasons, `Model triage skipped: ${why || 'no answer'}.`] }
  const reasons = [...rules.reasons]
  const original = RANK[llm.size] > RANK[rules.original] ? llm.size : rules.original
  const risk = RISK_RANK[llm.risk] > RISK_RANK[rules.risk] ? llm.risk : rules.risk
  if (original !== rules.original || risk !== rules.risk) {
    reasons.push(`Grok raised this to ${original} · risk ${risk}${llm.reason ? `: ${llm.reason}` : '.'}`)
  }
  let size: Size = original
  let capped = false
  if (original === 'T3') {
    size = 'T2'
    capped = true
    if (!rules.capped) reasons.push('Triage says T3. This version caps at T2: doing the smallest safe slice.')
  }
  return { ...rules, size, original, risk, capped, reasons }
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
}): Promise<{ llm: LlmTriage | null; why: string }> {
  if (!o.bin) return { llm: null, why: 'grok CLI not found' }
  const args = grokTriageArgs(triagePrompt(o.task, o.rules))
  const timeoutMs = o.timeoutMs ?? TRIAGE_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { llm: LlmTriage | null; why: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ChildProcess
    try {
      child = (o.spawnFn || spawn)(o.bin as string, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    } catch (e) {
      resolve({ llm: null, why: String((e as Error).message || e) })
      return
    }
    let raw = ''
    let text = ''
    let buf = ''
    const line = (l: string) => {
      const ev = o.parseLine?.(l)
      if (ev && ev.kind === 'text' && ev.data) text += ev.data
    }
    child.stdout?.on('data', (d: Buffer) => {
      raw = (raw + String(d)).slice(-50_000)
      if (!o.parseLine) return
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
