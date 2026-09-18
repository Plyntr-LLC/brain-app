import type { StreamEvent } from './ai-cli'
import { binEnv, resolveBin } from './ai-cli'
import { claudeContent, type Attach } from './attach'
import { asRecord, asText, fileHits, spawnBin } from './line-rpc'

const RULES =
  'You are the brain on this computer. Answer in plain English. You may read and edit files in this folder. Do not dump tool names or keyboard shortcuts. Never change Google Ads unless the human clearly said yes. Never send external mail unless they said send.'

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
  dead: boolean
  n: number
}

const sessions = new Map<string, Sess>()
const booting = new Map<string, Promise<void>>()

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
  if (type === 'stream_event') {
    const ev = asRecord(o.event)
    const delta = asRecord(ev.delta)
    const dType = String(delta.type || '')
    const bit = asText(delta)
    if (!bit || !s.onEvent) return
    if (dType === 'thinking_delta' || dType === 'thought_delta') s.onEvent({ kind: 'thought', data: bit })
    else if (dType === 'text_delta') {
      s.text += bit
      s.onEvent({ kind: 'text', data: bit })
    }
    return
  }
  if (type === 'assistant') {
    const msg = asRecord(o.message)
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      const b = asRecord(block)
      const bt = String(b.type || '')
      if (bt === 'tool_use' && s.onEvent) {
        const name = String(b.name || 'Working')
        s.onEvent({ kind: 'status', data: 'work:' + name.slice(0, 80) })
        for (const ev of fileHits(b.input, name)) s.onEvent(ev)
      }
      if (!s.onEvent) continue
      if (bt === 'thinking' && asText(b)) s.onEvent({ kind: 'thought', data: asText(b) })
      if (bt === 'text' && asText(b) && !s.text) {
        s.text += asText(b)
        s.onEvent({ kind: 'text', data: asText(b) })
      }
    }
    return
  }
  if (type === 'result') {
    const result = typeof o.result === 'string' ? o.result : ''
    if (result && !s.text && s.onEvent) {
      s.text = result
      s.onEvent({ kind: 'text', data: result })
    }
    s.waiting?.resolve()
    s.waiting = null
  }
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
    if (sessions.get(s.tabId) === s) sessions.delete(s.tabId)
  })
}

function writeUser(s: Sess, text: string, files: Attach[] = []): void {
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
  const pending = booting.get(opts.tabId)
  if (pending) {
    await pending
    const have = sessions.get(opts.tabId)
    if (have && !have.dead && have.cwd === opts.cwd && have.model === opts.model && have.effort === opts.effort) {
      return claudeLive(have)
    }
  }
  const work = claudeWarmNow(opts)
  booting.set(opts.tabId, work)
  try {
    await work
  } finally {
    booting.delete(opts.tabId)
  }
  const s = sessions.get(opts.tabId)
  return s ? claudeLive(s) : { model: opts.model, effort: opts.effort }
}

async function claudeWarmNow(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<void> {
  const have = sessions.get(opts.tabId)
  if (have && !have.dead && have.cwd === opts.cwd && have.model === opts.model && have.effort === opts.effort) return
  if (have) claudeClose(opts.tabId)
  const bin = resolveBin('claude')
  if (!bin) throw new Error('Claude is not installed on this computer')
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--append-system-prompt',
    RULES,
    '--max-turns',
    '50'
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  const proc = spawnBin(bin, args, opts.cwd, binEnv())
  const s: Sess = {
    tabId: opts.tabId,
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    proc,
    buf: '',
    waiting: null,
    text: '',
    dead: false,
    n: 0
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
  await claudeWarm(opts)
  const s = sessions.get(opts.tabId)
  if (!s || s.dead) throw new Error('Claude session is not ready')
  if (s.waiting) claudeCancel(opts.tabId)
  s.onEvent = opts.onEvent
  s.text = ''
  writeUser(s, opts.text, opts.attachments || [])
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      claudeCancel(opts.tabId)
      resolve()
    }, 180_000)
    s.waiting = {
      resolve: () => {
        clearTimeout(t)
        resolve()
      }
    }
  })
  s.onEvent = undefined
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
  s.waiting?.resolve()
  s.waiting = null
  return true
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

export async function claudeReset(opts: { tabId: string; cwd: string; model?: string }): Promise<void> {
  claudeClose(opts.tabId)
  await claudeWarm(opts)
}

export function claudeKillAll(): void {
  for (const id of [...sessions.keys()]) claudeClose(id)
}
