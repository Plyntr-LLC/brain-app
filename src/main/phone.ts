import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import type { AiKind } from '../shared/contracts'
import { readWatching } from './agency-brain'
import { currentBrainFolder } from './brains'
import { emitChat, addChatFan, busyMap, isChatBusy, markChatBusy, sendIncoming, type ChatFanPayload } from './chat-fan'
import { loadChats, type SavedChats, type SavedMsg, type SavedTab } from './persist'
import { phonePageHtml } from './phone-page'
import {
  mintToken,
  parseTunnelUrl,
  phoneUrl,
  pickChatTab,
  pinChatId,
  tokenFromRequest,
  tokenOk
} from './phone-lib'
import { cancelWarm, promptWarm } from './warm'

export type PhoneStatus = {
  on: boolean
  url: string
  origin: string
  detail: string
  platform: NodeJS.Platform
}

type SseClient = ServerResponse

let server: Server | null = null
let tunnel: ChildProcess | null = null
let caffeine: ChildProcess | null = null
let localPort = 0
let origin = ''
let on = false
let starting = false
let boot = 0
let detail = ''
let sse: SseClient[] = []
let pingTimer: ReturnType<typeof setInterval> | null = null
const live: { chats: SavedChats | null } = { chats: null }

function tokenFile(): string {
  return join(app.getPath('userData'), 'phone.json')
}

function loadToken(): string {
  try {
    const raw = JSON.parse(readFileSync(tokenFile(), 'utf8')) as { token?: string }
    if (raw.token && String(raw.token).length >= 16) return String(raw.token)
  } catch {
    /* */
  }
  return saveToken(mintToken())
}

function saveToken(token: string): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dest = tokenFile()
  writeFileSync(dest, JSON.stringify({ token }), { mode: 0o600 })
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
    url: on && origin ? phoneUrl(origin, token) : '',
    origin: on ? origin : '',
    detail,
    platform: process.platform
  }
}

function pushStatus(): void {
  const payload = status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:status', payload)
  }
}

function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sseBroadcast(data: unknown): void {
  sse = sse.filter((res) => !res.writableEnded)
  for (const res of sse) sseWrite(res, data)
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

function snapshot(): {
  tabs: SavedTab[]
  active: string
  messages: Record<string, SavedMsg[]>
  busy: Record<string, boolean>
} {
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || ''
  const chats = live.chats || (cwd ? loadChats(cwd) : null) || loadChats()
  const tabs = chats?.tabs || []
  const chatIds = tabs.filter((t) => t.type === 'chat').map((t) => t.id)
  return {
    tabs,
    active: pinChatId(chatIds, '', chats?.active || ''),
    messages: chats?.messages || {},
    busy: busyMap()
  }
}

function authed(req: IncomingMessage, url: URL): boolean {
  const got = tokenFromRequest(url.search, String(req.headers.authorization || ''))
  return tokenOk(got, loadToken())
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(raw)
}

function readBody(req: IncomingMessage, max = 32_000): Promise<string> {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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
  } else {
    return
  }
  live.chats = {
    ...live.chats,
    messages: { ...live.chats.messages, [ev.tabId]: list }
  }
}

async function sendFromPhone(text: string, tabId?: string): Promise<{ ok: boolean; detail?: string }> {
  const line = String(text || '').trim()
  if (!line) return { ok: false, detail: 'Type something first.' }
  const snap = snapshot()
  const tab = pickChatTab(snap.tabs, snap.active, tabId)
  if (!tab) return { ok: false, detail: 'Open a chat tab in Brain on this Mac first.' }
  if (isChatBusy(tab.id)) return { ok: false, detail: 'That chat is already working. Wait, or stop it on the computer.' }
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || live.chats?.cwd || ''
  if (!cwd) return { ok: false, detail: 'No brain folder on this computer to talk against.' }
  const kind = (tab.kind || 'grok') as AiKind
  markChatBusy(tab.id, true)
  sendIncoming(tab.id, line)
  sseBroadcast({ type: 'incoming', tabId: tab.id, text: line })
  const nextMsgs = [...(snap.messages[tab.id] || []), { who: 'me' as const, text: line }]
  if (live.chats) {
    live.chats = {
      ...live.chats,
      messages: { ...live.chats.messages, [tab.id]: nextMsgs }
    }
  } else {
    live.chats = {
      cwd,
      active: tab.id,
      tabs: snap.tabs,
      messages: { ...snap.messages, [tab.id]: nextMsgs }
    }
  }
  void (async () => {
    try {
      await promptWarm({
        kind,
        tabId: tab.id,
        cwd,
        text: line,
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
  return { ok: true }
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
    if (!authed(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('This link needs the pairing code from Brain Settings on the computer.')
      return
    }
    const html = phonePageHtml()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    })
    if (req.method === 'HEAD') res.end()
    else res.end(html)
    return
  }
  if (!authed(req, url)) {
    sendJson(res, 401, { ok: false, detail: 'Not paired.' })
    return
  }
  if (url.pathname === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, snapshot())
    return
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    })
    sse.push(res)
    sseWrite(res, { type: 'state', ...snapshot() })
    if (!pingTimer) {
      pingTimer = setInterval(() => {
        sse = sse.filter((c) => !c.writableEnded)
        for (const c of sse) c.write(': ping\n\n')
      }, 15_000)
    }
    req.on('close', () => {
      sse = sse.filter((c) => c !== res)
    })
    return
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    void readBody(req)
      .then((raw) => {
        let body: { text?: string; tabId?: string } = {}
        try {
          body = JSON.parse(raw || '{}') as { text?: string; tabId?: string }
        } catch {
          sendJson(res, 400, { ok: false, detail: 'Bad request.' })
          return
        }
        return sendFromPhone(String(body.text || ''), body.tabId)
      })
      .then((r) => {
        if (!r) return
        const code = r.ok ? 200 : /already working/.test(r.detail || '') ? 409 : 400
        sendJson(res, code, r)
      })
      .catch(() => sendJson(res, 400, { ok: false, detail: 'Bad request.' }))
    return
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    void readBody(req)
      .then((raw) => {
        let body: { tabId?: string } = {}
        try {
          body = JSON.parse(raw || '{}') as { tabId?: string }
        } catch {
          body = {}
        }
        const snap = snapshot()
        const tab = pickChatTab(snap.tabs, snap.active, body.tabId)
        if (tab) cancelWarm(tab.id)
        sendJson(res, 200, { ok: true })
      })
      .catch(() => sendJson(res, 200, { ok: true }))
    return
  }
  res.writeHead(404)
  res.end()
}

function listenLocal(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer(handle)
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
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
  sseBroadcast({ type: 'off' })
  for (const res of sse) {
    try {
      res.end()
    } catch {
      /* */
    }
  }
  sse = []
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
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
  pushStatus()
  loadToken()
  try {
    localPort = await listenLocal()
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
  pushStatus()
  return status()
}

export function registerPhoneIpc(): void {
  addChatFan((ev) => {
    applyLiveEvent(ev)
    sseBroadcast({ type: 'event', ...ev })
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
}
