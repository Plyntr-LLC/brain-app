import type { AiKind } from '../shared/contracts'
import type { StreamEvent } from './ai-cli'
import { binEnv, resolveBin } from './ai-cli'
import { asRecord, asText, fileHits, LineRpc, spawnBin, type RpcMsg } from './line-rpc'

const RULES =
  'You are the brain on this computer. Answer in plain English. You may read files. Do not edit or write files. Do not dump tool names or keyboard shortcuts.'

export type Cap = { id: string; label: string }

export type LiveRun = {
  model?: string
  effort?: string
  agentMode?: string
  models?: Cap[]
  efforts?: Cap[]
  agentModes?: Cap[]
}

type Tab = {
  tabId: string
  sessionId: string
  model?: string
  effort?: string
  agentMode?: string
  models?: Cap[]
  efforts?: Cap[]
  agentModes?: Cap[]
  promptId: number | null
  onEvent?: (ev: StreamEvent) => void
  text: string
}

type Pool = {
  kind: 'grok' | 'cursor'
  cwd: string
  rpc: LineRpc
  boot: Promise<void>
  tabs: Map<string, Tab>
  bySid: Map<string, string>
}

const pools = new Map<string, Pool>()
const tabPool = new Map<string, string>()
const booting = new Map<string, Promise<Pool>>()
const tabLocks = new Map<string, Promise<unknown>>()

async function withTabLock<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tabLocks.get(tabId)
  if (prev) await prev.catch(() => {})
  let release: () => void = () => {}
  const p = new Promise<void>((r) => {
    release = r
  })
  tabLocks.set(tabId, p)
  try {
    return await fn()
  } finally {
    release()
    if (tabLocks.get(tabId) === p) tabLocks.delete(tabId)
  }
}

function optionValue(r: Record<string, unknown>): string | undefined {
  const cur = r.currentValue
  if (typeof cur === 'string' && cur) return cur
  if (cur && typeof cur === 'object' && 'value' in cur) {
    const v = (cur as { value?: unknown }).value
    if (typeof v === 'string' && v) return v
  }
  if (typeof r.value === 'string' && r.value) return r.value
  return undefined
}

function capsFromOptions(raw: unknown): Cap[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((o) => {
      const r = asRecord(o)
      const id = String(r.value || r.modelId || r.id || '')
      const label = String(r.name || r.label || id.split('[')[0] || id)
      return id ? { id, label } : null
    })
    .filter((x): x is Cap => Boolean(x))
}

function parseBracket(modelId: string): Record<string, string> {
  const m = modelId.match(/\[(.*)\]$/)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const part of m[1].split(',')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

function withCursorEffort(modelId: string, effort: string): string {
  if (/effort=/.test(modelId)) return modelId.replace(/effort=[^,\]]+/, `effort=${effort}`)
  if (/reasoning=/.test(modelId)) return modelId.replace(/reasoning=[^,\]]+/, `reasoning=${effort}`)
  return modelId
}

function resolveModelId(wanted: string | undefined, models?: Cap[]): string | undefined {
  if (!wanted) return wanted
  if (!models?.length) return wanted
  if (models.some((m) => m.id === wanted)) return wanted
  const hit = models.find(
    (m) => m.label === wanted || m.id.split('[')[0] === wanted || m.id.startsWith(wanted + '[')
  )
  return hit?.id || wanted
}

function effortsForModel(modelId?: string, listed?: Cap[]): Cap[] {
  if (listed?.length) return listed
  if (!modelId) return []
  const p = parseBracket(modelId)
  if (p.effort) {
    return [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' }
    ]
  }
  if (p.reasoning) {
    return [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' }
    ]
  }
  return []
}

function readLive(res: Record<string, unknown>): LiveRun {
  const modelsBlock = asRecord(res.models)
  let model = typeof modelsBlock.currentModelId === 'string' ? modelsBlock.currentModelId : undefined
  let effort: string | undefined
  let models: Cap[] = capsFromOptions(modelsBlock.availableModels)
  let efforts: Cap[] = []
  const opts = Array.isArray(res.configOptions) ? res.configOptions : []
  for (const o of opts) {
    const r = asRecord(o)
    const id = String(r.id || r.configId || '')
    const v = optionValue(r)
    if (id === 'model') {
      if (v) model = v
      const more = capsFromOptions(r.options)
      if (more.length) models = more
    }
    if (id === 'reasoning_effort' || id === 'effort') {
      if (v) effort = v
      const more = capsFromOptions(r.options)
      if (more.length) {
        efforts = more.map((c) => ({
          id: c.id,
          label: c.id === 'xhigh' ? 'Extra high' : c.label.replace(/^./, (ch) => ch.toUpperCase())
        }))
      }
    }
  }
  const avail = Array.isArray(modelsBlock.availableModels) ? modelsBlock.availableModels : []
  const cur = avail.find((m) => asRecord(m).modelId === model || asRecord(m).id === model)
  const meta = asRecord(asRecord(cur)._meta)
  if (!effort && typeof meta.reasoningEffort === 'string') effort = meta.reasoningEffort
  const params = model ? parseBracket(model) : {}
  if (!effort) effort = params.effort || params.reasoning
  if (!efforts.length) efforts = effortsForModel(model)
  const modesBlock = asRecord(res.modes)
  const agentModes = capsFromOptions(modesBlock.availableModes)
  const agentMode = typeof modesBlock.currentModeId === 'string' ? modesBlock.currentModeId : undefined
  return {
    model,
    effort,
    agentMode,
    models: models.length ? models : undefined,
    efforts: efforts.length ? efforts : undefined,
    agentModes: agentModes.length ? agentModes : undefined
  }
}

async function setOption(rpc: LineRpc, sessionId: string, configId: string, value: string): Promise<Record<string, unknown>> {
  const attempts: Array<() => Promise<unknown>> = [
    () => rpc.request('session/set_config_option', { sessionId, configId, value }, 10_000),
    () => rpc.request('session/set_config_option', { sessionId, configId, value: { value } }, 10_000)
  ]
  if (configId === 'model') {
    attempts.push(() => rpc.request('session/set_model', { sessionId, modelId: value }, 10_000))
  }
  let last = new Error('could not set ' + configId)
  for (const run of attempts) {
    try {
      return asRecord(await run())
    } catch (e) {
      last = e as Error
    }
  }
  throw last
}

function poolKey(kind: 'grok' | 'cursor', cwd: string): string {
  return kind + ':' + cwd
}

function spawnArgs(kind: 'grok' | 'cursor', cwd: string): string[] {
  if (kind === 'grok') {
    return [
      '--cwd',
      cwd,
      '--deny',
      'Write',
      '--deny',
      'Edit',
      '--deny',
      'search_replace',
      'agent',
      '--always-approve',
      '--no-leader',
      'stdio'
    ]
  }
  return ['--trust', '--workspace', cwd, 'acp']
}

function isWriteish(msg: RpcMsg): boolean {
  const p = asRecord(msg.params)
  const tool = asRecord(p.toolCall)
  const kind = String(tool.kind || '')
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return true
  const blob = (String(tool.title || '') + ' ' + JSON.stringify(tool.rawInput || {})).toLowerCase()
  return /\b(write|edit|delete|search_replace|str_replace)\b/.test(blob)
}

function pickOption(msg: RpcMsg, write: boolean): string | null {
  const opts = asRecord(msg.params).options
  if (!Array.isArray(opts)) return null
  const want = write ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always']
  for (const k of want) {
    for (const o of opts) {
      const r = asRecord(o)
      if (r.kind === k && typeof r.optionId === 'string') return r.optionId
    }
  }
  const first = asRecord(opts[0])
  return typeof first.optionId === 'string' ? first.optionId : null
}

function compactPhase(method: string, update: Record<string, unknown>): 'compacting' | 'compacted' | null {
  const kind = String(update.sessionUpdate || update.type || '')
  const blob = `${method} ${kind} ${String(update.status || '')}`.toLowerCase()
  if (!blob.includes('compact') || blob.includes('compact-mode') || blob.includes('compact_mode')) return null
  if (/complete|completed|done|end|boundary|finished|compacted/.test(blob)) return 'compacted'
  return 'compacting'
}

function eventsFromUpdate(update: Record<string, unknown>): StreamEvent[] {
  const kind = String(update.sessionUpdate || '')
  if (kind === 'agent_thought_chunk') {
    const t = asText(update.content)
    return t ? [{ kind: 'thought', data: t }] : []
  }
  if (kind === 'agent_message_chunk') {
    const t = asText(update.content)
    return t ? [{ kind: 'text', data: t }] : []
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return fileHits(update, String(update.title || update.kind || ''))
  }
  return []
}

function handleNote(pool: Pool, msg: RpcMsg): void {
  const method = String(msg.method || '')
  if (method !== 'session/update' && !method.includes('session_notification')) return
  const params = asRecord(msg.params)
  const sid = String(params.sessionId || '')
  const tabId = pool.bySid.get(sid)
  if (!tabId) return
  const tab = pool.tabs.get(tabId)
  if (!tab) return
  const update = asRecord(params.update)
  const kind = String(update.sessionUpdate || '')
  if (kind === 'model_changed' || kind === 'config_option_update') {
    if (typeof update.model_id === 'string') tab.model = update.model_id
    if (typeof update.reasoning_effort === 'string') tab.effort = update.reasoning_effort
    const live = readLive(update)
    if (live.model) tab.model = live.model
    if (live.effort) tab.effort = live.effort
  }
  const phase = compactPhase(method, update)
  if (phase && tab.onEvent) tab.onEvent({ kind: 'status', data: phase })
  if (!tab.onEvent) return
  for (const ev of eventsFromUpdate(update)) {
    if (ev.kind === 'text') tab.text += ev.data
    tab.onEvent(ev)
  }
}

function handleReq(pool: Pool, msg: RpcMsg): void {
  if (msg.id == null) return
  if (msg.method === 'session/request_permission') {
    const write = isWriteish(msg)
    const optionId = pickOption(msg, write)
    if (optionId) {
      pool.rpc.reply(msg.id, { outcome: { outcome: 'selected', optionId } })
      return
    }
    pool.rpc.reply(msg.id, { outcome: { outcome: 'cancelled' } })
    return
  }
  pool.rpc.reply(msg.id, {})
}

async function bootPool(kind: 'grok' | 'cursor', cwd: string): Promise<Pool> {
  const key = poolKey(kind, cwd)
  const existing = pools.get(key)
  if (existing && !existing.rpc.dead) return existing
  const pending = booting.get(key)
  if (pending) return pending
  const work = bootPoolNow(kind, cwd, key)
  booting.set(key, work)
  try {
    return await work
  } finally {
    booting.delete(key)
  }
}

async function bootPoolNow(kind: 'grok' | 'cursor', cwd: string, key: string): Promise<Pool> {
  const again = pools.get(key)
  if (again && !again.rpc.dead) return again
  const bin = resolveBin(kind)
  if (!bin) throw new Error(`${kind} is not installed on this computer`)
  const env = { ...binEnv() }
  if (kind === 'grok') {
    env.GROK_CONFIG = JSON.stringify({ models: { default_reasoning_effort: 'high' } })
  }
  const proc = spawnBin(bin, spawnArgs(kind, cwd), cwd, env)
  const pool: Pool = {
    kind,
    cwd,
    rpc: null as unknown as LineRpc,
    boot: Promise.resolve(),
    tabs: new Map(),
    bySid: new Map()
  }
  pool.rpc = new LineRpc(proc, (m) => handleNote(pool, m), (m) => handleReq(pool, m), true)
  pool.boot = (async () => {
    const init = asRecord(
      await pool.rpc.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'brain-app', title: 'Brain', version: '0.1.0' },
          clientCapabilities: {}
        },
        20_000
      )
    )
    const methods = Array.isArray(init.authMethods) ? init.authMethods : []
    const cached = methods.find((m) => asRecord(m).id === 'cached_token')
    const methodId = asRecord(cached || (kind === 'grok' ? methods[0] : undefined)).id
    if (kind === 'grok' && typeof methodId === 'string') {
      try {
        await pool.rpc.request('authenticate', { methodId, _meta: { headless: true } }, 15_000)
      } catch {
        /* already signed in */
      }
    }
  })()
  proc.on('exit', () => {
    if (pools.get(key) === pool) pools.delete(key)
    for (const tabId of pool.tabs.keys()) tabPool.delete(tabId)
  })
  pools.set(key, pool)
  await pool.boot
  return pool
}

async function applyConfig(
  pool: Pool,
  tab: Tab,
  model?: string,
  effort?: string,
  agentMode?: string
): Promise<LiveRun> {
  let live: LiveRun = {
    model: tab.model,
    effort: tab.effort,
    agentMode: tab.agentMode,
    models: tab.models,
    efforts: tab.efforts,
    agentModes: tab.agentModes
  }
  let modelId = resolveModelId(model, tab.models) || tab.model
  if (pool.kind === 'cursor' && modelId && effort) modelId = withCursorEffort(modelId, effort)
  if (modelId && modelId !== tab.model) {
    try {
      const res = await setOption(pool.rpc, tab.sessionId, 'model', modelId)
      live = { ...live, ...readLive(res), model: readLive(res).model || modelId }
    } catch {
      live.model = modelId
    }
  }
  if (pool.kind !== 'cursor' && effort && effort !== tab.effort) {
    try {
      const res = await setOption(pool.rpc, tab.sessionId, 'reasoning_effort', effort)
      const next = readLive(res)
      live = { ...live, ...next, effort: next.effort || effort }
    } catch {
      live.effort = effort
    }
  } else if (effort) {
    live.effort = effort
    live.efforts = effortsForModel(live.model, tab.efforts)
  }
  if (agentMode && agentMode !== tab.agentMode) {
    try {
      await pool.rpc.request('session/set_mode', { sessionId: tab.sessionId, modeId: agentMode }, 10_000)
      live.agentMode = agentMode
    } catch {
      /* mode may not exist */
    }
  }
  if (live.model) live.efforts = effortsForModel(live.model, live.efforts)
  return live
}

function snapshot(tab: Tab): LiveRun {
  return {
    model: tab.model,
    effort: tab.effort,
    agentMode: tab.agentMode,
    models: tab.models,
    efforts: tab.efforts,
    agentModes: tab.agentModes
  }
}

function assignLive(tab: Tab, live: LiveRun): void {
  if (live.model) tab.model = live.model
  if (live.effort) tab.effort = live.effort
  if (live.agentMode) tab.agentMode = live.agentMode
  if (live.models) tab.models = live.models
  if (live.efforts) tab.efforts = live.efforts
  if (live.agentModes) tab.agentModes = live.agentModes
}

export async function acpWarm(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  model?: string
  effort?: string
  agentMode?: string
}): Promise<LiveRun> {
  return withTabLock(opts.tabId, async () => {
    const pool = await bootPool(opts.kind, opts.cwd)
    tabPool.set(opts.tabId, poolKey(opts.kind, opts.cwd))
    const have = pool.tabs.get(opts.tabId)
    if (have) {
      const live = await applyConfig(pool, have, opts.model, opts.effort, opts.agentMode)
      assignLive(have, live)
      return snapshot(have)
    }
    const params =
      opts.kind === 'grok'
        ? { cwd: opts.cwd, mcpServers: [], _meta: { yoloMode: true, rules: RULES } }
        : { cwd: opts.cwd, mcpServers: [] }
    const res = asRecord(await pool.rpc.request('session/new', params, 90_000))
    const sessionId = String(res.sessionId || '')
    if (!sessionId) throw new Error(`${opts.kind} did not return a session`)
    const live = readLive(res)
    pool.tabs.set(opts.tabId, {
      tabId: opts.tabId,
      sessionId,
      model: live.model,
      effort: live.effort,
      agentMode: live.agentMode,
      models: live.models,
      efforts: live.efforts,
      agentModes: live.agentModes,
      promptId: null,
      text: ''
    })
    pool.bySid.set(sessionId, opts.tabId)
    const tab = pool.tabs.get(opts.tabId)!
    if (opts.kind === 'cursor' && !opts.agentMode && tab.agentModes?.some((m) => m.id === 'ask')) {
      opts = { ...opts, agentMode: 'ask' }
    }
    if (opts.model || opts.effort || opts.agentMode) {
      const applied = await applyConfig(pool, tab, opts.model, opts.effort, opts.agentMode)
      assignLive(tab, applied)
    }
    return snapshot(tab)
  })
}

export async function acpPrompt(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  text: string
  model?: string
  effort?: string
  onEvent: (ev: StreamEvent) => void
}): Promise<string> {
  await acpWarm(opts)
  const pool = pools.get(poolKey(opts.kind, opts.cwd))
  const tab = pool?.tabs.get(opts.tabId)
  if (!pool || !tab) throw new Error('chat session is not ready')
  if (tab.promptId != null) acpCancel(opts.tabId)
  tab.onEvent = opts.onEvent
  tab.text = ''
  if (/^\s*\/compact\b/i.test(opts.text)) opts.onEvent({ kind: 'status', data: 'compacting' })
  try {
    const result = asRecord(
      await pool.rpc.request(
        'session/prompt',
        { sessionId: tab.sessionId, prompt: [{ type: 'text', text: opts.text }] },
        180_000
      )
    )
    const stop = String(result.stopReason || 'end_turn')
    if (stop !== 'cancelled' && stop !== 'end_turn' && !tab.text) {
      opts.onEvent({ kind: 'error', data: stop })
    }
  } catch (e) {
    const msg = String((e as Error).message || e)
    if (!/timed out|cancelled|stopped/i.test(msg)) opts.onEvent({ kind: 'error', data: msg })
  } finally {
    tab.onEvent = undefined
    tab.promptId = null
    opts.onEvent({ kind: 'done' })
  }
  return tab.text.trim()
}

export function acpCancel(tabId: string): boolean {
  const key = tabPool.get(tabId)
  const pool = key ? pools.get(key) : undefined
  const tab = pool?.tabs.get(tabId)
  if (!pool || !tab) return false
  try {
    pool.rpc.notify('session/cancel', { sessionId: tab.sessionId })
  } catch {
    return false
  }
  return true
}

export function acpClose(tabId: string): void {
  const key = tabPool.get(tabId)
  tabPool.delete(tabId)
  const pool = key ? pools.get(key) : undefined
  const tab = pool?.tabs.get(tabId)
  if (!pool || !tab) return
  pool.tabs.delete(tabId)
  pool.bySid.delete(tab.sessionId)
  try {
    void pool.rpc.request('session/close', { sessionId: tab.sessionId }, 5_000).catch(() => {})
  } catch {
    /* */
  }
  if (pool.tabs.size === 0) {
    pool.rpc.kill()
    pools.delete(key!)
  }
}

export async function acpReset(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  model?: string
  effort?: string
}): Promise<void> {
  acpClose(opts.tabId)
  await acpWarm(opts)
}

export function acpKillAll(): void {
  for (const pool of pools.values()) pool.rpc.kill()
  pools.clear()
  tabPool.clear()
}

export function isAcpKind(kind: AiKind): kind is 'grok' | 'cursor' {
  return kind === 'grok' || kind === 'cursor'
}

export function prewarmProcess(kind: 'grok' | 'cursor', cwd: string): void {
  void bootPool(kind, cwd).catch(() => {})
}
