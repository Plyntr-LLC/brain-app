import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { BrowseStepResult, DeskBrowser } from '../shared/desk.ts'
import { keyName } from './desk/browser.ts'

/**
 * Lets a chat CLI drive the browser inside Brain. Brain listens on a socket in its userData; the CLI runs
 * browser-mcp.cjs with this run's socket, token, and the chat's owner (`chat:<tabId>`) in its env.
 * Every call lands on the same desk engine the Desk bots and the thread picture use.
 */

export type BridgeCall = { token?: unknown; owner?: unknown; tool?: unknown; args?: unknown }
export type BridgeReply = { ok: true; text: string; image?: string } | { ok: false; error: string }
export type ServerSpec = { name: string; command: string; args: string[]; env: Record<string, string> }

const SERVER = 'brain-browser'
const CALL_MS = 40_000

type Running = { server: Server; dir: string; sock: string; pipe: boolean; token: string; script: string; exec: string }

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
    return { ok: true, text: `Page: ${r.title || '(no title)'}\nURL: ${r.url}\n\nControls (use the number or the name):\n${controls}\n\nText:\n${r.text}` }
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
  if ('refused' in r && r.refused === 'pay') {
    return { ok: false, error: `Not pressed: "${r.name ?? ''}" sends or publishes. Ask the person. They can click it themselves in the browser picture in this thread.` }
  }
  if ('refused' in r) {
    if (r.refused === 'ambiguous') return { ok: false, error: `More than one control is named "${r.name}". Use its number from browser_read.` }
    if (r.refused === 'page-changed') return { ok: false, error: `The page moved on (${r.url}). Call browser_read.` }
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

/** The tool calls for one browser. Exported so the check drives the same code the socket does. */
export function makeBrowserTools(browser: DeskBrowser, onOpened: (owner: string, url?: string) => void) {
  const sessions = new Map<string, string>()
  let n = 0

  async function session(owner: string): Promise<string> {
    const have = sessions.get(owner)
    if (have) return have
    const id = `mcp:${owner}:${++n}`
    await browser.open(id, owner)
    sessions.set(owner, id)
    return id
  }

  async function step(owner: string, action: string, detail = '', url?: string): Promise<BrowseStepResult> {
    for (let tries = 1; ; tries++) {
      const fresh = !sessions.has(owner)
      const id = await session(owner)
      try {
        // A new session (after a sign-in, or a Brain restart) has no page list yet. Read the shown page first.
        if (fresh && action !== 'url' && action !== 'read') {
          const looked = await browser.runStep(id, { action: 'read' })
          if (!('ok' in looked)) return looked
        }
        const r = await browser.runStep(id, { action, detail, url })
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
        const r = await step(owner, 'url', url, url)
        onOpened(owner, 'url' in r ? r.url : url)
        return describe(r)
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
      case 'browser_close': {
        const id = sessions.get(owner)
        sessions.delete(owner)
        if (id) browser.release(id)
        await browser.closeOwner?.(owner)
        return { ok: true, text: 'Closed. The shared WhatsApp window, if open, stays open.' }
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
  const tools = makeBrowserTools(opts.browser, opts.onOpened)
  const server = createServer({ allowHalfOpen: true }, (s) => serve(s, token, tools))
  // Set before listening so a chat that starts in the next moment already gets the server.
  running = { server, dir: opts.dir, sock, pipe, token, script: opts.script, exec: opts.exec }
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
