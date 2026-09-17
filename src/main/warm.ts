import type { AiKind } from '../shared/contracts'
import type { StreamEvent } from './ai-cli'
import {
  acpCancel,
  acpClose,
  acpKillAll,
  acpPrompt,
  acpReset,
  acpWarm,
  prewarmProcess,
  type LiveRun
} from './acp-session'
import { claudeCancel, claudeClose, claudeKillAll, claudePrompt, claudeReset, claudeWarm } from './claude-stream'
import { codexCancel, codexClose, codexKillAll, codexPrompt, codexReset, codexWarm } from './codex-app'

export type { LiveRun }

export type WarmOpts = {
  tabId: string
  kind: AiKind
  cwd: string
  model?: string
  effort?: string
  agentMode?: string
}

export async function warmSession(opts: WarmOpts): Promise<LiveRun> {
  if (opts.kind === 'grok' || opts.kind === 'cursor') {
    return acpWarm({
      kind: opts.kind,
      tabId: opts.tabId,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      agentMode: opts.agentMode
    })
  }
  if (opts.kind === 'claude') {
    return claudeWarm({ tabId: opts.tabId, cwd: opts.cwd, model: opts.model, effort: opts.effort })
  }
  if (opts.kind === 'gpt') {
    return codexWarm({ tabId: opts.tabId, cwd: opts.cwd, model: opts.model, effort: opts.effort })
  }
  return { model: opts.model, effort: opts.effort }
}

export async function promptWarm(opts: WarmOpts & { text: string; onEvent: (ev: StreamEvent) => void }): Promise<string> {
  if (/^\s*\/compact\b/i.test(opts.text)) opts.onEvent({ kind: 'status', data: 'compacting' })
  if (opts.kind === 'grok' || opts.kind === 'cursor') return acpPrompt({ ...opts, kind: opts.kind })
  if (opts.kind === 'claude') return claudePrompt(opts)
  if (opts.kind === 'gpt') return codexPrompt(opts)
  throw new Error('unknown chat kind')
}

export function cancelWarm(tabId: string): boolean {
  return acpCancel(tabId) || claudeCancel(tabId) || codexCancel(tabId)
}

export function closeWarm(tabId: string): void {
  acpClose(tabId)
  claudeClose(tabId)
  codexClose(tabId)
}

export async function resetWarm(opts: WarmOpts): Promise<void> {
  if (opts.kind === 'grok' || opts.kind === 'cursor') {
    await acpReset({ kind: opts.kind, tabId: opts.tabId, cwd: opts.cwd, model: opts.model, effort: opts.effort })
    return
  }
  if (opts.kind === 'claude') {
    await claudeReset({ tabId: opts.tabId, cwd: opts.cwd, model: opts.model })
    return
  }
  if (opts.kind === 'gpt') await codexReset(opts)
}

export function killAllWarm(): void {
  acpKillAll()
  claudeKillAll()
  codexKillAll()
}

export function prewarm(kind: AiKind, cwd: string): void {
  if (kind === 'grok' || kind === 'cursor') prewarmProcess(kind, cwd)
}
