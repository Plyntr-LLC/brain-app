import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import type { AiKind } from '../shared/contracts'
import { phonePaintHtml } from '../shared/md'
import { readWatching } from './agency-brain'
import { MAX_ATTACH, stashBytes, type Attach } from './attach'
import { stopPrompt } from './ai-cli'
import { currentBrainFolder } from './brains'
import {
  emitChat,
  addChatFan,
  busyMap,
  isChatBusy,
  markChatBusy,
  sendIncoming,
  sendPhoneQueue,
  sendPhoneStop,
  sendPhoneTab,
  type ChatFanPayload
} from './chat-fan'
import { loadChats, type SavedChats, type SavedMsg, type SavedTab } from './persist'
import { phonePageHtml } from './phone-page'
import {
  isSealed,
  mintToken,
  openJson,
  parseTunnelUrl,
  phoneUrl,
  pickChatTab,
  pinChatId,
  rateHit,
  sealJson,
  shownPhoneLine,
  tokenFresh,
  tokenFromRequest,
  tokenOk,
  underDir,
  type PhoneAttach,
  type PhoneQueueItem,
  type Sealed
} from './phone-lib'
import { cancelWarm, closeWarm, promptWarm } from './warm'

export type PhoneStatus = {
  on: boolean
  url: string
  origin: string
  detail: string
  platform: NodeJS.Platform
  watching: boolean
}

let server: Server | null = null
let tunnel: ChildProcess | null = null
let caffeine: ChildProcess | null = null
let localPort = 0
let origin = ''
let on = false
let starting = false
let boot = 0
let detail = ''
const live: { chats: SavedChats | null } = { chats: null }
const queues: Record<string, PhoneQueueItem[]> = {}
const stashed = new Set<string>()
let tokenAt = 0
let sealKey = ''
let lastSeen = 0
let apiHits: number[] = []
let badHits: number[] = []

function tokenFile(): string {
  return join(app.getPath('userData'), 'phone.json')
}

function loadToken(): string {
  try {
    const raw = JSON.parse(readFileSync(tokenFile(), 'utf8')) as { token?: string; key?: string; at?: number }
    if (raw.token && String(raw.token).length >= 16 && raw.key && String(raw.key).length >= 16) {
      tokenAt = Number(raw.at) || tokenAt
      sealKey = String(raw.key)
      return String(raw.token)
    }
  } catch {
    /* */
  }
  return saveToken(mintToken(), mintToken())
}

function saveToken(token: string, key = mintToken()): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dest = tokenFile()
  tokenAt = Date.now()
  sealKey = key
  writeFileSync(dest, JSON.stringify({ token, key, at: tokenAt }), { mode: 0o600 })
  try {
    chmodSync(dest, 0o600)
  } catch {
    /* */
  }
  return token
}

function status(): PhoneStatus {
  const token = on ? loadToken() : ''
  return {
    on,
    url: on && origin ? phoneUrl(origin, token, sealKey) : '',
    origin: on ? origin : '',
    detail,
    platform: process.platform,
    watching: on && lastSeen > 0 && Date.now() - lastSeen < 5000
  }
}

function pushStatus(): void {
  const payload = status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:status', payload)
  }
}

export function rememberPhoneChats(state: SavedChats): void {
  if (!live.chats) {
    live.chats = state
    return
  }
  const messages = { ...(state.messages || {}) }
  for (const id of Object.keys(live.chats.messages || {})) {
    const have = live.chats.messages[id] || []
    const next = messages[id] || []
    if (isChatBusy(id) || have.length > next.length) messages[id] = have
  }
  live.chats = { ...state, messages }
}

function rawChats(): SavedChats | null {
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || ''
  return live.chats || (cwd ? loadChats(cwd) : null) || loadChats()
}

function paintMessages(all: Record<string, SavedMsg[]>): Record<string, { who: string; text: string; html: string }[]> {
  const out: Record<string, { who: string; text: string; html: string }[]> = {}
  for (const [id, list] of Object.entries(all || {})) {
    out[id] = (list || []).map((m) => ({
      who: m.who,
      text: m.text,
      html: phonePaintHtml(m.who, m.text)
    }))
  }
  return out
}

function snapshot(): {
  tabs: SavedTab[]
  active: string
  messages: Record<string, { who: string; text: string; html: string }[]>
  busy: Record<string, boolean>
  queue: Record<string, PhoneQueueItem[]>
} {
  const chats = rawChats()
  const tabs = chats?.tabs || []
  const chatIds = tabs.filter((t) => t.type === 'chat').map((t) => t.id)
  return {
    tabs,
    active: pinChatId(chatIds, '', chats?.active || ''),
    messages: paintMessages(chats?.messages || {}),
    busy: busyMap(),
    queue: queues
  }
}

function authed(req: IncomingMessage, url: URL): boolean {
  const want = loadToken()
  if (!tokenFresh(tokenAt)) return false
  const got = tokenFromRequest(url.search, String(req.headers.authorization || ''))
  const ok = tokenOk(got, want)
  if (ok) lastSeen = Date.now()
  return ok
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  })
  res.end(raw)
}

function currentSealKey(): string {
  loadToken()
  return sealKey
}

function sendSealed(res: ServerResponse, code: number, body: unknown): void {
  sendJson(res, code, sealJson(currentSealKey(), body))
}

function readSealed(req: IncomingMessage, max = 400_000): Promise<unknown> {
  return readBody(req, max).then((raw) => {
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(raw || '{}')
    } catch {
      throw new Error('bad')
    }
    if (!isSealed(parsed)) throw new Error('bad')
    return openJson(currentSealKey(), parsed as Sealed)
  })
}

function fontDir(): string {
  const names = [
    join(process.resourcesPath || '', 'phone-fonts'),
    join(dirname(fileURLToPath(import.meta.url)), 'phone-fonts'),
    join(app.getAppPath(), 'src/main/phone-fonts')
  ]
  for (const dir of names) {
    if (dir && existsSync(join(dir, 'schibsted.woff2'))) return dir
  }
  return names[1]
}

function sendFont(res: ServerResponse, name: string): void {
  const allowed: Record<string, string> = {
    'schibsted.woff2': 'font/woff2',
    'source-serif.woff2': 'font/woff2'
  }
  const mime = allowed[name]
  if (!mime) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = join(fontDir(), name)
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  })
  res.end(readFileSync(file))
}

function readBuf(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > max) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req: IncomingMessage, max = 32_000): Promise<string> {
  return readBuf(req, max).then((buf) => buf.toString('utf8'))
}

export const PHONE_PORT = 18765
export const PHONE_HOST = 'brain-phone.plyntr.com'

type NamedPhone = {
  origin: string
  host: string
  tunnelId: string
  port: number
  tokenFile: string
}

function namedPhone(): NamedPhone | null {
  const dir = join(homedir(), '.brain-secrets', 'brain-phone')
  const cfgPath = join(dir, 'config.json')
  const tokenFile = join(dir, 'token')
  if (!existsSync(cfgPath) || !existsSync(tokenFile)) return null
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      origin?: string
      host?: string
      tunnelId?: string
      port?: number
    }
    const host = String(raw.host || PHONE_HOST)
    const origin = String(raw.origin || `https://${host}`).replace(/\/$/, '')
    const port = Number(raw.port) || PHONE_PORT
    if (!origin || !raw.tunnelId) return null
    return { origin, host, tunnelId: String(raw.tunnelId), port, tokenFile }
  } catch {
    return null
  }
}

function cloudflaredBin(): string | null {
  const extra = '/opt/homebrew/bin:/usr/local/bin'
  const named = [process.env.CLOUDFLARED_BIN, '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']
  for (const p of named) {
    if (p && existsSync(p)) return p
  }
  try {
    const out = execFileSync('which', ['cloudflared'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${process.env.PATH || ''}:${extra}` }
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function spawnCaffeine(): void {
  if (process.platform !== 'darwin') return
  caffeine = spawn('caffeinate', ['-dims'], { stdio: ['ignore', 'ignore', 'ignore'] })
  caffeine.on('exit', () => {
    if (caffeine) caffeine = null
  })
}

function startTunnel(port: number): Promise<string> {
  const bin = cloudflaredBin()
  if (!bin) {
    return Promise.reject(
      new Error('cloudflared is not on this Mac. In Terminal: brew install cloudflared')
    )
  }
  const named = namedPhone()
  if (named) return startNamedTunnel(bin, named, port)
  return startQuickTunnel(bin, port)
}

function startNamedTunnel(bin: string, named: NamedPhone, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const extra = '/opt/homebrew/bin:/usr/local/bin'
    tunnel = spawn(
      bin,
      [
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        named.tokenFile,
        '--url',
        `http://127.0.0.1:${port}`
      ],
      {
        env: { ...process.env, PATH: `${process.env.PATH || ''}:${extra}` },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const tryParse = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (!settled && /Registered tunnel connection|connIndex=|Connected to/i.test(text)) {
        settled = true
        resolve(named.origin)
      }
    }
    tunnel.stdout?.on('data', tryParse)
    tunnel.stderr?.on('data', tryParse)
    tunnel.on('exit', (code) => {
      tunnel = null
      if (!settled) {
        settled = true
        reject(new Error(code ? `The tunnel quit (${code}).` : 'The tunnel quit.'))
        return
      }
      if (on) {
        origin = ''
        detail = 'The tunnel quit. Turn Phone off and on.'
        pushStatus()
      }
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('The named tunnel did not come up. Check this Mac is online.'))
    }, 25_000)
  })
}

function startQuickTunnel(bin: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const buf: string[] = []
    const extra = '/opt/homebrew/bin:/usr/local/bin'
    tunnel = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      env: { ...process.env, PATH: `${process.env.PATH || ''}:${extra}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const tryParse = (chunk: Buffer) => {
      buf.push(chunk.toString('utf8'))
      const hit = parseTunnelUrl(buf.join(''))
      if (hit && !settled) {
        settled = true
        resolve(hit)
      }
    }
    tunnel.stdout?.on('data', tryParse)
    tunnel.stderr?.on('data', tryParse)
    tunnel.on('exit', (code) => {
      tunnel = null
      if (!settled) {
        settled = true
        reject(new Error(code ? `The tunnel quit (${code}).` : 'The tunnel quit.'))
        return
      }
      if (on) {
        origin = ''
        detail = 'The tunnel quit. Turn Phone off and on.'
        pushStatus()
      }
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('The tunnel did not come up. Check this Mac is online.'))
    }, 25_000)
  })
}

function applyLiveEvent(ev: ChatFanPayload): void {
  if (!live.chats || !ev.tabId) return
  const list = (live.chats.messages[ev.tabId] || []).map((m) => ({ ...m }))
  if (ev.kind === 'text' && ev.data) {
    const last = list[list.length - 1]
    if (last && last.who === 'brain') last.text += ev.data
    else list.push({ who: 'brain', text: ev.data })
  } else if (ev.kind === 'thought' && ev.data) {
    const last = list[list.length - 1]
    if (last && last.who === 'think') last.text += ev.data
    else list.push({ who: 'think', text: ev.data })
  } else if (ev.kind === 'error' && ev.data) {
    list.push({ who: 'brain', text: ev.data })
  } else if (ev.kind === 'file' && ev.path) {
    const base = String(ev.path).replace(/\\/g, '/').split('/').filter(Boolean).pop() || ev.path
    list.push({ who: 'sys', text: `${ev.tool || 'file'} · ${base}` })
  } else {
    return
  }
  live.chats = {
    ...live.chats,
    messages: { ...live.chats.messages, [ev.tabId]: list }
  }
}

function chatKind(raw?: string): AiKind {
  if (raw === 'claude' || raw === 'gpt' || raw === 'cursor' || raw === 'grok') return raw
  return 'grok'
}

function chatTitle(kind: AiKind): string {
  if (kind === 'claude') return 'Claude'
  if (kind === 'gpt') return 'ChatGPT'
  if (kind === 'cursor') return 'Cursor'
  return 'Grok'
}

function newTabFromPhone(wantKind?: string): { ok: boolean; tabId?: string; detail?: string } {
  const chats = rawChats()
  const cur = pickChatTab(chats?.tabs || [], chats?.active || '')
  const kind = chatKind(wantKind || cur?.kind)
  const id = randomUUID()
  const row: SavedTab = { id, type: 'chat', title: chatTitle(kind), kind }
  const next = live.chats || {
    cwd: currentBrainFolder() || readWatching().brainPath || chats?.cwd || '',
    active: id,
    tabs: chats?.tabs || [],
    messages: chats?.messages || {}
  }
  live.chats = {
    ...next,
    active: id,
    tabs: [...(next.tabs || []), row],
    messages: { ...(next.messages || {}), [id]: [] }
  }
  queues[id] = []
  sendPhoneTab({ op: 'new', id, kind })
  return { ok: true, tabId: id }
}

function closeTabFromPhone(tabId?: string): { ok: boolean; detail?: string } {
  const id = String(tabId || '')
  if (!id) return { ok: false, detail: 'No chat to close.' }
  const chats = rawChats()
  const tab = (chats?.tabs || []).find((t) => t.id === id && t.type === 'chat') || null
  if (!tab) return { ok: false, detail: 'No chat to close.' }
  cancelWarm(tab.id)
  closeWarm(tab.id)
  stopPrompt(tab.id)
  markChatBusy(tab.id, false)
  delete queues[tab.id]
  sendPhoneTab({ op: 'close', id: tab.id })
  if (live.chats) {
    const tabs = live.chats.tabs.filter((t) => t.id !== tab.id)
    const messages = { ...live.chats.messages }
    delete messages[tab.id]
    const chatIds = tabs.filter((t) => t.type === 'chat').map((t) => t.id)
    live.chats = {
      ...live.chats,
      tabs,
      messages,
      active: pinChatId(chatIds, '', live.chats.active)
    }
  }
  return { ok: true }
}

function asFiles(raw: unknown): PhoneAttach[] {
  if (!Array.isArray(raw)) return []
  const root = join(app.getPath('userData'), 'drops')
  const out: PhoneAttach[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const rec = row as PhoneAttach
    const path = String(rec.path || '')
    if (!path || !underDir(root, path)) continue
    let real = path
    try {
      real = realpathSync(path)
    } catch {
      continue
    }
    if (!stashed.has(real)) continue
    out.push({
      path: real,
      name: String(rec.name || basename(real) || 'file'),
      mime: String(rec.mime || '')
    })
  }
  return out
}

function sendFromPhone(
  text: string,
  tabId?: string,
  files?: PhoneAttach[],
  forceQueue?: boolean
): { ok: boolean; detail?: string; queued?: boolean; tabId?: string } {
  const line = String(text || '').trim()
  const attached = files || []
  if (!line && !attached.length) return { ok: false, detail: 'Type something or attach a file.' }
  const chats = rawChats()
  const tab = pickChatTab(chats?.tabs || [], chats?.active || '', tabId)
  if (!tab) return { ok: false, detail: 'Open a chat tab in Brain on this Mac first.' }
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || live.chats?.cwd || chats?.cwd || ''
  if (!cwd) return { ok: false, detail: 'No brain folder on this computer to talk against.' }
  const shown = shownPhoneLine(line, attached)
  if (forceQueue || isChatBusy(tab.id)) {
    const item: PhoneQueueItem = {
      id: randomUUID(),
      text: line,
      names: attached.map((f) => f.name)
    }
    queues[tab.id] = [...(queues[tab.id] || []), item]
    sendIncoming(tab.id, line, { files: attached, queued: true, queueId: item.id })
    return { ok: true, queued: true, tabId: tab.id }
  }
  const kind = (tab.kind || 'grok') as AiKind
  markChatBusy(tab.id, true)
  sendIncoming(tab.id, shown, { files: attached })
  const nextMsgs = [...(chats?.messages[tab.id] || []), { who: 'me' as const, text: shown }]
  if (live.chats) {
    live.chats = {
      ...live.chats,
      messages: { ...live.chats.messages, [tab.id]: nextMsgs }
    }
  } else {
    live.chats = {
      cwd,
      active: tab.id,
      tabs: chats?.tabs || [],
      messages: { ...(chats?.messages || {}), [tab.id]: nextMsgs }
    }
  }
  void (async () => {
    try {
      await promptWarm({
        kind,
        tabId: tab.id,
        cwd,
        text: line,
        attachments: attached,
        model: tab.model,
        effort: tab.effort,
        agentMode: tab.agentMode,
        onEvent: (ev) => {
          emitChat({ tabId: tab.id, cli: kind, sessionId: tab.cliSessionId, ev })
        }
      })
    } catch (err) {
      const msg = String((err as Error).message || err)
      emitChat({ tabId: tab.id, cli: kind, sessionId: tab.cliSessionId, ev: { kind: 'error', data: msg } })
      emitChat({ tabId: tab.id, cli: kind, sessionId: tab.cliSessionId, ev: { kind: 'done' } })
    }
  })()
  return { ok: true, tabId: tab.id }
}

function stopFromPhone(tabId?: string): { ok: boolean } {
  const chats = rawChats()
  const tab = pickChatTab(chats?.tabs || [], chats?.active || '', tabId)
  if (tab) {
    sendPhoneStop(tab.id)
    cancelWarm(tab.id)
    stopPrompt(tab.id)
    markChatBusy(tab.id, false)
  }
  return { ok: true }
}

function queueFromPhone(op: string, tabId?: string, id?: string): { ok: boolean; detail?: string } {
  const chats = rawChats()
  const tab = pickChatTab(chats?.tabs || [], chats?.active || '', tabId)
  if (!tab) return { ok: false, detail: 'No chat.' }
  const qid = String(id || '')
  if (!qid) return { ok: false, detail: 'Missing queue item.' }
  if (op === 'drop') {
    queues[tab.id] = (queues[tab.id] || []).filter((x) => x.id !== qid)
    sendPhoneQueue({ op: 'drop', tabId: tab.id, id: qid })
    return { ok: true }
  }
  if (op === 'now') {
    queues[tab.id] = (queues[tab.id] || []).filter((x) => x.id !== qid)
    sendPhoneQueue({ op: 'now', tabId: tab.id, id: qid })
    return { ok: true }
  }
  return { ok: false, detail: 'Unknown queue action.' }
}

async function attachFromPhone(req: IncomingMessage): Promise<{ ok: boolean; detail?: string } & Partial<Attach>> {
  const parsed = (await readSealed(req, MAX_ATTACH * 2 + 8192)) as {
    name?: string
    mime?: string
    bytes?: string
  }
  let name = 'drop'
  try {
    name = basename(String(parsed?.name || 'drop')) || 'drop'
  } catch {
    name = 'drop'
  }
  const mime = String(parsed?.mime || '')
  let buf: Buffer
  try {
    buf = Buffer.from(String(parsed?.bytes || ''), 'base64url')
  } catch {
    return { ok: false, detail: 'Could not attach that file.' }
  }
  if (!buf.length) return { ok: false, detail: 'That file was empty.' }
  if (buf.length > MAX_ATTACH) return { ok: false, detail: 'That file is larger than 20 MB.' }
  const row = stashBytes(name, buf, mime)
  try {
    stashed.add(realpathSync(row.path))
  } catch {
    stashed.add(row.path)
  }
  return { ok: true, ...row }
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const host = '127.0.0.1'
  let url: URL
  try {
    url = new URL(req.url || '/', `http://${host}`)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (!on) {
    if (url.pathname.startsWith('/api/')) sendJson(res, 503, { ok: false, detail: 'Phone is off.' })
    else {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Phone is off on the computer.')
    }
    return
  }
  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    const html = phonePageHtml()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'"
    })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
    return
  }
  if (url.pathname.startsWith('/font/') && (req.method === 'GET' || req.method === 'HEAD')) {
    sendFont(res, basename(url.pathname))
    return
  }
  const now = Date.now()
  const api = rateHit(now, apiHits, 60_000, 120)
  apiHits = api.next
  if (!api.ok) {
    sendJson(res, 429, { ok: false, detail: 'Wait a moment.' })
    return
  }
  if (!authed(req, url)) {
    const bad = rateHit(now, badHits, 60_000, 20)
    badHits = bad.next
    sendJson(res, 401, { ok: false, detail: 'Not paired.' })
    return
  }
  if (url.pathname === '/api/state' && req.method === 'GET') {
    sendSealed(res, 200, snapshot())
    return
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    void readSealed(req, 400_000)
      .then((parsed) => {
        const body = (parsed || {}) as { text?: string; tabId?: string; files?: PhoneAttach[]; queue?: boolean }
        const wanted = Array.isArray(body.files) ? body.files.length : 0
        const attached = asFiles(body.files)
        if (wanted && !attached.length) {
          return { ok: false, detail: 'Those files are not from this Phone session.' }
        }
        return sendFromPhone(String(body.text || ''), body.tabId, attached, Boolean(body.queue))
      })
      .then((r) => {
        if (!r) return
        sendSealed(res, r.ok ? 200 : 400, r)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }))
    return
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    void readSealed(req)
      .then((parsed) => {
        const body = (parsed || {}) as { tabId?: string }
        sendSealed(res, 200, stopFromPhone(body.tabId))
      })
      .catch(() => sendSealed(res, 200, { ok: true }))
    return
  }
  if (url.pathname === '/api/tab' && req.method === 'POST') {
    void readSealed(req)
      .then((parsed) => {
        const body = (parsed || {}) as { op?: string; tabId?: string; kind?: string }
        if (body.op === 'close') {
          const r = closeTabFromPhone(body.tabId)
          sendSealed(res, r.ok ? 200 : 400, r)
          return
        }
        const r = newTabFromPhone(body.kind)
        sendSealed(res, r.ok ? 200 : 400, r)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }))
    return
  }
  if (url.pathname === '/api/queue' && req.method === 'POST') {
    void readSealed(req)
      .then((parsed) => {
        const body = (parsed || {}) as { op?: string; tabId?: string; id?: string }
        const r = queueFromPhone(String(body.op || ''), body.tabId, body.id)
        sendSealed(res, r.ok ? 200 : 400, r)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }))
    return
  }
  if (url.pathname === '/api/attach' && req.method === 'POST') {
    void attachFromPhone(req)
      .then((r) => sendSealed(res, r.ok ? 200 : 400, r))
      .catch((err) => {
        const msg = String((err as Error).message || err)
        sendSealed(res, 400, {
          ok: false,
          detail: /too large/i.test(msg) ? 'That file is larger than 20 MB.' : 'Could not attach that file.'
        })
      })
    return
  }
  res.writeHead(404)
  res.end()
}

function listenLocal(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer(handle)
    s.on('error', reject)
    s.listen(port, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr === 'string') {
        s.close()
        reject(new Error('Could not open a local port.'))
        return
      }
      server = s
      resolve(addr.port)
    })
  })
}

function killProc(proc: ChildProcess | null): void {
  if (!proc) return
  try {
    proc.kill('SIGTERM')
  } catch {
    /* */
  }
}

export async function stopPhone(): Promise<PhoneStatus> {
  boot += 1
  on = false
  origin = ''
  localPort = 0
  detail = ''
  lastSeen = 0
  stashed.clear()
  killProc(tunnel)
  tunnel = null
  killProc(caffeine)
  caffeine = null
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
    server = null
  })
  pushStatus()
  return status()
}

export async function startPhone(): Promise<PhoneStatus> {
  if (process.platform !== 'darwin') {
    detail = 'Phone is Mac only this round.'
    pushStatus()
    return status()
  }
  if (on && origin) return status()
  if (starting) return status()
  starting = true
  await stopPhone()
  const mine = boot
  detail = 'Starting the tunnel…'
  on = true
  lastSeen = 0
  pushStatus()
  saveToken(mintToken())
  try {
    localPort = await listenLocal(namedPhone()?.port || 0)
    if (mine !== boot) return status()
    spawnCaffeine()
    origin = await startTunnel(localPort)
    if (mine !== boot) {
      killProc(tunnel)
      tunnel = null
      origin = ''
      return status()
    }
    detail = 'Plug this Mac in. Closing the lid on battery will sleep.'
    pushStatus()
    return status()
  } catch (err) {
    const msg = String((err as Error).message || err)
    await stopPhone()
    detail = msg
    pushStatus()
    return { ...status(), detail: msg }
  } finally {
    starting = false
  }
}

export function rotatePhoneToken(): PhoneStatus {
  saveToken(mintToken())
  const s = status()
  if (s.url) clipboard.writeText(s.url)
  pushStatus()
  return s
}

export function registerPhoneIpc(): void {
  addChatFan((ev) => {
    applyLiveEvent(ev)
  })
  ipcMain.handle('phone:start', async () => startPhone())
  ipcMain.handle('phone:stop', async () => stopPhone())
  ipcMain.handle('phone:status', async () => status())
  ipcMain.handle('phone:rotate', async () => rotatePhoneToken())
  ipcMain.handle('phone:copy', async () => {
    const s = status()
    if (!s.url) return { ok: false }
    clipboard.writeText(s.url)
    return { ok: true }
  })
  ipcMain.on('phone:reportQueue', (_e, tabId: string, items: PhoneQueueItem[]) => {
    const id = String(tabId || '')
    if (!id) return
    queues[id] = Array.isArray(items)
      ? items.map((row) => ({
          id: String(row?.id || ''),
          text: String(row?.text || ''),
          names: Array.isArray(row?.names) ? row.names.map((n) => String(n || '')).filter(Boolean) : []
        }))
      : []
  })
}
