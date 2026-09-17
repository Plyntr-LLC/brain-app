import type { StreamEvent } from './ai-cli'
import { binEnv, resolveBin } from './ai-cli'
import { asRecord, fileHits, LineRpc, spawnBin, type RpcMsg } from './line-rpc'

const RULES =
  'You are the brain on this computer. Answer in plain English. You may read files. Do not edit or write files. Do not dump tool names or keyboard shortcuts.'

type Tab = {
  tabId: string
  threadId: string
  model?: string
  effort?: string
  onEvent?: (ev: StreamEvent) => void
  waiting: { resolve: () => void } | null
  text: string
}

type Pool = {
  cwd: string
  rpc: LineRpc
  boot: Promise<void>
  tabs: Map<string, Tab>
  byThread: Map<string, string>
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

function handleNote(pool: Pool, msg: RpcMsg): void {
  const params = asRecord(msg.params)
  const threadId = String(params.threadId || asRecord(params.thread).id || '')
  const tabId = pool.byThread.get(threadId)
  const tab = tabId ? pool.tabs.get(tabId) : undefined
  if (!tab?.onEvent) {
    if (msg.method === 'turn/completed') {
      const t = pool.tabs.get(pool.byThread.get(threadId) || '')
      t?.waiting?.resolve()
      if (t) t.waiting = null
    }
    return
  }
  if (msg.method === 'item/agentMessage/delta') {
    const bit = String(params.delta || '')
    if (bit) {
      tab.text += bit
      tab.onEvent({ kind: 'text', data: bit })
    }
    return
  }
  if (msg.method === 'item/reasoning/textDelta' || msg.method === 'item/reasoning/summaryTextDelta') {
    const bit = String(params.delta || '')
    if (bit) tab.onEvent({ kind: 'thought', data: bit })
    return
  }
  if (msg.method === 'item/started' || msg.method === 'item/completed') {
    for (const ev of fileHits(params, String(asRecord(params.item).type || 'tool'))) tab.onEvent(ev)
    return
  }
  if (msg.method === 'turn/completed') {
    tab.waiting?.resolve()
    tab.waiting = null
  }
}

function handleReq(pool: Pool, msg: RpcMsg): void {
  if (msg.id == null) return
  const method = String(msg.method || '')
  if (method === 'item/fileChange/requestApproval') {
    pool.rpc.reply(msg.id, { decision: 'decline' })
    return
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/execCommand/requestApproval') {
    pool.rpc.reply(msg.id, { decision: 'accept' })
    return
  }
  pool.rpc.reply(msg.id, {})
}

async function bootPool(cwd: string): Promise<Pool> {
  const existing = pools.get(cwd)
  if (existing && !existing.rpc.dead) return existing
  const pending = booting.get(cwd)
  if (pending) return pending
  const work = bootPoolNow(cwd)
  booting.set(cwd, work)
  try {
    return await work
  } finally {
    booting.delete(cwd)
  }
}

async function bootPoolNow(cwd: string): Promise<Pool> {
  const again = pools.get(cwd)
  if (again && !again.rpc.dead) return again
  const bin = resolveBin('gpt')
  if (!bin) throw new Error('Codex is not installed on this computer')
  const proc = spawnBin(bin, ['app-server', '--listen', 'stdio://'], cwd, binEnv())
  const pool: Pool = {
    cwd,
    rpc: null as unknown as LineRpc,
    boot: Promise.resolve(),
    tabs: new Map(),
    byThread: new Map()
  }
  pool.rpc = new LineRpc(proc, (m) => handleNote(pool, m), (m) => handleReq(pool, m), false)
  pool.boot = (async () => {
    await pool.rpc.request(
      'initialize',
      { clientInfo: { name: 'brain-app', title: 'Brain', version: '0.1.0' } },
      20_000
    )
    pool.rpc.notify('initialized', {})
  })()
  proc.on('exit', () => {
    if (pools.get(cwd) === pool) pools.delete(cwd)
    for (const tabId of pool.tabs.keys()) tabPool.delete(tabId)
  })
  pools.set(cwd, pool)
  await pool.boot
  return pool
}

export async function codexWarm(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<{ model?: string; effort?: string }> {
  return withTabLock(opts.tabId, async () => {
    const pool = await bootPool(opts.cwd)
    tabPool.set(opts.tabId, opts.cwd)
    const have = pool.tabs.get(opts.tabId)
    if (have) {
      if (opts.model) have.model = opts.model
      if (opts.effort) have.effort = opts.effort
      return { model: have.model, effort: have.effort }
    }
    const res = asRecord(
      await pool.rpc.request(
        'thread/start',
        {
          cwd: opts.cwd,
          model: opts.model || undefined,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          developerInstructions: RULES,
          serviceName: 'brain-app'
        },
        60_000
      )
    )
    const thread = asRecord(res.thread)
    const threadId = String(thread.id || res.threadId || '')
    if (!threadId) throw new Error('Codex did not return a thread')
    const model = opts.model || (typeof thread.model === 'string' ? thread.model : undefined)
    const effort = opts.effort || (typeof thread.effort === 'string' ? thread.effort : undefined)
    pool.tabs.set(opts.tabId, {
      tabId: opts.tabId,
      threadId,
      model,
      effort,
      waiting: null,
      text: ''
    })
    pool.byThread.set(threadId, opts.tabId)
    return { model, effort }
  })
}

export async function codexPrompt(opts: {
  tabId: string
  cwd: string
  text: string
  model?: string
  effort?: string
  onEvent: (ev: StreamEvent) => void
}): Promise<string> {
  await codexWarm(opts)
  const pool = pools.get(opts.cwd)
  const tab = pool?.tabs.get(opts.tabId)
  if (!pool || !tab) throw new Error('Codex session is not ready')
  if (tab.waiting) codexCancel(opts.tabId)
  tab.onEvent = opts.onEvent
  tab.text = ''
  const params: Record<string, unknown> = {
    threadId: tab.threadId,
    input: [{ type: 'text', text: opts.text }]
  }
  if (opts.model) params.model = opts.model
  if (opts.effort) params.effort = opts.effort
  await pool.rpc.request('turn/start', params, 20_000)
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      codexCancel(opts.tabId)
      resolve()
    }, 180_000)
    tab.waiting = {
      resolve: () => {
        clearTimeout(t)
        resolve()
      }
    }
  })
  tab.onEvent = undefined
  opts.onEvent({ kind: 'done' })
  return tab.text.trim()
}

export function codexCancel(tabId: string): boolean {
  const cwd = tabPool.get(tabId)
  const pool = cwd ? pools.get(cwd) : undefined
  const tab = pool?.tabs.get(tabId)
  if (!pool || !tab) return false
  try {
    void pool.rpc.request('turn/interrupt', { threadId: tab.threadId }, 5_000).catch(() => {})
  } catch {
    return false
  }
  tab.waiting?.resolve()
  tab.waiting = null
  return true
}

export function codexClose(tabId: string): void {
  const cwd = tabPool.get(tabId)
  tabPool.delete(tabId)
  const pool = cwd ? pools.get(cwd) : undefined
  const tab = pool?.tabs.get(tabId)
  if (!pool || !tab) return
  pool.tabs.delete(tabId)
  pool.byThread.delete(tab.threadId)
  tab.waiting?.resolve()
  tab.waiting = null
  try {
    void pool.rpc.request('thread/unsubscribe', { threadId: tab.threadId }, 5_000).catch(() => {})
  } catch {
    /* */
  }
  if (pool.tabs.size === 0) {
    pool.rpc.kill()
    pools.delete(cwd!)
  }
}

export async function codexReset(opts: { tabId: string; cwd: string; model?: string; effort?: string }): Promise<void> {
  codexClose(opts.tabId)
  await codexWarm(opts)
}

export function codexKillAll(): void {
  for (const pool of pools.values()) pool.rpc.kill()
  pools.clear()
  tabPool.clear()
}
