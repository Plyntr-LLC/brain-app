import { resolveClaudeRun } from '../shared/claude-defaults'
import type { StreamEvent } from './ai-cli'
import { BROWSER_RULE, CHAT_RULES, claudeChatMode, claudeChatPermissionArgs } from '../shared/chat-reach'
import { claudeBrowserArgs } from './browser-bridge'
import { binEnv, resolveBin } from './ai-cli'
import { claudeContent, type Attach } from './attach'
import { emitChat, markChatBusy } from './chat-fan'
import { controlAnswered, controlTimedOut, newPlanControls, type PlanControls } from './claude-plan'
import { asRecord, asText, fileHits, spawnBin } from './line-rpc'
import { captureToolHook, wrapPromptWithHooks } from './project-hooks'
import { setupTrace } from './setup-trace'
import { handoffLabel } from '../shared/agent-label'

const RULES = CHAT_RULES

type Sess = {
  tabId: string
  cwd: string
  model?: string
  effort?: string
  proc: ReturnType<typeof spawnBin>
  buf: string
  onEvent?: (ev: StreamEvent) => void
  waiting: { resolve: () => void } | null
  text: string
  /** Thinking streamed this turn. A later full thinking block is not shown again. */
  thought: string
  autoThought: string
  dead: boolean
  n: number
  promptGen: number
  controls?: PlanControls
  /** Text of the turn Claude started on its own, so a result-only answer is not shown twice. */
  autoText?: string
  /** Claude's own turn has been announced to the chat (turn:auto). */
  autoLive?: boolean
  /**
   * Prompts written to Claude that it has not taken yet, oldest first. `--replay-user-messages` echoes
   * each one back the moment Claude takes it, in the turn that will answer it.
   */
  unacked: number[]
  /** Prompts Claude took while an interrupted turn was closing: they belong to the next turn. */
  carry: number[]
  /** The turn Claude is running (init to result). gens: prompts it took. auto: it started with none. */
  turn: { gens: number[]; auto: boolean } | null
  /** An interrupt was sent: the open turn is ending, and what Claude takes now is for the next one. */
  closing: boolean
  /** The prompt claudePrompt is waiting on (0: none). An interrupted prompt is no longer active. */
  active: number
  /** Background tasks Claude reported (system background_tasks_changed), with a label and start time. */
  bg: Map<string, { label: string; at: number }>
  /** Handoff labels by tool_use id, so a background task reads "asking Grok" not its raw description. */
  toolLabels: Map<string, string>
}

const sessions = new Map<string, Sess>()
/** Tabs in plan mode. Kept across a model or effort respawn; cleared by /clear (claudeReset). */
const planTabs = new Set<string>()
const booting = new Map<string, Promise<void>>()

/** Announce the turn Claude started on its own (a background task it waited on finished). */
function startAuto(s: Sess): void {
  if (s.autoLive) return
  s.autoLive = true
  s.autoText = ''
  s.autoThought = ''
  markChatBusy(s.tabId, true)
  emitChat({ tabId: s.tabId, cli: 'claude', ev: { kind: 'status', data: 'turn:auto' } })
}

/** Close that turn. A prompt still waiting keeps the tab busy, so its own answer is not cut off. */
function endAuto(s: Sess, result: string): void {
  // A wake that sent only a result still shows as its own turn.
  if (!s.autoLive) startAuto(s)
  const chat = (ev: StreamEvent) => emitChat({ tabId: s.tabId, cli: 'claude', ev })
  if (result && !s.autoText) chat({ kind: 'text', data: result })
  s.autoText = ''
  s.autoLive = false
  if (s.active) chat({ kind: 'status', data: 'turn:auto-done' })
  else chat({ kind: 'done' })
}

function openTurn(s: Sess): NonNullable<Sess['turn']> {
  const gens = s.carry
  s.carry = []
  // A turn with no prompt waiting to be taken is Claude's own (a background task finished).
  const auto = !gens.length && !s.unacked.length && s.promptGen > 0
  s.turn = { gens, auto }
  s.thought = ''
  if (auto) startAuto(s)
  return s.turn
}

/**
 * Where this turn's events go: the waiting prompt, the chat (Claude's own turn), or nowhere (a turn
 * that only answers interrupted prompts). Both live sinks reach the same chat; the turn's prompts
 * decide which one ends.
 */
function sink(s: Sess): ((ev: StreamEvent) => void) | undefined {
  const t = s.turn || openTurn(s)
  if (s.active && t.gens.includes(s.active)) return s.onEvent
  // Ours before Claude's echo lands: a prompt is waiting to be taken and this turn did not start as Claude's own.
  if (!t.auto && !t.gens.length && s.active && s.unacked.includes(s.active)) return s.onEvent
  if (t.auto) return (ev) => emitChat({ tabId: s.tabId, cli: 'claude', ev })
  return undefined
}

function emitBg(s: Sess): void {
  const list = [...s.bg.values()].map((t) => ({ label: t.label, at: t.at }))
  emitChat({ tabId: s.tabId, cli: 'claude', ev: { kind: 'status', data: 'bg:' + JSON.stringify(list) } })
}

/** Thinking is delta.thinking. asText only reads .text, so a thinking chunk would vanish. */
function claudeDelta(delta: Record<string, unknown>): string {
  const dType = String(delta.type || '')
  if (dType === 'signature_delta' || dType === 'redacted_thinking') return ''
  if (dType === 'thinking_delta' || dType === 'thought_delta') {
    return typeof delta.thinking === 'string' ? delta.thinking : ''
  }
  if (dType === 'text_delta') return typeof delta.text === 'string' ? delta.text : ''
  return ''
}

function handleClaude(s: Sess, line: string): void {
  const t = line.trim()
  if (!t.startsWith('{')) return
  let o: Record<string, unknown>
  try {
    o = JSON.parse(t) as Record<string, unknown>
  } catch {
    return
  }
  const type = String(o.type || '')
  if (type === 'system') {
    const sub = String(o.subtype || '')
    // Every turn opens with init.
    if (sub === 'init' && s.promptGen > 0) {
      s.closing = false
      openTurn(s)
    }
    if (sub === 'task_started') {
      const id = String(o.task_id || '')
      const label = s.toolLabels.get(String(o.tool_use_id || '')) || String(o.description || 'A background task')
      if (id) s.bg.set(id, { label: label.slice(0, 90), at: Date.now() })
      emitBg(s)
    } else if (sub === 'background_tasks_changed' && Array.isArray(o.tasks)) {
      const live = new Set((o.tasks as unknown[]).map((t) => String(asRecord(t).task_id || '')))
      for (const id of [...s.bg.keys()]) if (!live.has(id)) s.bg.delete(id)
      for (const t of o.tasks as unknown[]) {
        const r = asRecord(t)
        const id = String(r.task_id || '')
        if (id && !s.bg.has(id)) s.bg.set(id, { label: String(r.description || 'A background task').slice(0, 90), at: Date.now() })
      }
      emitBg(s)
    } else if (sub === 'task_notification' || sub === 'task_updated') {
      const id = String(o.task_id || '')
      const status = String(o.status || asRecord(o.patch).status || '')
      if (id && (sub === 'task_notification' || /completed|failed|killed|stopped/.test(status)) && s.bg.delete(id)) emitBg(s)
    }
    return
  }
  if (type === 'control_response') {
    const r = asRecord(o.response)
    if (!s.controls) return
    const out = controlAnswered(s.controls, String(r.request_id || ''), String(r.subtype || '') === 'success', planTabs)
    // A plan switch confirmed after the 4s wait: tell the chat so it leaves "unknown".
    if (out.kind === 'late' && out.ok) {
      emitChat({ tabId: out.tabId, cli: 'claude', ev: { kind: 'mode', mode: out.on ? 'plan' : 'default' } })
    }
    return
  }
  if (type === 'stream_event') {
    const ev = asRecord(o.event)
    const delta = asRecord(ev.delta)
    const dType = String(delta.type || '')
    const bit = claudeDelta(delta)
    if (!bit) return
    const out = sink(s)
    if (!out) return
    if (dType === 'thinking_delta' || dType === 'thought_delta') {
      const autoThink = !!s.turn?.auto && !(s.active && s.turn.gens.includes(s.active))
      if (autoThink) s.autoThought += bit
      else s.thought += bit
      out({ kind: 'thought', data: bit })
    } else if (dType === 'text_delta') {
      if (s.turn?.auto && !(s.active && s.turn.gens.includes(s.active))) s.autoText += bit
      else s.text += bit
      out({ kind: 'text', data: bit })
    }
    return
  }
  if (type === 'user' && o.isReplay === true) {
    // Claude took a prompt we wrote (FIFO). It is answered by the turn running now, or the next one.
    const gen = s.unacked.shift()
    if (gen === undefined) return
    if (s.turn && !s.closing) s.turn.gens.push(gen)
    else s.carry.push(gen)
    return
  }
  if (type === 'user') {
    const msg = asRecord(o.message)
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      const b = asRecord(block)
      if (String(b.type || '') !== 'tool_result') continue
      const out = asText(b.content) || asText(b) || (typeof b.content === 'string' ? b.content : '')
      try {
        captureToolHook({
          cwd: s.cwd,
          kind: 'claude',
          sessionId: s.tabId,
          toolName: String(b.tool_name || b.name || 'tool'),
          toolOutput: String(out || ''),
          toolId: String(b.tool_use_id || b.toolUseId || '')
        })
      } catch {
        /* fail-open */
      }
    }
    return
  }
  if (type === 'assistant') {
    const msg = asRecord(o.message)
    const content = Array.isArray(msg.content) ? msg.content : []
    const out = sink(s)
    const auto = !!s.turn?.auto && !(s.active && s.turn.gens.includes(s.active))
    for (const block of content) {
      const b = asRecord(block)
      const bt = String(b.type || '')
      if (bt === 'tool_use') {
        const name = String(b.name || 'Working')
        const handoff = handoffLabel(name, b.input)
        if (handoff && b.id) s.toolLabels.set(String(b.id), handoff)
        if (out) {
          out({ kind: 'status', data: 'work:' + (handoff || name).slice(0, 80) })
          for (const ev of fileHits(b.input, name)) out(ev)
        }
      }
      if (!out) continue
      if (bt === 'thinking') {
        const thinking = typeof b.thinking === 'string' ? b.thinking : ''
        const already = auto ? s.autoThought : s.thought
        if (thinking && !already) {
          if (auto) s.autoThought += thinking
          else s.thought += thinking
          out({ kind: 'thought', data: thinking })
        }
      }
      if (bt === 'text' && asText(b) && !(auto ? s.autoText : s.text)) {
        if (auto) s.autoText += asText(b)
        else s.text += asText(b)
        out({ kind: 'text', data: asText(b) })
      }
    }
    return
  }
  if (type === 'result') {
    const result = typeof o.result === 'string' ? o.result : ''
    // A result with no turn open and nothing to say (an interrupt while idle) shows nothing.
    if (!s.turn && !result && !s.unacked.length) return
    const t = s.turn || { gens: [], auto: s.unacked.length === 0 }
    s.turn = null
    s.thought = ''
    s.autoThought = ''
    s.closing = false
    // Claude marks a turn it started for a finished background task. One that took none of our prompts
    // is its own, even when a prompt was waiting: the prompt keeps waiting for its real answer.
    const wake = String(asRecord(o.origin).kind || '') === 'task-notification'
    if (!t.gens.length) {
      if (t.auto || wake || !s.unacked.length) {
        // A wake that streamed before Claude's echo went out as the waiting prompt's text: it was the wake's.
        if (!t.auto && s.text) {
          s.autoText = s.text
          s.text = ''
        }
        endAuto(s, result)
        return
      }
      // Ours, but Claude never echoed the prompt: take the oldest waiting one.
      const gen = s.unacked.shift()
      if (gen !== undefined) t.gens.push(gen)
    }
    if (t.auto) {
      // You wrote during Claude's own turn and it answered you in that same turn: the prompt ends it.
      s.text = s.text || s.autoText || ''
      s.autoLive = false
      s.autoText = ''
      s.autoThought = ''
    }
    // A turn that only answers interrupted prompts never ends the prompt sent after them.
    if (!s.active || !t.gens.includes(s.active)) return
    if (result && !s.text && s.onEvent) {
      s.text = result
      s.onEvent({ kind: 'text', data: result })
    }
    s.waiting?.resolve()
    s.waiting = null
  }
}

/** Run the real Claude parser on one turn and return the events it would show. */
export function collectClaudeEvents(lines: string[]): StreamEvent[] {
  const events: StreamEvent[] = []
  const proc = { stdin: { destroyed: false, write: () => true } } as unknown as Sess['proc']
  const s: Sess = {
    tabId: 't',
    cwd: '/tmp',
    proc,
    buf: '',
    onEvent: (ev) => {
      events.push(ev)
    },
    waiting: null,
    text: '',
    thought: '',
    autoThought: '',
    dead: false,
    n: 0,
    promptGen: 1,
    unacked: [],
    carry: [],
    turn: { gens: [1], auto: false },
    closing: false,
    active: 1,
    bg: new Map(),
    toolLabels: new Map()
  }
  for (const line of lines) handleClaude(s, line)
  return events
}

function attach(s: Sess): void {
  s.proc.stdout?.on('data', (d) => {
    s.buf += String(d)
    const parts = s.buf.split('\n')
    s.buf = parts.pop() || ''
    for (const line of parts) handleClaude(s, line)
  })
  s.proc.stderr?.on('data', () => {
    /* keep process alive; errors arrive as result */
  })
  s.proc.on('exit', () => {
    s.dead = true
    s.waiting?.resolve()
    s.waiting = null
    // A dead Claude runs nothing in the background: clear the strip.
    if (s.bg.size) {
      s.bg.clear()
      emitBg(s)
    }
    if (sessions.get(s.tabId) === s) sessions.delete(s.tabId)
  })
}

function writeUser(s: Sess, text: string, files: Attach[] = []): void {
  if (text.includes('Explain this step.')) {
    setupTrace({ event: 'prompt', kind: 'claude', text, appTools: [], sendsAppTools: false, cwd: s.cwd })
  }
  const stdin = s.proc.stdin
  if (!stdin || stdin.destroyed) throw new Error('Claude stdin is closed')
  stdin.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: claudeContent(text, files) },
      parent_tool_use_id: null
    }) + '\n'
  )
}

function claudeLive(s: Sess): { model?: string; effort?: string } {
  return { model: s.model, effort: s.effort }
}

export async function claudeWarm(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<{ model?: string; effort?: string }> {
  const run = resolveClaudeRun(opts)
  const pending = booting.get(opts.tabId)
  if (pending) {
    await pending
    const have = sessions.get(opts.tabId)
    if (have && !have.dead && have.cwd === opts.cwd && have.model === run.model && have.effort === run.effort) {
      return claudeLive(have)
    }
  }
  const work = claudeWarmNow({ ...opts, ...run })
  booting.set(opts.tabId, work)
  try {
    await work
  } finally {
    booting.delete(opts.tabId)
  }
  const s = sessions.get(opts.tabId)
  return s ? claudeLive(s) : run
}

/** The warm Claude chat process for one tab. With Brain's browser running, it gets the brain-browser server for this tab and loses Joe's Chrome control. */
export function claudeChatArgs(o: { tabId: string; model: string; effort: string; plan: boolean }): string[] {
  const browser = claudeBrowserArgs(`chat:${o.tabId}`)
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Claude echoes each prompt when it takes it, so a reply is matched to the turn that answers it.
    '--replay-user-messages',
    ...claudeChatPermissionArgs(o.plan),
    '--permission-prompts',
    'none',
    '--append-system-prompt',
    browser.length ? `${RULES} ${BROWSER_RULE}` : RULES,
    '--model',
    o.model,
    '--effort',
    o.effort,
    ...browser
  ]
}

async function claudeWarmNow(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<void> {
  const run = resolveClaudeRun(opts)
  const have = sessions.get(opts.tabId)
  if (have && !have.dead && have.cwd === opts.cwd && have.model === run.model && have.effort === run.effort) return
  if (have) claudeClose(opts.tabId)
  const bin = resolveBin('claude')
  if (!bin) throw new Error('Claude is not installed on this computer')
  const args = claudeChatArgs({ tabId: opts.tabId, model: run.model, effort: run.effort, plan: planTabs.has(opts.tabId) })
  const proc = spawnBin(bin, args, opts.cwd, binEnv())
  const s: Sess = {
    tabId: opts.tabId,
    cwd: opts.cwd,
    model: run.model,
    effort: run.effort,
    proc,
    buf: '',
    waiting: null,
    text: '',
    thought: '',
    autoThought: '',
    dead: false,
    n: 0,
    promptGen: 0,
    unacked: [],
    carry: [],
    turn: null,
    closing: false,
    active: 0,
    bg: new Map(),
    toolLabels: new Map()
  }
  attach(s)
  sessions.set(opts.tabId, s)
}

export async function claudePrompt(opts: {
  tabId: string
  cwd: string
  text: string
  model?: string
  attachments?: Attach[]
  onEvent: (ev: StreamEvent) => void
}): Promise<string> {
  if (process.env.BRAIN_APP_SETUP_DRIVE === '1') {
    const text = wrapPromptWithHooks({ cwd: opts.cwd, kind: 'claude', sessionId: opts.tabId, text: opts.text })
    const proc = { stdin: { destroyed: false, write: () => true } } as unknown as Sess['proc']
    writeUser(
      {
        tabId: opts.tabId,
        cwd: opts.cwd,
        proc,
        buf: '',
        waiting: null,
        text: '',
        thought: '',
        autoThought: '',
        dead: false,
        n: 0,
        promptGen: 0,
        unacked: [],
        carry: [],
        turn: null,
        closing: false,
        active: 0,
        bg: new Map(),
        toolLabels: new Map()
      },
      text,
      opts.attachments || []
    )
    opts.onEvent({ kind: 'text', data: 'Here is what this step is for.' })
    opts.onEvent({ kind: 'done' })
    return ''
  }
  await claudeWarm(opts)
  const s = sessions.get(opts.tabId)
  if (!s || s.dead) throw new Error('Claude session is not ready')
  if (s.waiting) claudeCancel(opts.tabId)
  const gen = ++s.promptGen
  s.onEvent = opts.onEvent
  s.text = ''
  s.thought = ''
  writeUser(
    s,
    wrapPromptWithHooks({ cwd: opts.cwd, kind: 'claude', sessionId: s.tabId, text: opts.text }),
    opts.attachments || []
  )
  // Claude echoes this prompt when it takes it (--replay-user-messages); that turn answers it.
  s.unacked.push(gen)
  s.active = gen
  await new Promise<void>((resolve) => {
    s.waiting = { resolve }
  })
  if (s.promptGen === gen) {
    s.waiting = null
    s.onEvent = undefined
    if (s.active === gen) s.active = 0
  }
  opts.onEvent({ kind: 'done' })
  return s.text.trim()
}

export function claudeCancel(tabId: string): boolean {
  const s = sessions.get(tabId)
  if (!s || s.dead) return false
  try {
    s.n += 1
    s.proc.stdin?.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'stop-' + s.n,
        request: { subtype: 'interrupt' }
      }) + '\n'
    )
  } catch {
    return false
  }
  // The interrupted turn still sends a result; with no active prompt it ends nothing. A prompt Claude
  // takes before that result is for the next turn.
  if (s.turn) s.closing = true
  s.active = 0
  s.waiting?.resolve()
  s.waiting = null
  return true
}

/**
 * Plan mode on the running `claude -p` process: the stream-json `set_permission_mode` control request
 * (`plan` in, `bypassPermissions` out, the mode Brain launches with). `confirmed` is false when Claude did not
 * answer within 4s, so the state is unknown.
 */
export async function claudePlanMode(tabId: string, on: boolean): Promise<{ on: boolean; confirmed: boolean }> {
  const s = sessions.get(tabId)
  if (!s || s.dead) throw new Error('Claude session is not ready')
  s.n += 1
  const requestId = 'mode-' + s.n
  const answer = new Promise<boolean | null>((resolve) => {
    const c = (s.controls ??= newPlanControls())
    c.pending.set(requestId, resolve)
    setTimeout(() => {
      // Keep the id: a late control_response still updates planTabs (handleClaude).
      if (controlTimedOut(c, requestId, { tabId, on })) resolve(null)
    }, 4000)
  })
  s.proc.stdin?.write(
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'set_permission_mode', mode: claudeChatMode(on) }
    }) + '\n'
  )
  const ok = await answer
  if (ok === null) return { on: planTabs.has(tabId), confirmed: false }
  if (!ok) throw new Error(on ? 'Claude would not turn plan mode on.' : 'Claude would not turn plan mode off.')
  if (on) planTabs.add(tabId)
  else planTabs.delete(tabId)
  return { on, confirmed: true }
}

export function claudeClose(tabId: string): void {
  const s = sessions.get(tabId)
  sessions.delete(tabId)
  if (!s) return
  s.dead = true
  s.waiting?.resolve()
  s.waiting = null
  try {
    s.proc.kill('SIGTERM')
  } catch {
    /* */
  }
}

export async function claudeReset(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<{ model?: string; effort?: string }> {
  planTabs.delete(opts.tabId)
  claudeClose(opts.tabId)
  return claudeWarm(opts)
}

export function claudeKillAll(): void {
  for (const id of [...sessions.keys()]) claudeClose(id)
}
