import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DONE_CONTRACT } from '../../shared/factory-done.ts'
import { strictRequired, verifyLabel, type RunRecord, type UsageRow, type VerifyRow } from '../../shared/factory.ts'
import { claudeRow, parseClaudeEnvelope, usageRow, type ClaudeEnvelope } from './usage.ts'

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
/**
 * parsed: stdout was one whole Claude result envelope and text is its `result`. Otherwise text is the
 * raw stdout tail for a person to read, and no verdict, plan, or build may be taken from it.
 */
export type OpusResult = { found: boolean; code: number; text: string; last: string; parsed: boolean; usage: UsageRow; isError?: boolean }

/** Stdout kept for the JSON envelope. Over this, the answer is not read at all. */
export const OPUS_JSON_MAX = 16 * 1024 * 1024
const RAW_TAIL = 400_000

/** slim: no tools, no MCP, no skills, no saved session (the ask approver: a small answer, nothing to act with). */
export type OpusRun = { model?: string; effort?: string; slim?: boolean }

const SLIM = ['--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']

/**
 * Strict review effort. Opus 5.5 low matched or beat medium on the Factory reviewer eval (held-out 13/14 vs
 * 11/14, same bugs caught, about half the tokens and time), agency-brain
 * projects/factory-evals/log/2026-09-29-reviewer-round-2.md. Joe said yes 2026-09-29. Plan and build stay medium.
 */
export const STRICT_EFFORT = 'low'

/** Factory Opus plan and build run at medium (same as the Kennel merge gate). Claude has no xhigh. */
export function opusArgs(prompt: string, o: OpusRun = {}): string[] {
  return ['-p', prompt, '--model', o.model || 'opus', '--effort', o.effort || 'medium', '--permission-mode', 'plan', ...(o.slim ? SLIM : []), '--output-format', 'json']
}

/** Every tool the Opus builder has must come to Brain as an ask, Claude's own read-only allows included. */
export const OPUS_ASK_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']

/**
 * Opus as the builder (Grok and Cursor could not run, or a late review fix): stream-json both ways, so
 * every tool use arrives as a can_use_tool ask Brain answers. The work repo's allow rules, hooks and MCP
 * servers do not load (its CLAUDE.md still does); no subagents. The brief goes on stdin. Never used for
 * plan or strict review.
 */
export function opusBuildArgs(o: OpusRun = {}): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model || 'opus',
    '--effort',
    o.effort || 'medium',
    '--permission-mode',
    'default',
    '--permission-prompts',
    'host',
    '--permission-prompt-tool',
    'stdio',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--disallowedTools',
    'Task,Agent',
    '--settings',
    JSON.stringify({ permissions: { ask: OPUS_ASK_TOOLS } })
  ]
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
  /** Stdout as it arrives. */
  onText?: (chunk: string) => void
  /** Which job this call is, for its usage row. */
  phase?: UsageRow['phase']
  run?: OpusRun
  /** Test hook: a smaller stdout cap. */
  maxBytes?: number
}): Promise<OpusResult> {
  const started = Date.now()
  const base = () => ({ phase: o.phase || 'review', cli: 'claude' as const, effort: o.run?.effort || 'medium', ms: Date.now() - started })
  if (!o.bin) return Promise.resolve({ found: false, code: 127, text: '', last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
  const max = o.maxBytes ?? OPUS_JSON_MAX
  return new Promise((resolve) => {
    let settled = false
    let text = ''
    let over = false
    let err = ''
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const env = over || code !== 0 ? null : parseClaudeEnvelope(text)
      const raw = text.slice(-RAW_TAIL).trim() || err.trim()
      const body = env ? String(env.result || '').trim() : raw
      resolve({ found: true, code, text: body, last: lastLine(body), parsed: !!env, usage: claudeRow(base(), env), ...(env?.is_error ? { isError: true } : {}) })
    }
    let child: ChildProcess
    try {
      child = (o.spawnFn || spawn)(o.bin as string, opusArgs(o.prompt, o.run), {
        cwd: o.cwd,
        env: opusEnv(o.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      })
    } catch (e) {
      resolve({ found: true, code: 127, text: String((e as Error).message || e), last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
      return
    }
    child.stdout?.on('data', (d: Buffer) => {
      text += String(d)
      if (text.length > max) {
        over = true
        text = text.slice(-RAW_TAIL)
      }
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
        resolve({ found: false, code: 127, text: '', last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
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

/** Claude tool name to the ACP kind the Factory checks read. Any other tool is 'other'. */
const TOOL_KIND: Record<string, string> = {
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute'
}

const PATH_FIELDS = ['file_path', 'path', 'notebook_path']

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export type AcpAsk = { params: { title: string; toolCall: { title: string; kind: string; rawInput: Record<string, unknown>; locations: { path: string }[] } } }

/**
 * One can_use_tool request in the shape of a Grok ACP ask, so both builders go through one route. Path
 * fields resolve against cwd (Claude's cwd is the work repo; Grok's is the brain). Title: the command
 * for Bash, else the tool and what it names.
 */
export function toolAsk(tool: string, input: Record<string, unknown>, cwd: string): AcpAsk {
  const rawInput = { ...input }
  const locations: { path: string }[] = []
  for (const f of PATH_FIELDS) {
    const v = input[f]
    if (typeof v !== 'string' || !v) continue
    rawInput[f] = resolvePath(cwd, v)
    locations.push({ path: String(rawInput[f]) })
  }
  const names = locations[0]?.path || input.pattern || input.url || input.query || ''
  const title = tool === 'Bash' ? String(input.command || 'Bash') : `${tool} ${String(names)}`.trim()
  return { params: { title, toolCall: { title, kind: TOOL_KIND[tool] || 'other', rawInput, locations } } }
}

export type ToolAsk = { id: string; tool: string; input: Record<string, unknown>; msg: AcpAsk }
export type AskAnswer = { allow: true } | { allow: false; message: string }

/**
 * One Opus builder turn: `claude -p` in stream-json with the brief on stdin. Each can_use_tool ask goes
 * to onAsk (asks may overlap) and is answered once on its own request id; an allow sends the input back
 * unchanged. The timeout counts only time with no ask open. Stdin closes after the result line, which
 * gives the text and usage. Abort kills the process group, aborts every open ask, and drops late answers.
 */
export function runOpusBuild(o: {
  cwd: string
  prompt: string
  env: NodeJS.ProcessEnv
  bin?: string | null
  timeoutMs: number
  spawnFn?: SpawnFn
  signal?: AbortSignal
  run?: OpusRun
  onAsk: (ask: ToolAsk, signal: AbortSignal) => Promise<AskAnswer>
}): Promise<OpusResult> {
  const started = Date.now()
  const base = () => ({ phase: 'build' as const, cli: 'claude' as const, effort: o.run?.effort || 'medium', ms: Date.now() - started })
  if (!o.bin) return Promise.resolve({ found: false, code: 127, text: '', last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
  return new Promise((resolve) => {
    let child: ChildProcess
    let settled = false
    let result: ClaudeEnvelope | null = null
    let buf = ''
    let raw = ''
    let err = ''
    const open = new Map<string, { ctl: AbortController; input: Record<string, unknown> }>()
    let left = o.timeoutMs
    let since = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const kill = () => {
      try {
        if (!child.pid) throw new Error('no pid')
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const a of open.values()) a.ctl.abort()
      open.clear()
      const body = result ? String(result.result || '').trim() : raw.trim() || err.trim()
      resolve({ found: true, code, text: body, last: lastLine(body), parsed: !!result, usage: claudeRow(base(), result), ...(result?.is_error ? { isError: true } : {}) })
    }
    const arm = () => {
      since = Date.now()
      timer = setTimeout(() => {
        kill()
        raw = raw || 'Builder timed out.'
        finish(124)
      }, Math.max(0, left))
    }
    const hold = () => {
      clearTimeout(timer)
      left -= Date.now() - since
    }
    const send = (msg: unknown) => {
      if (settled) return
      try {
        child.stdin?.write(JSON.stringify(msg) + '\n')
      } catch {
        /* the process is gone */
      }
    }
    const answer = (id: string, a: AskAnswer) => {
      const ask = open.get(id)
      if (!ask || settled) return
      open.delete(id)
      const response = a.allow ? { behavior: 'allow', updatedInput: ask.input } : { behavior: 'deny', message: a.message }
      send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
      if (!open.size) arm()
    }
    const onLine = (line: string) => {
      let m: Record<string, unknown>
      try {
        m = rec(JSON.parse(line))
      } catch {
        return
      }
      if (m.type === 'result') {
        result = parseClaudeEnvelope(line)
        try {
          child.stdin?.end()
        } catch {
          /* gone */
        }
        return
      }
      if (m.type !== 'control_request') return
      const id = String(m.request_id || '')
      const req = rec(m.request)
      if (req.subtype !== 'can_use_tool') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Brain does not answer this request.' } })
        return
      }
      if (!id || open.has(id)) return
      const tool = String(req.tool_name || '')
      const input = rec(req.input)
      const ctl = new AbortController()
      if (!open.size) hold()
      open.set(id, { ctl, input })
      const deny = (e: unknown): AskAnswer => ({ allow: false, message: `Brain could not check this ask: ${String((e as Error)?.message || e).slice(0, 160)}` })
      let pending: Promise<AskAnswer>
      try {
        pending = o.onAsk({ id, tool, input, msg: toolAsk(tool, input, o.cwd) }, ctl.signal)
      } catch (e) {
        pending = Promise.resolve(deny(e))
      }
      void pending.catch(deny).then((a) => answer(id, a))
    }
    try {
      // Own process group, so a kill takes what the builder started too.
      child = (o.spawnFn || spawn)(o.bin as string, opusBuildArgs(o.run), { cwd: o.cwd, env: opusEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (e) {
      resolve({ found: true, code: 127, text: String((e as Error).message || e), last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
      return
    }
    child.stdin?.on('error', () => {
      /* EPIPE after a kill */
    })
    const utf8 = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => {
      const d = utf8.write(chunk)
      raw = (raw + d).slice(-RAW_TAIL)
      buf += d
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onLine(line)
      }
      if (buf.length > OPUS_JSON_MAX) buf = ''
    })
    child.stderr?.on('data', (d: Buffer) => {
      err = (err + String(d)).slice(-8000)
    })
    child.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ found: false, code: 127, text: '', last: '', parsed: false, usage: usageRow(base(), { ok: false }) })
        return
      }
      err += String(e.message || e)
      finish(127)
    })
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim())
      finish(code ?? 1)
    })
    send({ type: 'user', message: { role: 'user', content: o.prompt } })
    arm()
    const stop = () => {
      kill()
      finish(130)
    }
    if (o.signal?.aborted) stop()
    else o.signal?.addEventListener('abort', stop, { once: true })
  })
}

/** The shared rule (shared/factory.ts strictRequired): T2/T3, elevated or critical, MyPuppies, or Ship in advance. */
export const strictNeeded = strictRequired

export function strictPrompt(o: { task: string; tier: string; risk: string; base: string; diff: string; workRepo: string; verify?: VerifyRow[] }): string {
  const rows = (o.verify || []).filter((r) => r.status !== 'skipped')
  return [
    `Use the strict code review skill at ${STRICT_SKILL_PATH}. Read it from disk and follow it.`,
    'Review this change as an independent reviewer. You cannot edit files. Do not push or deploy.',
    `Work repo: ${o.workRepo}`,
    `Tier: ${o.tier}. Risk: ${o.risk}. Base: ${o.base}.`,
    `Task: ${String(o.task || '').slice(0, 4000)}`,
    ...(rows.length
      ? ['', 'Verify results (a fail that names a changed file is a gap):', ...rows.map((r) => `- ${verifyLabel(r)}: ${r.status}${r.status === 'fail' && r.tail ? `\n${String(r.tail).split('\n').slice(-8).join('\n')}` : ''}`)]
      : []),
    '',
    `Diff against the base (cut at 60k characters; run \`git diff ${o.base}\` in the work repo for the rest):`,
    o.diff,
    '',
    DONE_CONTRACT,
    'Where the skill and this contract disagree, follow the contract.',
    'A green check that only restates the new code is a fail.',
    'Name every real defect with file and line.',
    'Some asks no edit in this repo can close: a person signing off, a live run that costs money or sends mail, a before/after on real data, deploy or ops steps. Put those, and anything the contract calls OUTSIDE, in a block that starts with a line `OUTSIDE:` followed by `- ` bullets, before the GAPS line. They are not gaps and never make it FAIL. A defect in this diff is never OUTSIDE.',
    'End with two lines: GAPS: <n> (how many gaps you found), then exactly PASS or FAIL. PASS only with GAPS: 0.'
  ].join('\n')
}

export function planPrompt(o: { task: string; workRepo: string; plans: string[]; reasons: string[]; tier?: 'T2' | 'T3'; guide?: string[] }): string {
  const t3 = o.tier === 'T3'
  return [
    'Write the implementation plan for this change. You cannot edit files; read the repo as needed.',
    DONE_CONTRACT,
    `Work repo: ${o.workRepo}`,
    t3
      ? 'Limit T3: no file or line cap; no lockfile changes, no migrations.'
      : 'Limit T2: up to 10 files, 600 changed lines, no lockfile changes, no migrations.',
    'Write the plan before any edit: files, steps, and one check that fails if the behavior is wrong. Do not edit files.',
    ...(t3 ? ['Then one JSON line: {"slices":[{"title":"...","files":["rel/path.ts"]}]}. Paths relative to the work repo; slices that share no files run in parallel.'] : []),
    t3
      ? 'When the plan can be written, the very last line is exactly PLAN: READY, after the slices JSON line.'
      : 'When the plan can be written, the very last line is exactly PLAN: READY.',
    'When it cannot (this is the wrong repo, or nothing here can make the change): write why; if you know the right repo, add a line REPO: <absolute path>; the very last line is exactly PLAN: BLOCKED.',
    `Task: ${String(o.task || '').slice(0, 4000)}`,
    ...(o.plans.length ? ['', 'Earlier plans:', ...o.plans.map((p) => `- ${p}`)] : []),
    ...(o.reasons.filter(Boolean).length ? ['', 'Why they were rejected:', ...o.reasons.filter(Boolean).map((r) => `- ${r}`)] : []),
    ...(o.guide?.filter(Boolean).length ? ['', "Joe's notes for this plan:", ...o.guide.filter(Boolean).map((g) => `- ${g}`)] : [])
  ].join('\n')
}

/**
 * The planner's verdict from its last non-empty line, and the plan without the verdict line (and
 * without the REPO line of a blocked plan). null: the planner gave no verdict.
 */
export function planVerdict(text: string): { verdict: 'ready' | 'blocked' | null; repo: string; body: string } {
  const lines = String(text || '').trimEnd().split('\n')
  const last = (lines[lines.length - 1] || '').trim()
  const verdict = last === 'PLAN: READY' ? 'ready' : last === 'PLAN: BLOCKED' ? 'blocked' : null
  if (!verdict) return { verdict, repo: '', body: String(text || '').trim() }
  const rest = lines.slice(0, -1)
  let repo = ''
  if (verdict === 'blocked') {
    for (let i = rest.length - 1; i >= 0; i--) {
      const m = /^\s*REPO:\s*(\S.*?)\s*$/.exec(rest[i])
      if (m) {
        repo = m[1]
        rest.splice(i, 1)
        break
      }
      if (rest[i].trim()) break
    }
  }
  return { verdict, repo, body: rest.join('\n').trim() }
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
function sentencesOf(body: string): string[] {
  return body.split(/(?:[.;!?]+(?=\s|$)|\n)+/)
}

/** A leftover that only names an earlier round is not a current gap. */
function isHistorySentence(sentence: string): boolean {
  return /\b(earlier|previous|prior)\s+(rounds?|reviews?|passes?)\b/i.test(sentence)
}

function currentLeftover(body: string): boolean {
  return sentencesOf(stripNones(body)).some((s) => LEFTOVER.test(s) && !isHistorySentence(s))
}

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

/** A security defect or a revert of someone else's work stays a gap even under OUTSIDE. */
const SECURITY_OR_REVERT =
  /\b(path traversal|directory traversal|sql injection|command injection|xss|csrf|ssrf|auth bypass|privilege escalation)\b|\brevert(?:s|ed|ing)?\b[^.\n]{0,160}\b(someone else(?:'s)?|another (?:person|author|developer)|other people(?:'s)?)\b|\b(someone else(?:'s)?|another (?:person|author|developer))\b[^.\n]{0,160}\brevert(?:s|ed|ing)?\b/i

function outsideStays(bullet: string): boolean {
  return SECURITY_OR_REVERT.test(bullet)
}

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
  let seenBullet = false
  for (const line of lines) {
    const bare = line.trim().replace(/^[*_`]+|[*_`]+$/g, '')
    if (/^OUTSIDE\s*:\s*$/i.test(bare)) {
      inBlock = true
      seenBullet = false
      continue
    }
    if (inBlock) {
      const m = /^\s*[-*•]\s+(.+)$/.exec(line)
      if (m) {
        const bullet = m[1].trim().slice(0, OUTSIDE_CHARS)
        seenBullet = true
        if (outsideStays(bullet)) keep.push(line)
        else outside.push(bullet)
        continue
      }
      // A blank line before any bullet is spacing; after one it ends the block, so a defect bullet
      // further down is never swept into follow-ups. A security bullet counts as a bullet.
      if (!line.trim() && !seenBullet) continue
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
  if (SECURITY_OR_REVERT.test(body)) return { status: 'fail', gaps: Math.max(gaps ?? 0, 1), why: 'PASS named gaps' }
  if (currentLeftover(body)) return { status: 'fail', gaps, why: 'PASS named gaps' }
  return { status: 'pass', gaps: 0, why: '' }
}
