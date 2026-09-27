import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { RunRecord } from '../../shared/factory.ts'

/**
 * Opus 5.5 through the signed-in Claude CLI (Claude Max), a fresh `claude -p` every call. Plan
 * permission mode so it cannot edit. Prompt in argv, stdin closed, no Anthropic API keys, no shell,
 * never --bare, never an HTTP call.
 */

export const STRICT_SKILL_PATH = '/Users/joewine/Projects/agency-brain/.claude/skills/strict-code-review/SKILL.md'
export const OPUS_PLAN_TIMEOUT_MS = 10 * 60_000
export const OPUS_REVIEW_TIMEOUT_MS = 10 * 60_000

export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess
export type OpusResult = { found: boolean; code: number; text: string; last: string }

/** Factory Opus is always medium (same as the Kennel merge gate). Claude has no xhigh. */
export function opusArgs(prompt: string): string[] {
  return ['-p', prompt, '--model', 'opus', '--effort', 'medium', '--permission-mode', 'plan', '--output-format', 'text']
}

export function opusEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_TRANSLATOR_API_KEY
  return env
}

function lastLine(text: string): string {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.at(-1) || ''
}

export function runOpus(o: {
  cwd: string
  prompt: string
  env: NodeJS.ProcessEnv
  bin?: string | null
  timeoutMs: number
  spawnFn?: SpawnFn
  /** Pause or abandon kills the process. */
  signal?: AbortSignal
}): Promise<OpusResult> {
  if (!o.bin) return Promise.resolve({ found: false, code: 127, text: '', last: '' })
  return new Promise((resolve) => {
    let settled = false
    let text = ''
    let err = ''
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ found: true, code, text: text.trim() || err.trim(), last: lastLine(text) })
    }
    let child: ChildProcess
    try {
      child = (o.spawnFn || spawn)(o.bin as string, opusArgs(o.prompt), {
        cwd: o.cwd,
        env: opusEnv(o.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      })
    } catch (e) {
      resolve({ found: true, code: 127, text: String((e as Error).message || e), last: '' })
      return
    }
    child.stdout?.on('data', (d: Buffer) => {
      text = (text + String(d)).slice(-400_000)
    })
    child.stderr?.on('data', (d: Buffer) => {
      err = (err + String(d)).slice(-8000)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      text = text || 'Reviewer timed out.'
      finish(124)
    }, o.timeoutMs)
    child.on('error', (e) => {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      if (missing && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ found: false, code: 127, text: '', last: '' })
        return
      }
      err += String(e.message || e)
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 1))
    o.signal?.addEventListener('abort', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    })
  })
}

/** Strict review is required for T2 and T3, elevated or critical risk, and any MyPuppies path. */
export function strictNeeded(run: Pick<RunRecord, 'tier' | 'risk' | 'workRepo'>): boolean {
  return run.tier === 'T2' || run.tier === 'T3' || run.risk === 'elevated' || run.risk === 'critical' || /mypuppies/i.test(run.workRepo)
}

export function strictPrompt(o: { task: string; tier: string; risk: string; base: string; diff: string; workRepo: string }): string {
  return [
    `Use the strict code review skill at ${STRICT_SKILL_PATH}. Read it from disk and follow it.`,
    'Review this change as an independent reviewer. You cannot edit files. Do not push or deploy.',
    `Work repo: ${o.workRepo}`,
    `Tier: ${o.tier}. Risk: ${o.risk}. Base: ${o.base}.`,
    `Task: ${String(o.task || '').slice(0, 4000)}`,
    '',
    `Diff against the base (cut at 60k characters; run \`git diff ${o.base}\` in the work repo for the rest):`,
    o.diff,
    '',
    'Name every real defect with file and line. Your last line must be exactly PASS or FAIL.'
  ].join('\n')
}

export function planPrompt(o: { task: string; workRepo: string; plans: string[]; reasons: string[]; tier?: 'T2' | 'T3' }): string {
  const t3 = o.tier === 'T3'
  return [
    'Write the implementation plan for this change. You cannot edit files; read the repo as needed.',
    `Work repo: ${o.workRepo}`,
    t3
      ? 'Limit T3: up to 40 files, 2500 changed lines, no lockfile changes, no migrations.'
      : 'Limit T2: up to 10 files, 600 changed lines, no lockfile changes, no migrations.',
    'Give: files to change, steps, tests to run. Keep it short.',
    ...(t3 ? ['End with one JSON line: {"slices":[{"title":"...","files":["rel/path.ts"]}]}. Paths relative to the work repo; slices that share no files run in parallel.'] : []),
    `Task: ${String(o.task || '').slice(0, 4000)}`,
    ...(o.plans.length ? ['', 'Earlier plans (rejected):', ...o.plans.map((p) => `- ${p}`)] : []),
    ...(o.reasons.filter(Boolean).length ? ['', 'Why they were rejected:', ...o.reasons.filter(Boolean).map((r) => `- ${r}`)] : [])
  ].join('\n')
}

/** PASS or FAIL from the last non-empty line, else null. */
export function verdict(text: string): 'PASS' | 'FAIL' | null {
  const last = lastLine(text).replace(/[*`_.]/g, '').trim().toUpperCase()
  return last === 'PASS' ? 'PASS' : last === 'FAIL' ? 'FAIL' : null
}
