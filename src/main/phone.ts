import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { AiKind } from '../shared/contracts'
import { phonePaintHtml } from '../shared/md'
import { appendThought } from '../shared/think-run'
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
import { loadAnyChats, saveChats, type SavedChats, type SavedMsg, type SavedTab } from './persist'
import { phonePageHtml } from './phone-page'
import {
  deviceLabel,
  findDevice,
  isPhoneChatTab,
  isSealed,
  keepPhoneTabs,
  mintPin,
  mintToken,
  offerFresh,
  openJson,
  parseTunnelUrl,
  phonePairUrl,
  pickChatTab,
  pinChatId,
  rateHit,
  sealJson,
  shownPhoneLine,
  unknownEmptyChats,
  tokenFromRequest,
  tokenOk,
  underDir,
  type PhoneAttach,
  type PhoneQueueItem,
  type Sealed
} from './phone-lib'
import { phoneQrSvg } from './phone-qr'
import { setupTrace } from './setup-trace'
import { cancelWarm, closeWarm, promptWarm } from './warm'

export type PhoneDeviceView = { id: string; label: string; lastSeen: number }

export type PhoneStatus = {
  on: boolean
  url: string
  origin: string
  detail: string
  platform: NodeJS.Platform
  watching: boolean
  pairPin: string
  pairQr: string
  pairUntil: number
  devices: PhoneDeviceView[]
}

type PhoneDevice = {
  id: string
  token: string
  key: string
  label: string
  at: number
  lastSeen: number
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
let lastSeen = 0
let apiHits: number[] = []
let badHits: number[] = []
let pairHits: number[] = []
let devices: PhoneDevice[] = []
let offer: { p: string; pin: string; at: number } | null = null

function devicesFile(): string {
  return join(app.getPath('userData'), 'phone-devices.json')
}

function phonePrefFile(): string {
  return join(app.getPath('userData'), 'phone-pref.json')
}

function readPhonePrefEnabled(): boolean {
  try {
    const raw = JSON.parse(readFileSync(phonePrefFile(), 'utf8')) as { enabled?: boolean }
    return raw.enabled === true
  } catch {
    return false
  }
}

function writePhonePrefEnabled(enabled: boolean): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(phonePrefFile(), JSON.stringify({ enabled: enabled === true }))
}

function loadDevices(): PhoneDevice[] {
  try {
    const raw = JSON.parse(readFileSync(devicesFile(), 'utf8')) as { devices?: PhoneDevice[] }
    const list = Array.isArray(raw.devices) ? raw.devices : []
    devices = list.filter(
      (d) =>
        d &&
        String(d.id || '').length >= 8 &&
        String(d.token || '').length >= 16 &&
        String(d.key || '').length >= 16
    )
  } catch {
    devices = []
  }
  return devices
}

function persistDevices(): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dest = devicesFile()
  writeFileSync(dest, JSON.stringify({ devices }), { mode: 0o600 })
  try {
    chmodSync(dest, 0o600)
  } catch {
    /* */
  }
}

function mintOffer(): void {
  offer = { p: mintToken(), pin: mintPin(), at: Date.now() }
}

function status(): PhoneStatus {
  if (on && origin && !offerFresh(offer?.at || 0)) mintOffer()
  const pairUrl = on && origin && offer ? phonePairUrl(origin, offer.p) : ''
  return {
    on,
    url: '',
    origin: on ? origin : '',
    detail,
    platform: process.platform,
    watching: on && lastSeen > 0 && Date.now() - lastSeen < 5000,
    pairPin: on && offerFresh(offer?.at || 0) ? offer?.pin || '' : '',
    pairQr: pairUrl ? phoneQrSvg(pairUrl) : '',
    pairUntil: on && offer ? offer.at : 0,
    devices: on
      ? devices.map((d) => ({ id: d.id, label: d.label, lastSeen: d.lastSeen }))
      : []
  }
}

function pushStatus(): void {
  const payload = status()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:status', payload)
  }
}

const phoneOwned = new Set<string>()
const phoneClosed = new Set<string>()

function persistLiveChats(): void {
  const cwd = currentBrainFolder() || readWatching().brainPath || ''
  if (!live.chats || !cwd) return
  if (live.chats.cwd && live.chats.cwd !== cwd) {
    live.chats = null
    return
  }
  saveChats({ ...live.chats, cwd })
}

export function rememberPhoneChats(state: SavedChats): SavedChats {
  if (live.chats?.cwd && state.cwd && live.chats.cwd !== state.cwd) {
    live.chats = state
    return state
  }
  const disk = loadAnyChats(state.cwd || currentBrainFolder())
  const known = (disk?.tabs || []).filter(isPhoneChatTab).map((t) => t.id)
  const incoming = (state.tabs || []).filter(isPhoneChatTab)
  const incomingEmpty = unknownEmptyChats(state.tabs || [], state.messages || {}, known)
  const freshUnknown = incoming.length > 0 && incomingEmpty
  if (!live.chats) {
    if (incomingEmpty && disk && (disk.tabs || []).some(isPhoneChatTab)) {
      live.chats = disk
      return live.chats
    }
    live.chats = state
    return live.chats
  }
  const cur = live.chats
  for (const t of incoming) phoneOwned.delete(t.id)
  if (!incoming.length) {
    const tabs = keepPhoneTabs(cur.tabs || [], cur.tabs || [], [...phoneOwned], [...phoneClosed])
    if (tabs.some(isPhoneChatTab)) {
      live.chats = {
        ...cur,
        tabs,
        active: pinChatId(tabs.filter(isPhoneChatTab).map((t) => t.id), cur.active, '')
      }
      return live.chats
    }
  }
  if (freshUnknown && disk && (disk.tabs || []).some(isPhoneChatTab)) {
    const tabs = keepPhoneTabs(disk.tabs || [], cur.tabs || [], [...phoneOwned], [...phoneClosed])
    live.chats = {
      ...disk,
      tabs,
      messages: { ...(disk.messages || {}), ...(cur.messages || {}) },
      active: pinChatId(tabs.filter(isPhoneChatTab).map((t) => t.id), cur.active, disk.active)
    }
    return live.chats
  }
  const tabs = keepPhoneTabs(state.tabs || [], cur.tabs || [], [...phoneOwned], [...phoneClosed])
  const messages = { ...(state.messages || {}) }
  for (const id of Object.keys(cur.messages || {})) {
    const have = cur.messages[id] || []
    const next = messages[id] || []
    if (isChatBusy(id) || have.length > next.length || (phoneOwned.has(id) && !next.length)) {
      messages[id] = have
    }
  }
  const keepActive = phoneOwned.has(cur.active) && tabs.some((t) => t.id === cur.active) ? cur.active : state.active
  live.chats = { ...state, tabs, messages, active: keepActive || state.active }
  return live.chats
}

function rawChats(): SavedChats | null {
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || ''
  const disk = loadAnyChats(cwd)
  if (!live.chats) return disk
  if ((live.chats.tabs || []).some(isPhoneChatTab)) return live.chats
  if (disk && (disk.tabs || []).some(isPhoneChatTab)) {
    const tabs = keepPhoneTabs(disk.tabs || [], live.chats.tabs || [], [...phoneOwned], [...phoneClosed])
    return {
      ...disk,
      tabs,
      messages: { ...(disk.messages || {}), ...(live.chats.messages || {}) },
      active: pinChatId(tabs.filter(isPhoneChatTab).map((t) => t.id), live.chats.active, disk.active)
    }
  }
  return live.chats
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
  const tabs = (chats?.tabs || []).filter(isPhoneChatTab)
  const chatIds = tabs.map((t) => t.id)
  return {
    tabs,
    active: pinChatId(chatIds, '', chats?.active || ''),
    messages: paintMessages(chats?.messages || {}),
    busy: busyMap(),
    queue: queues
  }
}

function authed(req: IncomingMessage, url: URL): PhoneDevice | null {
  const got = tokenFromRequest(
    url.search,
    String(req.headers.authorization || ''),
    String(req.headers.cookie || '')
  )
  const device = findDevice(devices, got)
  if (device) {
    device.lastSeen = Date.now()
    lastSeen = device.lastSeen
  }
  return device
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

function sendSealed(res: ServerResponse, code: number, body: unknown, key: string): void {
  sendJson(res, code, sealJson(key, body))
}

function readSealed(req: IncomingMessage, key: string, max = 400_000): Promise<unknown> {
  return readBody(req, max).then((raw) => {
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(raw || '{}')
    } catch {
      throw new Error('bad')
    }
    if (!isSealed(parsed)) throw new Error('bad')
    return openJson(key, parsed as Sealed)
  })
}

function pairCookie(token: string): string {
  return `brain_phone=${encodeURIComponent(token)}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`
}

function pairFromPhone(req: IncomingMessage, res: ServerResponse): void {
  const now = Date.now()
  const hit = rateHit(now, pairHits, 60_000, 20)
  pairHits = hit.next
  if (!hit.ok) {
    sendJson(res, 429, { ok: false, detail: 'Wait a moment.' })
    return
  }
  void readBody(req, 4000)
    .then((raw) => {
      let parsed: { p?: string; pin?: string } = {}
      try {
        parsed = JSON.parse(raw || '{}') as { p?: string; pin?: string }
      } catch {
        sendJson(res, 400, { ok: false, detail: 'Bad request.' })
        return
      }
      if (!on || !offer || !offerFresh(offer.at, now)) {
        sendJson(res, 401, { ok: false, detail: 'Scan the new QR in Settings.' })
        return
      }
      const p = String(parsed.p || '')
      const pin = String(parsed.pin || '').replace(/\D/g, '')
      const match = tokenOk(p, offer.p) || (pin.length === 6 && tokenOk(pin, offer.pin))
      if (!match) {
        sendJson(res, 401, { ok: false, detail: 'Scan the new QR in Settings.' })
        return
      }
      offer = null
      loadDevices()
      const id = randomUUID()
      const token = mintToken()
      const key = mintToken()
      const label = deviceLabel(String(req.headers['user-agent'] || ''), devices.map((d) => d.label))
      const row: PhoneDevice = { id, token, key, label, at: now, lastSeen: now }
      devices.push(row)
      persistDevices()
      lastSeen = now
      mintOffer()
      pushStatus()
      res.setHeader('Set-Cookie', pairCookie(token))
      sendJson(res, 200, { ok: true, token, key, id, label })
    })
    .catch(() => sendJson(res, 400, { ok: false, detail: 'Bad request.' }))
}

function unlinkDevice(id: string): PhoneStatus {
  const want = String(id || '')
  devices = devices.filter((d) => d.id !== want)
  persistDevices()
  pushStatus()
  return status()
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
        setupTrace({ event: 'phone', mode: 'named', host: named.host })
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
      const text = buf.join('')
      const hit = parseTunnelUrl(text)
      if (hit && /Registered tunnel connection|Connected to/i.test(text) && !settled) {
        settled = true
        setupTrace({ event: 'phone', mode: 'quick', host: new URL(hit).host })
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
    const folded = appendThought(list, ev.data)
    list.length = 0
    list.push(...folded)
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
  phoneOwned.add(id)
  phoneClosed.delete(id)
  live.chats = {
    ...next,
    active: id,
    tabs: [...(next.tabs || []), row],
    messages: { ...(next.messages || {}), [id]: [] }
  }
  queues[id] = []
  persistLiveChats()
  sendPhoneTab({ op: 'new', id, kind })
  return { ok: true, tabId: id }
}

function closeTabFromPhone(tabId?: string): { ok: boolean; detail?: string } {
  const id = String(tabId || '')
  if (!id) return { ok: false, detail: 'No chat to close.' }
  const chats = rawChats()
  const tab = (chats?.tabs || []).find((t) => t.id === id && isPhoneChatTab(t)) || null
  if (!tab) return { ok: false, detail: 'No chat to close.' }
  phoneClosed.add(tab.id)
  phoneOwned.delete(tab.id)
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
    const chatIds = tabs.filter((t) => isPhoneChatTab(t)).map((t) => t.id)
    live.chats = {
      ...live.chats,
      tabs,
      messages,
      active: pinChatId(chatIds, '', live.chats.active)
    }
    persistLiveChats()
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
  let chats = rawChats()
  let tab = pickChatTab(chats?.tabs || [], chats?.active || '', tabId)
  if (!tab) {
    const made = newTabFromPhone('grok')
    if (!made.ok || !made.tabId) return { ok: false, detail: made.detail || 'Open a chat tab in Brain on this Mac first.' }
    chats = rawChats()
    tab = pickChatTab(chats?.tabs || [], chats?.active || '', made.tabId)
  }
  if (!tab) return { ok: false, detail: 'Open a chat tab in Brain on this Mac first.' }
  const watching = readWatching()
  const cwd = currentBrainFolder() || watching.brainPath || live.chats?.cwd || chats?.cwd || ''
  if (!cwd) return { ok: false, detail: 'No brain folder on this computer to talk against.' }
  const shown = shownPhoneLine(line, attached)
  if (forceQueue || isChatBusy(tab.id)) {
    const item: PhoneQueueItem = {
      id: randomUUID(),
      text: line,
      names: attached.map((f) => f.name),
      files: attached
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

async function attachFromPhone(
  req: IncomingMessage,
  key: string
): Promise<{ ok: boolean; detail?: string } & Partial<Attach>> {
  const parsed = (await readSealed(req, key, MAX_ATTACH * 2 + 8192)) as {
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
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    pairFromPhone(req, res)
    return
  }
  const device = authed(req, url)
  if (!device) {
    const bad = rateHit(now, badHits, 60_000, 20)
    badHits = bad.next
    sendJson(res, 401, { ok: false, detail: 'Not paired.' })
    return
  }
  const key = device.key
  if (url.pathname === '/api/state' && req.method === 'GET') {
    sendSealed(res, 200, snapshot(), key)
    return
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    void readSealed(req, key, 400_000)
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
        sendSealed(res, r.ok ? 200 : 400, r, key)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }, key))
    return
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    void readSealed(req, key)
      .then((parsed) => {
        const body = (parsed || {}) as { tabId?: string }
        sendSealed(res, 200, stopFromPhone(body.tabId), key)
      })
      .catch(() => sendSealed(res, 200, { ok: true }, key))
    return
  }
  if (url.pathname === '/api/tab' && req.method === 'POST') {
    void readSealed(req, key)
      .then((parsed) => {
        const body = (parsed || {}) as { op?: string; tabId?: string; kind?: string }
        if (body.op === 'close') {
          const r = closeTabFromPhone(body.tabId)
          sendSealed(res, r.ok ? 200 : 400, r, key)
          return
        }
        const r = newTabFromPhone(body.kind)
        sendSealed(res, r.ok ? 200 : 400, r, key)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }, key))
    return
  }
  if (url.pathname === '/api/queue' && req.method === 'POST') {
    void readSealed(req, key)
      .then((parsed) => {
        const body = (parsed || {}) as { op?: string; tabId?: string; id?: string }
        const r = queueFromPhone(String(body.op || ''), body.tabId, body.id)
        sendSealed(res, r.ok ? 200 : 400, r, key)
      })
      .catch(() => sendSealed(res, 400, { ok: false, detail: 'Bad request.' }, key))
    return
  }
  if (url.pathname === '/api/attach' && req.method === 'POST') {
    void attachFromPhone(req, key)
      .then((r) => sendSealed(res, r.ok ? 200 : 400, r, key))
      .catch((err) => {
        const msg = String((err as Error).message || err)
        sendSealed(
          res,
          400,
          {
            ok: false,
            detail: /too large/i.test(msg) ? 'That file is larger than 20 MB.' : 'Could not attach that file.'
          },
          key
        )
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
  offer = null
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
  loadDevices()
  pushStatus()
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
    mintOffer()
    detail = 'Plug this Mac in. Closing the lid on battery will sleep. Scan the QR on your phone.'
    writePhonePrefEnabled(true)
    pushStatus()
    return status()
  } catch (err) {
    const msg = String((err as Error).message || err)
    await stopPhone()
    writePhonePrefEnabled(false)
    detail = msg
    pushStatus()
    return { ...status(), detail: msg }
  } finally {
    starting = false
  }
}

/** Turn Phone back on after quit or an app update when the user left it on. */
export function restorePhoneIfWanted(): void {
  if (process.platform !== 'darwin') return
  if (!readPhonePrefEnabled()) return
  void startPhone()
}

export function rotatePhoneToken(): PhoneStatus {
  if (on) mintOffer()
  const s = status()
  pushStatus()
  return s
}

export function registerPhoneIpc(): void {
  addChatFan((ev) => {
    applyLiveEvent(ev)
  })
  ipcMain.handle('phone:start', async () => startPhone())
  ipcMain.handle('phone:stop', async () => {
    writePhonePrefEnabled(false)
    return stopPhone()
  })
  ipcMain.handle('phone:status', async () => status())
  ipcMain.handle('phone:rotate', async () => rotatePhoneToken())
  ipcMain.handle('phone:link', async () => rotatePhoneToken())
  ipcMain.handle('phone:unlink', async (_e, id: string) => unlinkDevice(String(id || '')))
  ipcMain.handle('phone:copy', async () => ({ ok: false }))
  ipcMain.on('phone:reportQueue', (_e, tabId: string, items: PhoneQueueItem[]) => {
    const id = String(tabId || '')
    if (!id) return
    queues[id] = Array.isArray(items)
      ? items.map((row) => ({
          id: String(row?.id || ''),
          text: String(row?.text || ''),
          names: Array.isArray(row?.names) ? row.names.map((n) => String(n || '')).filter(Boolean) : [],
          files: Array.isArray(row?.files)
            ? row.files
                .map((f) => ({
                  path: String(f?.path || ''),
                  name: String(f?.name || ''),
                  mime: String(f?.mime || '')
                }))
                .filter((f) => f.path && f.name)
            : []
        }))
      : []
  })
}
