import { opusArgs, type OpusRun } from '../opus.ts'
import { grokTriageArgs, TRIAGE_TIMEOUT_MS, type TriageRun } from '../triage-llm.ts'

/**
 * Setups an eval can run. Each is the production call with one lever moved (model, effort, cwd,
 * timeout), built by the same argv builders the Factory uses.
 */

export type TriageConfig = { job: 'triage'; name: string; kind: 'rules' | 'grok'; run?: TriageRun; cwd: 'brain' | 'empty'; timeoutMs: number }
export type ReviewConfig = { job: 'review'; name: string; run: OpusRun }
export type EvalConfig = TriageConfig | ReviewConfig

const grok = (name: string, run: TriageRun, cwd: 'brain' | 'empty' = 'brain', timeoutMs = TRIAGE_TIMEOUT_MS): TriageConfig => ({ job: 'triage', name, kind: 'grok', run, cwd, timeoutMs })
const opus = (name: string, run: OpusRun): ReviewConfig => ({ job: 'review', name, run })

export const CONFIGS: Record<string, EvalConfig> = {
  rules: { job: 'triage', name: 'rules', kind: 'rules', cwd: 'brain', timeoutMs: 0 },
  'grok-default-low': grok('grok-default-low', {}),
  'grok-default-medium': grok('grok-default-medium', { effort: 'medium' }),
  'grok-4.7-low': grok('grok-4.7-low', { model: 'grok-4.7' }),
  'grok-low-emptycwd': grok('grok-low-emptycwd', {}, 'empty', 60_000),
  'opus-medium': opus('opus-medium', {}),
  'opus-low': opus('opus-low', { effort: 'low' }),
  'sonnet-high': opus('sonnet-high', { model: 'sonnet', effort: 'high' }),
  'sonnet-medium': opus('sonnet-medium', { model: 'sonnet', effort: 'medium' })
}

export function configsFor(job: 'triage' | 'review', names: string[]): EvalConfig[] {
  return names.map((n) => {
    const c = CONFIGS[n]
    if (!c) throw new Error(`Unknown config: ${n}. Known: ${Object.keys(CONFIGS).join(', ')}`)
    if (c.job !== job) throw new Error(`Config ${n} is a ${c.job} config, not ${job}.`)
    return c
  })
}

/** What `--dry` prints: the exact argv, or that nothing spawns. */
export function dryLine(c: EvalConfig): string {
  if (c.job === 'triage') {
    if (c.kind === 'rules') return `${c.name}: no spawn`
    return `${c.name}: grok ${JSON.stringify(grokTriageArgs('<prompt>', c.run))} cwd=${c.cwd} timeout=${c.timeoutMs}ms`
  }
  return `${c.name}: claude ${JSON.stringify(opusArgs('<prompt>', c.run))}`
}
