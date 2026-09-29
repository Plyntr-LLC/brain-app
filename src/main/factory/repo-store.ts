import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { RunRecord } from '../../shared/factory.ts'
import { realGit } from './gates.ts'

/**
 * Project code a run touches (diff, review, plan, test and deploy output, notes that quote them) lives
 * in that project's own repo, under its git dir: `<git-common-dir>/brain-factory/<runId>/`. Git never
 * tracks it, it never shows in `git status`, and Brain.app's userData only keeps metadata.
 */

export type RunCode = {
  diff?: string
  strictText?: string
  planText?: string
  verifyTails?: Record<string, string>
  voiceTail?: string
  note?: string
  error?: string
  pushError?: string
  deployError?: string
}

const LINE_MAX = 200

export function gitCommonDir(repo: string): string | null {
  if (!repo || !existsSync(repo)) return null
  try {
    const out = execFileSync(realGit(), ['rev-parse', '--git-common-dir'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    }).trim()
    if (!out) return null
    return isAbsolute(out) ? out : resolve(repo, out)
  } catch {
    return null
  }
}

export function repoStoreDir(repo: string, runId: string): string | null {
  const common = gitCommonDir(repo)
  return common ? join(common, 'brain-factory', runId) : null
}

function firstLine(text: string | undefined): string | undefined {
  if (text == null) return undefined
  const s = String(text)
  if (!s.includes('\n') && s.length <= LINE_MAX) return s
  return s.split('\n')[0].slice(0, LINE_MAX)
}

const multi = (text: string | undefined): boolean => text != null && (String(text).includes('\n') || String(text).length > LINE_MAX)

/** The run as userData may keep it, and the code that goes to the repo store. */
export function splitCode(run: RunRecord): { meta: RunRecord; code: RunCode } {
  const code: RunCode = {}
  const meta: RunRecord = { ...run }
  if (run.diff != null) {
    code.diff = run.diff
    delete meta.diff
  }
  if (run.strict?.text) {
    code.strictText = run.strict.text
    meta.strict = { ...run.strict, text: '' }
  }
  if (run.plan?.text) {
    code.planText = run.plan.text
    meta.plan = { ...run.plan, text: '' }
  }
  const tails = Object.fromEntries((run.verify || []).filter((r) => r.tail).map((r) => [r.script, String(r.tail)]))
  if (Object.keys(tails).length) {
    code.verifyTails = tails
    meta.verify = run.verify?.map(({ tail: _t, ...r }) => r)
  }
  if (run.voice?.tail) {
    code.voiceTail = run.voice.tail
    const { tail: _t, ...v } = run.voice
    meta.voice = v
  }
  if (run.note != null) {
    code.note = run.note
    delete meta.note
  }
  for (const k of ['error', 'pushError', 'deployError'] as const) {
    if (multi(run[k])) {
      code[k] = run[k]
      meta[k] = firstLine(run[k])
    }
  }
  return { meta, code }
}

/** Put the repo store's code back on a metadata-only run. Missing pieces stay as they are. */
export function joinCode(meta: RunRecord, code: RunCode | null): RunRecord {
  if (!code) return meta
  const run: RunRecord = { ...meta }
  if (code.diff != null) run.diff = code.diff
  if (code.strictText && run.strict) run.strict = { ...run.strict, text: code.strictText }
  if (code.planText && run.plan) run.plan = { ...run.plan, text: code.planText }
  if (code.verifyTails && run.verify) run.verify = run.verify.map((r) => (code.verifyTails?.[r.script] ? { ...r, tail: code.verifyTails[r.script] } : r))
  if (code.voiceTail && run.voice) run.voice = { ...run.voice, tail: code.voiceTail }
  if (code.note != null) run.note = code.note
  for (const k of ['error', 'pushError', 'deployError'] as const) {
    if (code[k] != null && run[k] != null && String(code[k]).startsWith(String(run[k]))) run[k] = code[k]
  }
  return run
}

const empty = (c: RunCode): boolean => Object.keys(c).length === 0

export function writeCode(dir: string, code: RunCode): void {
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'code.json')
  if (empty(code)) {
    rmSync(dest, { force: true })
    return
  }
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(code))
  renameSync(tmp, dest)
}

export function readCode(dir: string | null): RunCode | null {
  if (!dir) return null
  try {
    return JSON.parse(readFileSync(join(dir, 'code.json'), 'utf8')) as RunCode
  } catch {
    return null
  }
}
