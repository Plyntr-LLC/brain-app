import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AiKind } from '../shared/contracts'
import { binEnv } from './ai-cli'
import { asRecord, asText } from './line-rpc'

function hookPlatform(kind: AiKind): string {
  if (kind === 'gpt') return 'codex'
  return kind
}

function extraFromStdout(out: string): string {
  const lines = String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const last = lines[lines.length - 1]
  try {
    const j = JSON.parse(last) as Record<string, unknown>
    const nested = asRecord(j.hookSpecificOutput)
    return String(j.additional_context || j.additionalContext || nested.additionalContext || nested.additional_context || '')
  } catch {
    if (last.startsWith('{')) return ''
    return lines.join('\n')
  }
}

function runHook(cwd: string, script: string, args: string[], stdin: string, timeout: number): string {
  const file = join(cwd, script)
  if (!existsSync(file)) return ''
  const r = spawnSync('node', [file, ...args], {
    cwd,
    env: binEnv(cwd),
    input: stdin,
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024
  })
  if (r.status !== 0) return ''
  return extraFromStdout(r.stdout || '')
}

function payload(opts: {
  cwd: string
  sessionId: string
  prompt?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolId?: string
}): string {
  return JSON.stringify({
    host: 'brain-app',
    cwd: opts.cwd,
    workspaceRoot: opts.cwd,
    conversation_id: opts.sessionId,
    session_id: opts.sessionId,
    prompt: opts.prompt || '',
    user_message: opts.prompt || '',
    tool_name: opts.toolName || '',
    tool_input: opts.toolInput || '',
    tool_output: opts.toolOutput || '',
    tool_use_id: opts.toolId || ''
  })
}

export function wrapPromptWithHooks(opts: {
  cwd: string
  kind: AiKind
  sessionId: string
  text: string
}): string {
  const text = String(opts.text || '')
  if (!text.trim() || /^\s*\//.test(text)) return text
  const plat = hookPlatform(opts.kind)
  const stdin = payload({ cwd: opts.cwd, sessionId: opts.sessionId, prompt: text })
  const extras = [
    runHook(opts.cwd, 'code/typesafe/context-router/hook.cjs', [`--platform=${plat}`, '--event=prompt'], stdin, 12_000),
    runHook(opts.cwd, 'code/typesafe/compaction/hook.cjs', [`--platform=${plat}`, '--event=prompt'], stdin, 12_000)
  ].filter(Boolean)
  if (!extras.length) return text
  return `${extras.join('\n\n')}\n\n${text}`
}

export function captureToolHook(opts: {
  cwd: string
  kind: AiKind
  sessionId: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolId?: string
}): void {
  const out = String(opts.toolOutput || '')
  if (out.length < 200) return
  const plat = hookPlatform(opts.kind)
  const stdin = payload(opts)
  runHook(opts.cwd, 'code/typesafe/compaction/hook.cjs', [`--platform=${plat}`, '--event=capture'], stdin, 5_000)
}

export function toolCaptureFromUpdate(update: Record<string, unknown>): {
  toolName: string
  toolInput: string
  toolOutput: string
  toolId: string
} | null {
  const status = String(update.status || '').toLowerCase()
  if (status && status !== 'completed' && status !== 'success' && status !== 'ok') return null
  const toolId = String(update.toolCallId || update.tool_call_id || update.id || '')
  const toolName = String(update.title || update.kind || update.tool || 'tool').slice(0, 80)
  const toolInput = typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput || update.raw_input || {})
  const chunks: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) chunks.push(value)
    else if (Array.isArray(value)) value.forEach(push)
    else {
      const row = asRecord(value)
      const bit = asText(row) || asText(row.content) || asText(row.text)
      if (bit) chunks.push(bit)
    }
  }
  push(update.rawOutput)
  push(update.content)
  const toolOutput = chunks.join('\n')
  if (toolOutput.length < 200) return null
  return { toolName, toolInput, toolOutput, toolId }
}

export { extraFromStdout }
