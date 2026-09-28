import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { RunRecord, VerifyRow } from '../../shared/factory.ts'

export { REVIEW_MAX } from '../../shared/factory.ts'

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

/**
 * Opus as the builder (Grok and Cursor could not run, or the third review fix): same as opusArgs but
 * bypassPermissions so it can edit. Never used for plan or strict review.
 */
export function opusBuildArgs(prompt: string): string[] {
  return ['-p', prompt, '--model', 'opus', '--effort', 'medium', '--permission-mode', 'bypassPermissions', '--output-format', 'text']
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
  /** Builder turn: opusBuildArgs (can edit). Plan and review never set this. */
  build?: boolean
  /** Stdout as it arrives. */
  onText?: (chunk: string) => void
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
      child = (o.spawnFn || spawn)(o.bin as string, o.build ? opusBuildArgs(o.prompt) : opusArgs(o.prompt), {
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
      o.onText?.(String(d))
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

export function strictPrompt(o: { task: string; tier: string; risk: string; base: string; diff: string; workRepo: string; verify?: VerifyRow[] }): string {
  const rows = (o.verify || []).filter((r) => r.status !== 'skipped')
  return [
    `Use the strict code review skill at ${STRICT_SKILL_PATH}. Read it from disk and follow it.`,
    'Review this change as an independent reviewer. You cannot edit files. Do not push or deploy.',
    `Work repo: ${o.workRepo}`,
    `Tier: ${o.tier}. Risk: ${o.risk}. Base: ${o.base}.`,
    `Task: ${String(o.task || '').slice(0, 4000)}`,
    ...(rows.length
      ? ['', 'Verify results (a fail that names a changed file is a gap):', ...rows.map((r) => `- npm run ${r.script}: ${r.status}${r.status === 'fail' && r.tail ? `\n${String(r.tail).split('\n').slice(-8).join('\n')}` : ''}`)]
      : []),
    '',
    `Diff against the base (cut at 60k characters; run \`git diff ${o.base}\` in the work repo for the rest):`,
    o.diff,
    '',
    'Name every real defect with file and line. Any gap is FAIL: nits, non-blockers, and follow-ups count as gaps.',
    'Some asks no edit in this repo can close: splitting into separate changes, a person signing off, a live run that costs money or sends mail, a before/after on real data, deploy or ops steps. Put those in a block that starts with a line `OUTSIDE:` followed by `- ` bullets, before the GAPS line. They are not gaps and never make it FAIL. A defect in this diff is never OUTSIDE.',
    'Do not write nit, non-blocker, or follow-up in a PASS review; if you would, it is a FAIL.',
    'End with two lines: GAPS: <n> (how many gaps you found), then exactly PASS or FAIL. PASS only with GAPS: 0.'
  ].join('\n')
}

export function planPrompt(o: { task: string; workRepo: string; plans: string[]; reasons: string[]; tier?: 'T2' | 'T3'; guide?: string[] }): string {
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
    ...(o.plans.length ? ['', 'Earlier plans:', ...o.plans.map((p) => `- ${p}`)] : []),
    ...(o.reasons.filter(Boolean).length ? ['', 'Why they were rejected:', ...o.reasons.filter(Boolean).map((r) => `- ${r}`)] : []),
    ...(o.guide?.filter(Boolean).length ? ['', "Joe's notes for this plan:", ...o.guide.filter(Boolean).map((g) => `- ${g}`)] : [])
  ].join('\n')
}

/** PASS or FAIL from the last non-empty line, else null. */
export function verdict(text: string): 'PASS' | 'FAIL' | null {
  const last = lastLine(text).replace(/[*`_.]/g, '').trim().toUpperCase()
  return last === 'PASS' ? 'PASS' : last === 'FAIL' ? 'FAIL' : null
}

/** Words that name a leftover. A review that names one did not find zero gaps. */
const LEFTOVER = /\b(nit(?:s|pick(?:s|ing|y)?)?|non-?block(?:ers?|ing)|not a blocker|for (?:a |another )?later|optional follow|follow[- ]?ups?)\b/i
/**
 * One whole leftover word, not followed by a colon (so "non-blocker: x" still names an item). The
 * \b stops backtracking to "nit" in "nits: x" or "nitpick: x" to dodge the colon check.
 */
const LEFT_WORD = String.raw`(?:nit(?:s|pick(?:s|ing|y)?)?|non-?block(?:ers?|ing)|follow[- ]?ups?)\b(?!\s*:)`
/**
 * Words that turn a none into "none, but here is one": "No nits, however rename x", "No nits. Still,
 * rename x". One at the start of the next sentence keeps the none a leftover.
 */
const CONTRAST = String.raw`\b(?:except|besides|other than|apart from|but|however|though|although|yet|still|that said|only|just|nevertheless|nonetheless|instead|meanwhile|save for|aside from)\b`
/** A leftover word with an optional plain noun after it: "non-blocking issues". */
const LEFT_ITEM = String.raw`${LEFT_WORD}(?:\s+(?:issues?|items?|notes?|comments?|concerns?))?`
/** Only quote, bullet, or emphasis marks may come before a none: the claim must open its sentence. */
const LEAD = String.raw`^[\s"'*_>\-]*`
/**
 * "No nits.", "No follow-ups needed", "Nits: none", "No nits, non-blockers, or follow-ups.", "Nothing
 * to leave for later". A none is only a none when it is the whole sentence: nothing before it but
 * marks, nothing after it but trailers (needed, found, remain...). "Rename x, no other nits",
 * "Clean, no follow-ups needed", and "No nits, however rename x" are not nones. "No other / further /
 * more / remaining nits" is not a none either: it implies some were named.
 */
const NONE_LEFT = [
  new RegExp(
    LEAD +
      String.raw`(?:no|zero|without(?: any)?|not any|free of)\s+` +
      LEFT_ITEM +
      String.raw`(?:\s*,\s*(?:(?:or|and|nor)\s+)?${LEFT_ITEM}|\s+(?:or|and|nor)\s+${LEFT_ITEM})*` +
      String.raw`(?:\s+(?:are\s+|is\s+)?(?:needed|required|found|left|remains?|remaining))?\s*$`,
    'i'
  ),
  new RegExp(LEAD + String.raw`(?:nit(?:s|pick(?:s|ing|y)?)?|non-?block(?:ers?|ing)|follow[- ]?ups?)\s*:\s*(?:none|0|n\/a)\s*$`, 'i'),
  new RegExp(LEAD + String.raw`nothing\s+(?:(?:is|was)\s+)?(?:to\s+)?(?:leave|left)\s+(?:(?:it|this|that|them)\s+)?for later\s*$`, 'i')
]

/**
 * Drop each sentence that is only a none claim, unless the next sentence opens with a contrast.
 * Sentences end at . ; ! ? before a space, or at a newline, so "a.ts" stays whole.
 */
function stripNones(body: string): string {
  const sentences = body.split(/(?:[.;!?]+(?=\s|$)|\n)+/)
  const opensWithContrast = new RegExp(String.raw`^[\s"'*_>\-,]*${CONTRAST}`, 'i')
  return sentences
    .map((s, i) => {
      const next = sentences.slice(i + 1).find((n) => n.trim()) || ''
      if (opensWithContrast.test(next)) return s
      return NONE_LEFT.some((re) => re.test(s)) ? '' : s
    })
    .join('\n')
}

const OUTSIDE_CAP = 12
const OUTSIDE_CHARS = 300

/**
 * The OUTSIDE block cut out of a review: `OUTSIDE:` then `- ` bullets. The first line that is not a
 * bullet (a blank line, a defect, a GAPS line, a verdict) ends the block and stays in the review.
 * Every block counts.
 */
export function splitOutside(text: string): { review: string; outside: string[] } {
  const lines = String(text || '').split('\n')
  const keep: string[] = []
  const outside: string[] = []
  let inBlock = false
  for (const line of lines) {
    const bare = line.trim().replace(/^[*_`]+|[*_`]+$/g, '')
    if (/^OUTSIDE\s*:\s*$/i.test(bare)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      const m = /^\s*[-*•]\s+(.+)$/.exec(line)
      if (m) {
        outside.push(m[1].trim().slice(0, OUTSIDE_CHARS))
        continue
      }
      // A blank line before any bullet is spacing; after one it ends the block, so a defect bullet
      // further down is never swept into follow-ups.
      if (!line.trim() && !outside.length) continue
      inBlock = false
    }
    keep.push(line)
  }
  return { review: keep.join('\n'), outside: outside.slice(0, OUTSIDE_CAP) }
}

export type ReviewAccept = { status: 'pass' | 'fail'; gaps: number | null; why: string }

/**
 * The controller's reading of an Opus review, not Opus's story. PASS needs a `GAPS: 0` line and a
 * body that names no nits, non-blockers, or follow-ups. Anything else is a fail with a why.
 */
export function reviewAccept(text: string): ReviewAccept {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const v = verdict(text)
  // Every GAPS line counts: a later "GAPS: 0" does not undo an earlier "GAPS: 2".
  let gaps: number | null = null
  const gapsAt = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const m = /^[*`_\s]*GAPS\s*:\s*(\d+)/i.exec(lines[i])
    if (!m) continue
    gaps = Math.max(gaps ?? 0, Number(m[1]))
    gapsAt.add(i)
  }
  if (v === null) return { status: 'fail', gaps, why: 'Reviewer did not end with PASS or FAIL.' }
  if (v === 'FAIL') return { status: 'fail', gaps, why: 'FAIL' }
  if (gaps === null) return { status: 'fail', gaps, why: 'PASS without GAPS: 0' }
  if (gaps > 0) return { status: 'fail', gaps, why: 'PASS named gaps' }
  const body = lines.filter((_, i) => !gapsAt.has(i) && i !== lines.length - 1).join('\n')
  if (LEFTOVER.test(stripNones(body))) return { status: 'fail', gaps, why: 'PASS named gaps' }
  return { status: 'pass', gaps: 0, why: '' }
}
