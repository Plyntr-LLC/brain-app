import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AiKind } from '../shared/contracts'
import type { SessionCmd, StreamEvent } from './ai-cli'
import { binEnv, resolveBin } from './ai-cli'
import { loginCli } from './install'
import { acpPromptParts, type Attach } from './attach'
import { underRoot } from './files'
import { grokAcpArgs, ensureGrokLeader, killGrokLeader } from './grok-leader'
import { asRecord, asText, fileHits, LineRpc, spawnBin, type RpcMsg } from './line-rpc'
import { captureEvent, skinHint } from './skin/capture'
import { GROK_DEFAULT_EFFORT } from '../shared/effort'

const RULES =
  'You are the brain on this computer. Answer in plain English. You may read and edit files in this folder. Do not dump tool names or keyboard shortcuts. Never change Google Ads unless the human clearly said yes. Never send external mail unless they said send.'

export type Cap = { id: string; label: string }

export type LiveRun = {
  model?: string
  effort?: string
  agentMode?: string
  sessionId?: string
  contextTotal?: number
  models?: Cap[]
  efforts?: Cap[]
  agentModes?: Cap[]
  commands?: SessionCmd[]
  configIds?: string[]
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
  commands?: SessionCmd[]
  configIds?: string[]
  contextTotal?: number
  promptId: number | null
  onEvent?: (ev: StreamEvent) => void
  text: string
  alwaysApprove?: boolean
  permId?: number | string
  permOptions?: { id: string; label: string }[]
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

/** Only an id the live session actually advertised. Bare labels like composer-2.5 are invalid. */
function advertisedModel(wanted: string | undefined, models?: Cap[]): string | undefined {
  if (!wanted) return undefined
  if (!models?.length) return undefined
  const resolved = resolveModelId(wanted, models)
  return models.some((m) => m.id === resolved) ? resolved : undefined
}

function effortsForModel(modelId?: string, listed?: Cap[], hasEffortOption?: boolean): Cap[] {
  const p = modelId ? parseBracket(modelId) : {}
  if (p.effort) {
    return listed?.length
      ? listed
      : [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra high' }
        ]
  }
  if (p.reasoning) {
    return listed?.length
      ? listed
      : [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' }
        ]
  }
  if (hasEffortOption && listed?.length) return listed
  return []
}

function readLive(res: Record<string, unknown>): LiveRun {
  const modelsBlock = asRecord(res.models)
  let model = typeof modelsBlock.currentModelId === 'string' ? modelsBlock.currentModelId : undefined
  let effort: string | undefined
  let models: Cap[] = capsFromOptions(modelsBlock.availableModels)
  let efforts: Cap[] = []
  const configIds: string[] = []
  const opts = Array.isArray(res.configOptions) ? res.configOptions : []
  for (const o of opts) {
    const r = asRecord(o)
    const id = String(r.id || r.configId || '')
    if (id) configIds.push(id)
    const v = optionValue(r)
    if (id === 'model') {
      if (v) model = v
      const more = capsFromOptions(r.options)
      if (more.length) models = more
    }
    if (id === 'reasoning_effort' || id === 'effort') {
      if (v) {
        const k = v.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
        effort = k === 'extra-high' || k === 'x-high' ? 'xhigh' : v
      }
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
  const hasEffortOption = configIds.includes('effort') || configIds.includes('reasoning_effort')
  if (!efforts.length) efforts = effortsForModel(model, undefined, hasEffortOption)
  else efforts = effortsForModel(model, efforts, hasEffortOption)
  const modesBlock = asRecord(res.modes)
  const agentModes = capsFromOptions(modesBlock.availableModes)
  const agentMode = typeof modesBlock.currentModeId === 'string' ? modesBlock.currentModeId : undefined
  const contextTotal =
    Number(meta.contextWindow || meta.context_window || meta.totalContextTokens || modelsBlock.contextWindow || 0) ||
    undefined
  return {
    model,
    effort,
    agentMode,
    contextTotal,
    models: models.length ? models : undefined,
    efforts,
    agentModes: agentModes.length ? agentModes : undefined,
    configIds: configIds.length ? configIds : undefined
  }
}

async function setOption(rpc: LineRpc, sessionId: string, configId: string, value: string): Promise<Record<string, unknown>> {
  const attempts: Array<() => Promise<unknown>> = [
    () => rpc.request('session/set_config_option', { sessionId, configId, value }, 10_000)
  ]
  if (configId === 'model') {
    attempts.push(() => rpc.request('session/set_model', { sessionId, modelId: value }, 10_000))
  }
  if (configId === 'reasoning_effort') {
    attempts.push(() =>
      rpc.request('session/set_config_option', { sessionId, configId: 'effort', value }, 10_000)
    )
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

async function spawnArgs(kind: 'grok' | 'cursor', cwd: string): Promise<string[]> {
  if (kind === 'grok') {
    const useLeader = await ensureGrokLeader()
    return grokAcpArgs(cwd, useLeader)
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
    const title = String(update.title || '').trim()
    const hits = fileHits(update, title || String(update.kind || ''))
    if (kind === 'tool_call' && title) {
      return [{ kind: 'status', data: 'work:' + title.slice(0, 80) }, ...hits]
    }
    return hits
  }
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries) ? update.entries : Array.isArray(update.plan) ? update.plan : []
    const steps = entries
      .map((row) => {
        const r = asRecord(row)
        const title = String(r.title || r.content || r.text || '')
        return title ? { title, status: String(r.status || '') } : null
      })
      .filter((s): s is { title: string; status: string } => Boolean(s))
    return steps.length ? [{ kind: 'plan', steps }] : []
  }
  return []
}

function parseCommands(raw: unknown): SessionCmd[] {
  if (!Array.isArray(raw)) return []
  const out: SessionCmd[] = []
  for (const row of raw) {
    const r = asRecord(row)
    const name = String(r.name || '').replace(/^\//, '')
    if (!name) continue
    const input = asRecord(r.input)
    const hint = String(input.hint || r.inputHint || '')
    out.push({ name, description: String(r.description || ''), hint: hint || undefined })
  }
  return out
}

function broadcast(tab: Tab, ev: StreamEvent): void {
  const key = tabPool.get(tab.tabId)
  const pool = key ? pools.get(key) : undefined
  const hint = pool ? skinHint({ cli: pool.kind, ev }) : { fingerprint: '', label: null as string | null }
  const payload = { tabId: tab.tabId, ...ev, fingerprint: hint.fingerprint, skinLabel: hint.label }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('chat:event', payload)
  }
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
  if (kind === 'available_commands_update') {
    const commands = parseCommands(update.availableCommands || update.available_commands)
    tab.commands = commands
    broadcast(tab, { kind: 'commands', commands })
    return
  }
  if (kind === 'model_changed' || kind === 'config_option_update') {
    if (typeof update.model_id === 'string') tab.model = update.model_id
    if (typeof update.reasoning_effort === 'string') tab.effort = update.reasoning_effort
    const live = readLive(update)
    if (live.model) tab.model = live.model
    if (live.effort) tab.effort = live.effort
  }
  const phase = compactPhase(method, update)
  if (phase && tab.onEvent) tab.onEvent({ kind: 'status', data: phase })
  const metaU = asRecord(params._meta || update._meta)
  const usage = asRecord(update.usage || params.usage)
  const used = Number(
    usage.input_tokens ||
      usage.inputTokens ||
      usage.context_tokens ||
      usage.total_tokens ||
      metaU.totalTokens ||
      update.tokens_used ||
      params.tokens_used ||
      0
  )
  const total =
    tab.contextTotal ||
    Number(update.context_window || metaU.contextWindow || metaU.totalContextTokens || 0) ||
    0
  const pctRaw = update.percentage ?? update.used_percentage ?? metaU.percentage
  const percent =
    typeof pctRaw === 'number'
      ? Math.min(100, Math.round(pctRaw))
      : used && total
        ? Math.min(100, Math.round((used / total) * 100))
        : undefined
  if ((used || percent != null) && tab.onEvent) {
    if (total) tab.contextTotal = total
    tab.onEvent({ kind: 'context', used: used || undefined, total: total || undefined, percent })
  }
  if (!tab.onEvent) return
  const mapped = eventsFromUpdate(update)
  if (!mapped.length && kind && kind !== 'model_changed' && kind !== 'config_option_update') {
    const ev = { kind, data: String(update.title || update.status || '') } as StreamEvent
    captureEvent({
      cli: pool.kind,
      sessionId: tab.sessionId,
      ev
    })
    tab.onEvent(ev)
  }
  for (const ev of mapped) {
    if (ev.kind === 'text') tab.text += ev.data
    captureEvent({ cli: pool.kind, sessionId: tab.sessionId, ev })
    tab.onEvent(ev)
  }
}

function handleReq(pool: Pool, msg: RpcMsg): void {
  if (msg.id == null) return
  if (msg.method === 'session/request_permission') {
    const p = asRecord(msg.params)
    const sid = String(p.sessionId || '')
    const tabId = pool.bySid.get(sid)
    const tab = tabId ? pool.tabs.get(tabId) : undefined
    const auto = !tab || tab.alwaysApprove !== false
    if (auto) {
      const optionId = pickOption(msg, false)
      if (optionId) {
        pool.rpc.reply(msg.id, { outcome: { outcome: 'selected', optionId } })
        return
      }
      pool.rpc.reply(msg.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const rawOpts = Array.isArray(p.options) ? p.options : []
    const options = rawOpts
      .map((o) => {
        const r = asRecord(o)
        const id = String(r.optionId || r.kind || '')
        const label = String(r.name || r.label || r.kind || id)
        return id ? { id, label } : null
      })
      .filter((o): o is { id: string; label: string } => Boolean(o))
    tab.permId = msg.id
    tab.permOptions = options
    const tool = asRecord(p.toolCall)
    const title = String(p.title || tool.title || 'Allow this?')
    const path = String(
      asRecord(tool.rawInput).target_file || asRecord(tool.rawInput).path || tool.path || ''
    )
    const ev: StreamEvent = { kind: 'permission', title, path, options, requestId: String(msg.id) }
    captureEvent({ cli: pool.kind, sessionId: tab.sessionId, ev, transport: 'acp' })
    if (tab.onEvent) tab.onEvent(ev)
    else broadcast(tab, ev)
    return
  }
  if (msg.method === 'fs/read_text_file') {
    const p = asRecord(msg.params)
    const abs = String(p.path || '')
    if (!abs || !underRoot(pool.cwd, abs) || !existsSync(abs)) {
      pool.rpc.error(msg.id, -32603, 'That file is not in this folder.')
      return
    }
    try {
      let text = readFileSync(abs, 'utf8')
      const line = Number(p.line || 0)
      const limit = Number(p.limit || 0)
      if (line > 0 || limit > 0) {
        const lines = text.split('\n')
        const start = Math.max(0, (line || 1) - 1)
        text = lines.slice(start, limit ? start + limit : undefined).join('\n')
      }
      pool.rpc.reply(msg.id, { content: text })
    } catch (e) {
      pool.rpc.error(msg.id, -32603, String((e as Error).message || e))
    }
    return
  }
  if (msg.method === 'fs/write_text_file') {
    const p = asRecord(msg.params)
    const abs = String(p.path || '')
    if (!abs || !underRoot(pool.cwd, abs)) {
      pool.rpc.error(msg.id, -32603, 'That file is not in this folder.')
      return
    }
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, String(p.content ?? ''), 'utf8')
      pool.rpc.reply(msg.id, {})
    } catch (e) {
      pool.rpc.error(msg.id, -32603, String((e as Error).message || e))
    }
    return
  }
  if (msg.method === 'elicitation/create') {
    pool.rpc.reply(msg.id, { action: 'cancel' })
    return
  }
  pool.rpc.error(msg.id, -32601, 'Method not found')
}

async function acpAuthenticate(rpc: LineRpc, methods: unknown[], kind: 'grok' | 'cursor'): Promise<void> {
  const ids = methods
    .map((m) => String(asRecord(m).id || ''))
    .filter(Boolean)
  const order: string[] = []
  if (ids.includes('cached_token')) order.push('cached_token')
  for (const id of ids) if (!order.includes(id)) order.push(id)
  let last = ''
  for (const methodId of order) {
    try {
      await rpc.request('authenticate', { methodId }, 0)
      return
    } catch (e) {
      last = String((e as Error).message || e)
    }
  }
  if (kind === 'grok') {
    await loginCli('grok').catch(() => {})
    try {
      await rpc.request('authenticate', { methodId: 'cached_token' }, 0)
      return
    } catch (e) {
      last = String((e as Error).message || e)
    }
    throw new Error(
      'Grok Chat needs you to sign in. Terminal can be signed in while Chat is not. Finish grok login in the window that opened, then send again.'
    )
  }
  if (kind === 'cursor') {
    if (last && /sign in|not logged|login required|auth_required/i.test(last)) {
      await loginCli('cursor').catch(() => {})
      throw new Error(
        'Cursor Chat needs you to sign in. Finish cursor-agent login in the window that opened, then send again.'
      )
    }
    return
  }
  if (last && /auth/i.test(last)) throw new Error(last)
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
  const proc = spawnBin(bin, await spawnArgs(kind, cwd), cwd, binEnv(cwd))
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
          clientInfo: { name: 'Brain', version: app.getVersion() },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            ...(kind === 'cursor' ? { _meta: { parameterizedModelPicker: true } } : {})
          }
        },
        20_000
      )
    )
    const methods = Array.isArray(init.authMethods) ? init.authMethods : []
    await acpAuthenticate(pool.rpc, methods, kind)
  })()
  proc.on('exit', () => {
    if (pools.get(key) === pool) pools.delete(key)
    for (const tabId of pool.tabs.keys()) tabPool.delete(tabId)
  })
  pools.set(key, pool)
  try {
    await pool.boot
  } catch (e) {
    pools.delete(key)
    try {
      pool.rpc.proc.kill()
    } catch {
      /* gone */
    }
    throw e
  }
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
    agentModes: tab.agentModes,
    configIds: tab.configIds
  }
  const configIds = new Set(tab.configIds || [])
  let modelId = advertisedModel(model, tab.models) || (!model ? tab.model : undefined)
  if (pool.kind === 'cursor' && modelId && effort && (/effort=/.test(modelId) || /reasoning=/.test(modelId))) {
    modelId = withCursorEffort(modelId, effort)
    if (tab.models?.length && !tab.models.some((m) => m.id === modelId)) modelId = advertisedModel(model, tab.models)
  }
  if (modelId && modelId !== tab.model) {
    try {
      const res = await setOption(pool.rpc, tab.sessionId, 'model', modelId)
      const next = readLive(res)
      live = { ...live, ...next, model: next.model || modelId }
      if (next.configIds) next.configIds.forEach((id) => configIds.add(id))
    } catch {
      live.model = tab.model
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
  } else if (pool.kind === 'cursor' && effort && effort !== tab.effort && configIds.has('effort')) {
    try {
      const res = await setOption(pool.rpc, tab.sessionId, 'effort', effort)
      const next = readLive(res)
      live = { ...live, ...next, effort: next.effort || effort }
    } catch {
      live.effort = tab.effort
    }
  } else if (effort && (live.efforts?.length || configIds.has('effort') || configIds.has('reasoning_effort'))) {
    live.effort = effort
  }
  if (agentMode && agentMode !== tab.agentMode) {
    const allowed = tab.agentModes?.some((m) => m.id === agentMode)
    if (allowed || !tab.agentModes?.length) {
      try {
        await pool.rpc.request('session/set_mode', { sessionId: tab.sessionId, modeId: agentMode }, 10_000)
        live.agentMode = agentMode
      } catch {
        /* mode may not exist */
      }
    }
  }
  live.efforts = effortsForModel(
    live.model,
    live.efforts,
    configIds.has('effort') || configIds.has('reasoning_effort')
  )
  if (!live.efforts.length && pool.kind === 'grok') {
    live.efforts = [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' }
    ]
  }
  if (effort) live.effort = live.effort || effort
  return live
}

function snapshot(tab: Tab): LiveRun {
  return {
    model: tab.model,
    effort: tab.effort,
    agentMode: tab.agentMode,
    sessionId: tab.sessionId,
    contextTotal: tab.contextTotal,
    models: tab.models,
    efforts: tab.efforts || [],
    agentModes: tab.agentModes,
    commands: tab.commands,
    configIds: tab.configIds
  }
}

function assignLive(tab: Tab, live: LiveRun): void {
  if (live.model) tab.model = live.model
  if ('effort' in live) tab.effort = live.effort
  if (live.agentMode) tab.agentMode = live.agentMode
  if (live.sessionId) tab.sessionId = live.sessionId
  if (live.contextTotal) tab.contextTotal = live.contextTotal
  if (live.models) tab.models = live.models
  if (live.efforts) tab.efforts = live.efforts
  if (live.agentModes) tab.agentModes = live.agentModes
  if (live.commands) tab.commands = live.commands
  if (live.configIds) tab.configIds = live.configIds
}

export async function acpWarm(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  model?: string
  effort?: string
  agentMode?: string
  resumeId?: string
}): Promise<LiveRun> {
  return withTabLock(opts.tabId, async () => {
    if (opts.kind === 'grok' && !opts.effort) opts = { ...opts, effort: GROK_DEFAULT_EFFORT }
    const pool = await bootPool(opts.kind, opts.cwd)
    tabPool.set(opts.tabId, poolKey(opts.kind, opts.cwd))
    const have = pool.tabs.get(opts.tabId)
    if (have) {
      if (opts.resumeId && opts.resumeId !== have.sessionId) {
        try {
          const loadedRes = asRecord(
            await pool.rpc.request(
              'session/load',
              { sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [] },
              0
            )
          )
          const sid = String(loadedRes.sessionId || opts.resumeId || '')
          if (sid) {
            pool.bySid.delete(have.sessionId)
            have.sessionId = sid
            pool.bySid.set(sid, opts.tabId)
            assignLive(have, readLive(loadedRes))
          }
        } catch {
          /* keep the current session */
        }
      }
      const live = await applyConfig(pool, have, opts.model, opts.effort, opts.agentMode)
      assignLive(have, live)
      return snapshot(have)
    }
    let res: Record<string, unknown> | null = null
    let loaded = false
    if (opts.resumeId) {
      try {
        const loadedRes = asRecord(
          await pool.rpc.request(
            'session/load',
            { sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [] },
            0
          )
        )
        if (!loadedRes || typeof loadedRes !== 'object') throw new Error('empty load')
        const sid = String(loadedRes.sessionId || opts.resumeId || '')
        if (!sid) throw new Error('load missing session')
        loaded = true
        res = { ...loadedRes, sessionId: sid }
      } catch {
        loaded = false
        res = null
      }
    }
    if (!loaded) {
      const params =
        opts.kind === 'grok'
          ? { cwd: opts.cwd, mcpServers: [], _meta: { yoloMode: true, rules: RULES } }
          : { cwd: opts.cwd, mcpServers: [] }
      try {
        res = asRecord(await pool.rpc.request('session/new', params, 0))
      } catch (e) {
        const msg = String((e as Error).message || e)
        if (!/auth/i.test(msg)) throw e
        if (opts.kind === 'grok') {
          await loginCli('grok').catch(() => {})
          throw new Error(
            'Grok Chat needs you to sign in. Finish grok login in the window that opened, then send again.'
          )
        }
        throw new Error(msg)
      }
    }
    if (!res) throw new Error(`${opts.kind} did not return a session`)
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
      contextTotal: live.contextTotal,
      commands: live.commands,
      promptId: null,
      text: ''
    })
    pool.bySid.set(sessionId, opts.tabId)
    const tab = pool.tabs.get(opts.tabId)!
    if (opts.kind === 'cursor' && !opts.agentMode && tab.agentModes?.some((m) => m.id === 'agent')) {
      opts = { ...opts, agentMode: 'agent' }
    }
    if (opts.kind === 'grok' && !opts.effort) opts = { ...opts, effort: GROK_DEFAULT_EFFORT }
    if (opts.model || opts.effort || opts.agentMode) {
      const applied = await applyConfig(pool, tab, opts.model, opts.effort, opts.agentMode)
      assignLive(tab, applied)
    }
    return snapshot(tab)
  })
}

export async function acpResume(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  sessionId: string
}): Promise<LiveRun> {
  return withTabLock(opts.tabId, async () => {
    const pool = await bootPool(opts.kind, opts.cwd)
    const loadedRes = asRecord(
      await pool.rpc.request(
        'session/load',
        { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] },
        0
      )
    )
    const sid = String(loadedRes.sessionId || opts.sessionId || '')
    if (!sid) throw new Error('Could not load that session.')
    tabPool.set(opts.tabId, poolKey(opts.kind, opts.cwd))
    const have = pool.tabs.get(opts.tabId)
    if (have) pool.bySid.delete(have.sessionId)
    const live = readLive(loadedRes)
    const tab: Tab = have || {
      tabId: opts.tabId,
      sessionId: sid,
      promptId: null,
      text: ''
    }
    tab.sessionId = sid
    assignLive(tab, live)
    pool.tabs.set(opts.tabId, tab)
    pool.bySid.set(sid, opts.tabId)
    return snapshot(tab)
  })
}

export async function acpFork(opts: { kind: 'grok' | 'cursor'; tabId: string; cwd: string }): Promise<string> {
  const pool = pools.get(poolKey(opts.kind, opts.cwd))
  const tab = pool?.tabs.get(opts.tabId)
  if (!pool || !tab) throw new Error('chat session is not ready')
  const res = asRecord(
    await pool.rpc.request('x.ai/session/fork', { sessionId: tab.sessionId }, 30_000)
  )
  const sid = String(res.sessionId || asRecord(res.session).sessionId || asRecord(res.session).id || '')
  if (!sid) throw new Error('Fork did not return a session.')
  return sid
}

export async function acpPrompt(opts: {
  kind: 'grok' | 'cursor'
  tabId: string
  cwd: string
  text: string
  model?: string
  effort?: string
  agentMode?: string
  alwaysApprove?: boolean
  attachments?: Attach[]
  onEvent: (ev: StreamEvent) => void
}): Promise<string> {
  return acpPromptOnce(opts, false)
}

async function acpPromptOnce(
  opts: {
    kind: 'grok' | 'cursor'
    tabId: string
    cwd: string
    text: string
    model?: string
    effort?: string
    agentMode?: string
    alwaysApprove?: boolean
    attachments?: Attach[]
    onEvent: (ev: StreamEvent) => void
  },
  retried: boolean
): Promise<string> {
  try {
    await acpWarm(opts)
  } catch (e) {
    const msg = String((e as Error).message || e)
    if (!retried && /invalid params|invalid model/i.test(msg)) {
      acpClose(opts.tabId)
      return acpPromptOnce({ ...opts, model: undefined, effort: undefined }, true)
    }
    opts.onEvent({ kind: 'error', data: msg })
    opts.onEvent({ kind: 'done' })
    return ''
  }
  const pool = pools.get(poolKey(opts.kind, opts.cwd))
  const tab = pool?.tabs.get(opts.tabId)
  if (!pool || !tab) {
    opts.onEvent({ kind: 'error', data: 'chat session is not ready' })
    opts.onEvent({ kind: 'done' })
    return ''
  }
  tab.alwaysApprove = opts.alwaysApprove !== false
  if (tab.promptId != null) acpCancel(opts.tabId)
  const gen = Date.now()
  tab.onEvent = opts.onEvent
  tab.text = ''
  tab.promptId = gen
  if (/^\s*\/compact\b/i.test(opts.text)) opts.onEvent({ kind: 'status', data: 'compacting' })
  let retry = false
  try {
    const prompt = acpPromptParts(opts.text, opts.attachments || [])
    const result = asRecord(
      await pool.rpc.request(
        'session/prompt',
        { sessionId: tab.sessionId, prompt },
        0
      )
    )
    const stop = String(result.stopReason || 'end_turn')
    if (stop !== 'cancelled' && stop !== 'end_turn' && !tab.text) {
      opts.onEvent({ kind: 'error', data: stop })
    }
  } catch (e) {
    const msg = String((e as Error).message || e)
    if (!retried && /invalid params|invalid model/i.test(msg)) retry = true
    else if (!/timed out|cancelled|stopped/i.test(msg)) opts.onEvent({ kind: 'error', data: msg })
  } finally {
    if (tab.promptId === gen) {
      tab.onEvent = undefined
      tab.promptId = null
    }
    if (!retry) opts.onEvent({ kind: 'done' })
  }
  if (retry) {
    acpClose(opts.tabId)
    return acpPromptOnce({ ...opts, model: undefined, effort: undefined }, true)
  }
  return tab.text.trim()
}

export function acpDecidePermission(tabId: string, optionId: string): boolean {
  const key = tabPool.get(tabId)
  const pool = key ? pools.get(key) : undefined
  const tab = pool?.tabs.get(tabId)
  if (!pool || !tab || tab.permId == null) return false
  let pick = optionId
  if (optionId === 'skip') {
    const hit = (tab.permOptions || []).find((o) => /reject|skip|cancel/i.test(o.id + o.label))
    pick = hit?.id || optionId
  }
  if (optionId === 'allowOnce') {
    const hit = (tab.permOptions || []).find((o) => /allow_once|allow once/i.test(o.id + o.label))
    pick = hit?.id || 'allow_once'
  }
  if (optionId === 'alwaysAllowInFolder') {
    const hit = (tab.permOptions || []).find((o) => /allow_always|always/i.test(o.id + o.label))
    pick = hit?.id || 'allow_always'
  }
  try {
    pool.rpc.reply(tab.permId, { outcome: { outcome: 'selected', optionId: pick } })
  } catch {
    return false
  }
  tab.permId = undefined
  tab.permOptions = undefined
  return true
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
}): Promise<LiveRun> {
  acpClose(opts.tabId)
  return acpWarm(opts)
}

export function acpKillAll(): void {
  for (const pool of pools.values()) pool.rpc.kill()
  pools.clear()
  tabPool.clear()
  killGrokLeader()
}

export function isAcpKind(kind: AiKind): kind is 'grok' | 'cursor' {
  return kind === 'grok' || kind === 'cursor'
}

export function prewarmProcess(kind: 'grok' | 'cursor', cwd: string): void {
  void bootPool(kind, cwd).catch(() => {})
}
