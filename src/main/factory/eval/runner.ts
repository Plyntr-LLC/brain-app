import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { UsageRow } from '../../../shared/factory.ts'
import { realGit } from '../gates.ts'
import { diffText } from '../git-audit.ts'
import { opusEnv, runOpus, strictPrompt, type SpawnFn } from '../opus.ts'
import { gitCommonDir } from '../repo-store.ts'
import { triage } from '../triage.ts'
import { llmTriage, mergeTriage } from '../triage-llm.ts'
import { caseFile, readCases, type ReviewCase, type TriageCase } from './cases.ts'
import type { ReviewConfig, TriageConfig } from './configs.ts'
import { gradeReview, gradeTriage, type ReviewGrade, type TriageGrade } from './grade.ts'
import { splitOf, type Split } from './split.ts'

/**
 * Runs eval cases through the signed-in CLIs, never a model API. Results keep ids, SHAs, grades, and
 * usage only. Review text (it quotes code) goes to the case repo's own store.
 */

export const GUARDED_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_TRANSLATOR_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY']

/** A key in the env means the calls could bill an API instead of the login. */
export function keyGuard(env: NodeJS.ProcessEnv): string | null {
  const set = GUARDED_KEYS.filter((k) => String(env[k] || '').trim())
  if (!set.length) return null
  return `${set.join(', ')} is set. Evals run on your CLI logins only. Run this outside \`doppler run\` (or unset the key) and try again.`
}

export function findBin(name: 'claude' | 'grok', env: NodeJS.ProcessEnv): string | null {
  const own = name === 'grok' ? env.EVAL_GROK_BIN : env.EVAL_CLAUDE_BIN
  if (own) return own
  const extra = name === 'grok' ? [join(homedir(), '.grok', 'bin')] : [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')]
  for (const dir of [...String(env.PATH || '').split(delimiter), ...extra]) {
    const p = join(dir, name)
    if (dir && existsSync(p)) return p
  }
  return null
}

const cleanEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = opusEnv(env)
  for (const k of GUARDED_KEYS) delete out[k]
  return out
}

/** Grok streaming-json `text` events, the only part triage reads. */
function grokText(line: string): { kind: string; data?: string } | null {
  try {
    const o = JSON.parse(line) as { type?: string; data?: string }
    return o.type === 'text' && o.data ? { kind: 'text', data: o.data } : null
  } catch {
    return null
  }
}

export type Pick = { split: Split; limit?: number; ids?: string[] }

export function pickCases<T extends { id: string }>(all: T[], p: Pick): T[] {
  const inSplit = all.filter((c) => splitOf(c.id) === p.split && (!p.ids?.length || p.ids.includes(c.id)))
  return p.limit ? inSplit.slice(0, p.limit) : inSplit
}

export type ResultRow = {
  caseId: string
  repo: string
  sha?: string
  config: string
  rep: number
  split: Split
  model: string
  ok: boolean
  usage: UsageRow | null
  got?: { size: string; risk: string }
  triage?: TriageGrade
  review?: ReviewGrade
  why?: string
}

export type RunDeps = { env: NodeJS.ProcessEnv; spawnFn?: SpawnFn; grokBin?: string | null; claudeBin?: string | null; opusTimeoutMs?: number }

export async function runTriage(o: { repo: string; brain: string; configs: TriageConfig[]; pick: Pick; repeats: number; deps: RunDeps }): Promise<ResultRow[]> {
  const cases = pickCases(readCases<TriageCase>(caseFile(o.repo, 'triage')), o.pick)
  const env = cleanEnv(o.deps.env)
  const bin = o.deps.grokBin === undefined ? findBin('grok', o.deps.env) : o.deps.grokBin
  const rows: ResultRow[] = []
  for (const c of o.configs) {
    for (const k of cases) {
      for (let rep = 1; rep <= o.repeats; rep++) {
        const rules = triage(k.task)
        const base = { caseId: k.id, repo: o.repo, sha: k.sha, config: c.name, rep, split: splitOf(k.id) }
        if (c.kind === 'rules') {
          const got = { size: rules.size, risk: rules.risk }
          rows.push({ ...base, model: 'rules', ok: true, usage: null, got, triage: gradeTriage(k.expect, got) })
          continue
        }
        const empty = c.cwd === 'empty' ? mkdtempSync(join(tmpdir(), 'factory-eval-cwd-')) : ''
        try {
          const res = await llmTriage({ task: k.task, rules, cwd: empty || o.brain, env, bin, parseLine: grokText, spawnFn: o.deps.spawnFn, run: c.run, timeoutMs: c.timeoutMs })
          const m = mergeTriage(rules, res.llm, res.why)
          const got = { size: m.size, risk: m.risk }
          rows.push({ ...base, model: res.usage.model, ok: !!res.llm, usage: res.usage, got, triage: gradeTriage(k.expect, got), why: res.llm ? undefined : res.why })
        } finally {
          if (empty) rmSync(empty, { recursive: true, force: true })
        }
      }
    }
  }
  return rows
}

function gitIn(repo: string, args: string[]): string {
  return execFileSync(realGit(), args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

/** A throwaway detached worktree at the case's commit (plus its patch). Removed however the review ends. */
async function inWorktree<T>(repo: string, k: ReviewCase, fn: (wt: string) => Promise<T>): Promise<T> {
  const wt = join(mkdtempSync(join(tmpdir(), 'factory-eval-wt-')), 'wt')
  gitIn(repo, ['worktree', 'add', '--detach', '-q', wt, k.head || k.base])
  try {
    if (k.patch) gitIn(wt, ['apply', join(repo, 'evals', 'factory', 'patches', k.patch)])
    return await fn(wt)
  } finally {
    try {
      gitIn(repo, ['worktree', 'remove', '--force', wt])
    } catch {
      rmSync(wt, { recursive: true, force: true })
    }
    gitIn(repo, ['worktree', 'prune'])
    rmSync(join(wt, '..'), { recursive: true, force: true })
  }
}

export async function runReview(o: { repo: string; configs: ReviewConfig[]; pick: Pick; repeats: number; deps: RunDeps; stamp: string }): Promise<ResultRow[]> {
  const cases = pickCases(readCases<ReviewCase>(caseFile(o.repo, 'review')), o.pick)
  const env = cleanEnv(o.deps.env)
  const bin = o.deps.claudeBin === undefined ? findBin('claude', o.deps.env) : o.deps.claudeBin
  const common = gitCommonDir(o.repo)
  const rawDir = common ? join(common, 'brain-factory', 'evals', o.stamp) : null
  const rows: ResultRow[] = []
  for (const c of o.configs) {
    for (const k of cases) {
      for (let rep = 1; rep <= o.repeats; rep++) {
        const base = { caseId: k.id, repo: o.repo, sha: k.head || k.base, config: c.name, rep, split: splitOf(k.id) }
        const row = await inWorktree(o.repo, k, async (wt) => {
          const prompt = strictPrompt({ task: k.task, tier: 'T2', risk: 'elevated', base: k.base, diff: diffText(wt, k.base), workRepo: wt })
          const res = await runOpus({ cwd: wt, prompt, env, bin, timeoutMs: o.deps.opusTimeoutMs ?? 10 * 60_000, spawnFn: o.deps.spawnFn, phase: 'review', run: c.run })
          if (rawDir) {
            mkdirSync(rawDir, { recursive: true })
            writeFileSync(join(rawDir, `${k.id}-${c.name}-${rep}.md`), res.text)
          }
          return { ...base, model: res.usage.model, ok: res.parsed, usage: res.usage, review: gradeReview(k.expect, res.text, res.parsed), why: res.parsed ? undefined : `exit ${res.code}` }
        })
        rows.push(row)
      }
    }
  }
  return rows
}
