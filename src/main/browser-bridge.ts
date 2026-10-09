import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { BrowseStepResult, DeskBrowser, WhatsAppSendAnswer, WhatsAppSendAsk } from '../shared/desk.ts'
import { keyName } from './desk/browser.ts'
import { WHATSAPP_BOX } from './desk/wa-send.ts'
import { isWhatsApp, whatsappAccount, WHATSAPP_PARTITION_PREFIX } from '../shared/page-picture.ts'

/**
 * Lets a chat CLI drive the browser inside Brain. Brain listens on a socket in its userData; the CLI runs
 * browser-mcp.cjs with this run's socket, token, and the chat's owner (`chat:<tabId>`) in its env.
 * Every call lands on the same desk engine the Desk bots and the thread picture use.
 */

export type BridgeCall = { token?: unknown; owner?: unknown; tool?: unknown; args?: unknown }
export type BridgeReply = { ok: true; text: string; image?: string } | { ok: false; error: string }
export type ServerSpec = { name: string; command: string; args: string[]; env: Record<string, string> }
export type SendAsk = WhatsAppSendAsk
export type SendAnswer = WhatsAppSendAnswer

const SERVER = 'brain-browser'
const CALL_MS = 40_000

type Running = { server: Server; dir: string; sock: string; pipe: boolean; token: string; script: string; exec: string; tools: ReturnType<typeof makeBrowserTools> }

/** Where the bridge listens: a named pipe on Windows (no unix sockets there), else an owner-only socket file in userData. */
export function socketPath(platform: NodeJS.Platform, dir: string, pid: number): string {
  if (platform === 'win32') return `\\\\.\\pipe\\brain-browser-${pid}-${randomBytes(4).toString('hex')}`
  return join(dir, `browser-${pid}.sock`)
}
let running: Running | null = null

/** browser-mcp.cjs: in the packed app it sits in Resources; in `npm run dev` it is the source file. */
export function bridgeScriptPath(where: { resourcesPath?: string; appPath?: string }): string {
  const packed = where.resourcesPath ? join(where.resourcesPath, 'browser-mcp.cjs') : ''
  if (packed && existsSync(packed)) return packed
  return join(where.appPath || process.cwd(), 'src', 'main', 'browser-mcp.cjs')
}

export function serverSpec(o: { exec: string; script: string; sock: string; token: string; owner: string }): ServerSpec {
  return {
    name: SERVER,
    command: o.exec,
    args: [o.script],
    env: { ELECTRON_RUN_AS_NODE: '1', BRAIN_BROWSER_SOCK: o.sock, BRAIN_BROWSER_TOKEN: o.token, BRAIN_BROWSER_OWNER: o.owner }
  }
}

function describe(r: BrowseStepResult): BridgeReply {
  if ('ok' in r) {
    const controls = r.controls.map((c, i) => `#${i + 1} ${c}`).join('\n') || '(none)'
    const popup =
      r.popup === 'opened'
        ? 'A pop-up opened on top. This is the pop-up; when it closes, the page under it comes back.\n\n'
        : r.popup === 'closed'
          ? 'The pop-up closed. This is the page that was under it.\n\n'
          : ''
    return { ok: true, text: `${popup}Page: ${r.title || '(no title)'}\nURL: ${r.url}\n\nControls (use the number or the name):\n${controls}\n\nText:\n${r.text}` }
  }
  if ('signIn' in r) {
    return {
      ok: true,
      text: `This page wants a sign-in (${r.title || r.url}). Ask the person to sign in, in the browser picture in this chat thread (a click on the picture opens it larger). Then call browser_read.`
    }
  }
  if ('hold' in r) {
    return { ok: false, error: `Not pressed: "${r.name}" can spend money or change an account. Ask the person. They can click it themselves in the browser picture in this thread.` }
  }
  if ('refused' in r && r.refused === 'pay' && r.name === WHATSAPP_BOX) {
    return { ok: false, error: "Not pressed: Enter in WhatsApp's message box sends the message. Use whatsapp_send; the person presses Send on the card in this thread." }
  }
  if ('refused' in r && r.refused === 'pay') {
    return { ok: false, error: `Not pressed: "${r.name ?? ''}" sends or publishes. Ask the person. They can click it themselves in the browser picture in this thread.` }
  }
  if ('refused' in r) {
    if (r.refused === 'ambiguous') return { ok: false, error: `More than one control is named "${r.name}". Use its number from browser_read.` }
    if (r.refused === 'page-changed') return { ok: false, error: `The page moved on (${r.url}). Call browser_read.` }
    if (r.refused === 'window-changed') return { ok: false, error: 'A pop-up opened (or closed) since your last read, so nothing was pressed. Read the page again.' }
    if (r.refused === 'no-submit') return { ok: false, error: 'There is nothing to submit here. Use browser_key or browser_click.' }
    return { ok: false, error: `No control named "${r.name ?? ''}" on ${r.url || 'this page'}. Call browser_read for the current list.` }
  }
  return { ok: false, error: 'The browser inside Brain is not available.' }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The page did not answer in ${Math.round(ms / 1000)} s.`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** `main` and every other WhatsApp account that has a saved partition under this userData. */
export function whatsappAccounts(userData?: string): string[] {
  const dir = userData ? join(userData, 'Partitions') : ''
  const named = dir && existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(WHATSAPP_PARTITION_PREFIX)).map((n) => n.slice(WHATSAPP_PARTITION_PREFIX.length)) : []
  return ['main', ...named.filter((n) => whatsappAccount(n) === n).sort()]
}

/** The tool calls for one browser. Exported so the check drives the same code the socket does. */
export function makeBrowserTools(
  browser: DeskBrowser,
  onOpened: (owner: string, url?: string) => void,
  userData?: string,
  onSendAsk: (ask: SendAsk) => void = () => {}
) {
  const sessions = new Map<string, string>()
  let n = 0
  type Card = { owner: string; account: string; to: string; text: string; state: 'waiting' | 'sending' | 'sent' | 'not-sent' }
  const cards = new Map<string, Card>()

  /** The person's answer on a Send card. One answer per card, from the chat that holds it. */
  async function answerSend(id: string, yes: boolean, owner: string): Promise<SendAnswer> {
    const card = cards.get(id)
    if (!card || card.owner !== owner || card.state !== 'waiting') return { refused: true }
    // Set before anything is awaited, so a second answer arriving now is refused.
    card.state = yes ? 'sending' : 'not-sent'
    if (!yes) return { ok: false, note: 'Not sent.' }
    const sent = browser.whatsappSend ? await browser.whatsappSend({ account: card.account, to: card.to, body: card.text }) : { ok: false as const, note: "Brain's browser cannot send WhatsApp messages." }
    card.state = sent.ok ? 'sent' : 'not-sent'
    return sent
  }

  async function session(owner: string): Promise<string> {
    const have = sessions.get(owner)
    if (have) return have
    const id = `mcp:${owner}:${++n}`
    await browser.open(id, owner)
    sessions.set(owner, id)
    return id
  }

  async function step(owner: string, action: string, detail = '', url?: string, account?: string): Promise<BrowseStepResult> {
    for (let tries = 1; ; tries++) {
      const fresh = !sessions.has(owner)
      const id = await session(owner)
      try {
        // A new session (after a sign-in, or a Brain restart) has no page list yet. Read the shown page first.
        if (fresh && action !== 'url' && action !== 'read') {
          const looked = await browser.runStep(id, { action: 'read' })
          if (!('ok' in looked)) return looked
        }
        const r = await browser.runStep(id, { action, detail, url, account })
        // A sign-in ends the desk session. The next call opens a new one on the same window.
        if ('signIn' in r) sessions.delete(owner)
        return r
      } catch (e) {
        if (tries >= 2 || !/without an open session|before its url step/.test(String((e as Error)?.message))) throw e
        sessions.delete(owner)
      }
    }
  }

  async function run(owner: string, tool: string, args: Record<string, unknown>): Promise<BridgeReply> {
    const str = (k: string) => String(args[k] ?? '').trim()
    switch (tool) {
      case 'browser_open': {
        const url = str('url')
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'browser_open needs an http or https address.' }
        const account = whatsappAccount(str('account'))
        if (account === null) return { ok: false, error: `"${str('account')}" cannot be a WhatsApp account name. Use letters, digits and dashes, like india.` }
        const wa = isWhatsApp(url)
        if (account && !wa) return { ok: false, error: 'account is only for https://web.whatsapp.com. Leave it out for other addresses.' }
        const r = await step(owner, 'url', url, url, account)
        onOpened(owner, 'url' in r ? r.url : url)
        const reply = describe(r)
        if (!wa || !reply.ok) return reply
        const line = `WhatsApp account on screen: ${account || 'main'}. Accounts on this computer: ${whatsappAccounts(userData).join(', ')}.`
        return { ...reply, text: `${reply.text}\n\n${line}` }
      }
      case 'browser_read':
        return (await shown(owner)) ? describe(await step(owner, 'read')) : notOpen()
      case 'browser_click':
        return (await shown(owner)) ? after(owner, await step(owner, 'click', str('target'))) : notOpen()
      case 'browser_type': {
        if (!(await shown(owner))) return notOpen()
        const r = await step(owner, 'type', `${str('target')}|${String(args.text ?? '')}`)
        if ('refused' in r && r.refused === 'missing') return { ok: false, error: `No field named "${str('target')}" on this page. browser_type only types into lines marked "field" in browser_read.` }
        return after(owner, r)
      }
      case 'browser_key': {
        const key = keyName(str('key'))
        if (!key) return { ok: false, error: `No key named "${str('key')}". Use Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, or Space.` }
        return (await shown(owner)) ? after(owner, await step(owner, 'key', key)) : notOpen()
      }
      case 'browser_scroll':
        return (await shown(owner)) ? describe(await step(owner, 'scroll', str('direction') === 'up' ? 'up' : 'down')) : notOpen()
      case 'browser_screenshot': {
        const image = await browser.picture(owner)
        return image ? { ok: true, text: 'The page as the person sees it in the thread.', image } : notOpen()
      }
      case 'whatsapp_send': {
        const account = whatsappAccount(str('account'))
        if (account === null) return { ok: false, error: `"${str('account')}" cannot be a WhatsApp account name. Use letters, digits and dashes, like india.` }
        const to = str('to')
        const text = String(args.text ?? '').trim()
        if (!to || !text) return { ok: false, error: 'whatsapp_send needs who it goes to (to) and the message (text).' }
        if (text.length > 4000) return { ok: false, error: 'That message is over 4,000 characters. Make it shorter.' }
        const id = randomBytes(12).toString('hex')
        cards.set(id, { owner, account, to, text, state: 'waiting' })
        onSendAsk({ owner, id, account: account || 'main', to, text })
        return {
          ok: true,
          text: `A Send card for WhatsApp (${account || 'main'}) to ${to} is in this chat. Nothing is sent until the person presses Send on it. The card shows what happened.`
        }
      }
      case 'browser_close': {
        // A pop-up on top closes first; the page under it comes back and the session goes on.
        if (await browser.closeTop?.(owner)) return { ok: true, text: 'Closed the pop-up. The page under it is back; call browser_read.' }
        const id = sessions.get(owner)
        sessions.delete(owner)
        if (id) browser.release(id)
        await browser.closeOwner?.(owner)
        return { ok: true, text: 'Closed. WhatsApp windows stay open.' }
      }
      default:
        return { ok: false, error: `No tool named ${tool}.` }
    }
  }

  /** This chat has a page showing, however it was opened (a tool, a bare address it sent, or a page it already had). */
  async function shown(owner: string) {
    return (await browser.look?.(owner)) != null
  }
  function notOpen(): BridgeReply {
    return { ok: false, error: 'No page is open in this chat. Use browser_open first.' }
  }
  function after(owner: string, r: BrowseStepResult): BridgeReply {
    onOpened(owner, 'url' in r ? r.url : undefined)
    return describe(r)
  }

  return {
    answerSend,
    async call(owner: string, tool: string, args: Record<string, unknown>): Promise<BridgeReply> {
      try {
        return await within(run(owner, tool, args), CALL_MS)
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    }
  }
}

function serve(sock: Socket, token: string, tools: ReturnType<typeof makeBrowserTools>) {
  let buf = ''
  sock.on('data', (d) => {
    buf += d
    const n = buf.indexOf('\n')
    if (n < 0) return
    const line = buf.slice(0, n)
    buf = ''
    let call: BridgeCall
    try {
      call = JSON.parse(line) as BridgeCall
    } catch {
      sock.end(JSON.stringify({ ok: false, error: 'Bad request.' }) + '\n')
      return
    }
    const owner = String(call.owner || '')
    if (call.token !== token || !/^(chat|desk):\S+$/.test(owner)) {
      sock.end(JSON.stringify({ ok: false, error: 'Not allowed.' }) + '\n')
      return
    }
    const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : {}
    void tools.call(owner, String(call.tool || ''), args).then((reply) => {
      if (!sock.destroyed) sock.end(JSON.stringify(reply) + '\n')
    })
  })
  sock.on('error', () => {})
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/** Removes sockets and Claude config files left by Brain runs that are gone. A live run's stay. */
function sweep(dir: string) {
  for (const name of readdirSync(dir)) {
    const m = /^browser-(\d+)\.sock$/.exec(name)
    if (m && Number(m[1]) !== process.pid && gone(Number(m[1]))) rmSync(join(dir, name), { force: true })
  }
  const configs = join(dir, 'browser-mcp')
  if (!existsSync(configs)) return
  for (const name of readdirSync(configs)) {
    const m = /^(\d+)-/.exec(name)
    if (m && Number(m[1]) !== process.pid && gone(Number(m[1]))) rmSync(join(configs, name), { force: true })
  }
}

export function startBrowserBridge(opts: {
  dir: string
  script: string
  exec: string
  browser: DeskBrowser
  onOpened: (owner: string, url?: string) => void
  onSendAsk?: (ask: SendAsk) => void
  platform?: NodeJS.Platform
}): Promise<{ sock: string; token: string }> {
  if (running) return Promise.resolve({ sock: running.sock, token: running.token })
  const pipe = (opts.platform ?? process.platform) === 'win32'
  const sock = socketPath(opts.platform ?? process.platform, opts.dir, process.pid)
  if (!pipe) {
    sweep(opts.dir)
    if (existsSync(sock)) rmSync(sock, { force: true })
  }
  const token = randomBytes(24).toString('hex')
  const tools = makeBrowserTools(opts.browser, opts.onOpened, opts.dir, opts.onSendAsk)
  const server = createServer({ allowHalfOpen: true }, (s) => serve(s, token, tools))
  // Set before listening so a chat that starts in the next moment already gets the server.
  running = { server, dir: opts.dir, sock, pipe, token, script: opts.script, exec: opts.exec, tools }
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (running?.server === server) running = null
      reject(e)
    })
    server.listen(sock, () => {
      // Brain's userData folder is already 0700. The socket itself is owner-only too.
      if (!pipe) chmodSync(sock, 0o600)
      resolve({ sock, token })
    })
  })
}

/** The person pressed Send or Don't send on a card in that chat. */
export function answerSend(id: string, yes: boolean, owner: string): Promise<SendAnswer> {
  return running ? running.tools.answerSend(String(id || ''), !!yes, String(owner || '')) : Promise.resolve({ refused: true })
}

/** What the running bridge actually listens on. */
export function bridgeAddress(): string | null {
  const at = running?.server.address()
  return typeof at === 'string' ? at : null
}

export function stopBrowserBridge(): void {
  if (!running) return
  const { server, sock, dir, pipe } = running
  running = null
  server.close()
  if (!pipe) rmSync(sock, { force: true })
  const configs = join(dir, 'browser-mcp')
  if (existsSync(configs)) for (const name of readdirSync(configs)) if (name.startsWith(`${process.pid}-`)) rmSync(join(configs, name), { force: true })
}

/** The stdio MCP server for one chat. null when the bridge is not running, so the CLI starts without it. */
export function browserServer(owner: string): ServerSpec | null {
  if (!running) return null
  return serverSpec({ exec: running.exec, script: running.script, sock: running.sock, token: running.token, owner })
}

/** Claude: the server added beside Joe's own MCP servers, and his Chrome's control tools taken away.
 * The config (it holds the token) goes in an owner-only file, so the token is never on a command line. */
export function claudeBrowserArgs(owner: string): string[] {
  const s = browserServer(owner)
  if (!s || !running) return []
  const dir = join(running.dir, 'browser-mcp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${process.pid}-${owner.replace(/[^\w.-]/g, '_')}.json`)
  writeFileSync(file, JSON.stringify({ mcpServers: { [s.name]: { command: s.command, args: s.args, env: s.env } } }), { mode: 0o600 })
  chmodSync(file, 0o600)
  return ['--mcp-config', file, '--disallowedTools', 'mcp__control-chrome']
}

/** Grok and Cursor ACP `session/new` and `session/load`. */
export function acpBrowserServers(owner: string): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  const s = browserServer(owner)
  if (!s) return []
  return [{ name: s.name, command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }]
}

/** Codex `thread/start` and `thread/resume` config. */
export function codexBrowserConfig(owner: string): Record<string, unknown> | undefined {
  const s = browserServer(owner)
  if (!s) return undefined
  return { mcp_servers: { brain_browser: { command: s.command, args: s.args, env: s.env } } }
}
