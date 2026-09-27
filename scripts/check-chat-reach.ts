import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Chat reach gate. Drives the real Claude, Codex, Cursor ACP and PTY spawn paths against fake CLI
// binaries that only record argv, env and JSON-RPC params. No live CLI. Prints CHAT_REACH_PASS only
// if Chat, Skin and Show terminal get Terminal reach and Factory stays gated.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

const temp = mkdtempSync(join(tmpdir(), 'brain-reach-'))
const userData = join(temp, 'userData')
const home = join(temp, 'home')
const brain = join(temp, 'brain')
const bin = join(home, '.local', 'bin')
const log = join(temp, 'calls.jsonl')
for (const d of [userData, home, brain, bin]) mkdirSync(d, { recursive: true })
;(globalThis as { __userData?: string }).__userData = userData
;(globalThis as { __handlers?: Record<string, unknown> }).__handlers = {}
;(globalThis as { __ptySpawns?: unknown[] }).__ptySpawns = []

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'node-pty') return { url: 'stub:node-pty', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getVersion: () => '0.0.0', getPath: () => globalThis.__userData, isPackaged: false }
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
export const ipcMain = { handle(ch, fn) { globalThis.__handlers[ch] = fn }, on() {} }
export const clipboard = {}, dialog = {}, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow, ipcMain }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url === 'stub:node-pty') {
      const source = `const spawn = (file, args, opts) => { globalThis.__ptySpawns.push({ file, args, env: opts.env, cwd: opts.cwd }); return { onData() {}, onExit() {}, kill() {}, resize() {}, write() {} } }
export default { spawn }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})

// Fake CLI: logs argv, cwd and the four project-dir vars, then answers every JSON-RPC request with a
// generic result and logs its method and params. Never prints a token (there are none).
const fake = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const name = path.basename(process.argv[1])
const keys = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'GROK_WORKSPACE_ROOT', 'CODEX_PROJECT_DIR']
const env = {}; for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k]
const put = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, ...o }) + '\\n')
put({ argv: process.argv.slice(2), env, cwd: process.cwd() })
let buf = ''
process.stdin.on('data', (d) => {
  buf += d; let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method) put({ method: m.method, params: m.params })
    if (m.id !== undefined && m.method) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', thread: { id: 't1' }, data: [], models: [], protocolVersion: 1 } }) + '\\n')
  }
})
setTimeout(() => process.exit(0), 8000)
`
for (const n of ['claude', 'cursor-agent', 'codex', 'grok']) {
  writeFileSync(join(bin, n), fake)
  chmodSync(join(bin, n), 0o755)
}

process.env.HOME = home
process.env.PATH = `${bin}:${process.env.PATH || ''}`
// A parent that already pins these (for example Brain launched from a Claude Code shell) must not leak.
process.env.CLAUDE_PROJECT_DIR = '/leak'
process.env.CURSOR_PROJECT_DIR = '/leak'
process.env.GROK_WORKSPACE_ROOT = '/leak'
process.env.CODEX_PROJECT_DIR = '/leak'
delete process.env.BRAIN_APP_DRY_RUN

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', p)).href
const reach = (await import(src('shared/chat-reach.ts'))) as typeof import('../src/shared/chat-reach.ts')
const aiCli = (await import(src('main/ai-cli.ts'))) as typeof import('../src/main/ai-cli.ts')
const acp = (await import(src('main/acp-session.ts'))) as typeof import('../src/main/acp-session.ts')
const claude = (await import(src('main/claude-stream.ts'))) as typeof import('../src/main/claude-stream.ts')
const codex = (await import(src('main/codex-app.ts'))) as typeof import('../src/main/codex-app.ts')
const ptyMod = (await import(src('main/pty.ts'))) as typeof import('../src/main/pty.ts')
const gargs = (await import(src('main/grok-args.ts'))) as typeof import('../src/main/grok-args.ts')
const gates = (await import(src('main/factory/gates.ts'))) as typeof import('../src/main/factory/gates.ts')

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })
type Call = { name: string; argv?: string[]; env?: Record<string, string>; method?: string; params?: Record<string, unknown> }
const calls = (): Call[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call) : [])
async function waitFor(pred: () => Call | undefined, ms = 5000): Promise<Call | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = pred()
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}
const noPin = (env: Record<string, string | undefined> | undefined) => reach.PROJECT_DIR_ENV.every((k) => env?.[k] === undefined)
const pair = (argv: string[] | undefined, flag: string, value: string) => {
  const i = (argv || []).indexOf(flag)
  return i >= 0 && argv![i + 1] === value
}

// Rules
{
  check('rules say Terminal reach, not folder-only', /anywhere this Mac's signed-in user can/.test(reach.CHAT_RULES) && !/in this folder/.test(reach.CHAT_RULES))
  check('rules keep Ads, mail and no tool-name dumps', /Google Ads unless the human clearly said yes/.test(reach.CHAT_RULES) && /external mail unless they said send/.test(reach.CHAT_RULES) && /Do not dump tool names/.test(reach.CHAT_RULES))
  const tw = readFileSync(join(rootRepo, 'src/renderer/src/TerminalWorkspace.tsx'), 'utf8')
  check('renderer has no folder-only rules or /permissions copy', !/You may read and edit files in this folder/.test(tw) && !/Writes outside this folder are blocked/.test(tw))
  for (const f of ['main/acp-session.ts', 'main/claude-stream.ts', 'main/codex-app.ts']) {
    check(`${f} has no folder-only rules`, !/You may read and edit files in this folder/.test(readFileSync(join(rootRepo, 'src', f), 'utf8')))
  }
}

// Env
{
  check('binEnv never pins a folder, even if the parent did', noPin(aiCli.binEnv()))
  check('ptyEnv never pins a folder', noPin(ptyMod.ptyEnv()))
  const proj = aiCli.projectBinEnv(brain)
  check('projectBinEnv (Factory, hook scripts) still pins the folder', reach.PROJECT_DIR_ENV.every((k) => proj[k] === brain))
  const fenv = gates.factoryEnv(aiCli.projectBinEnv(brain), join(temp, 'shims'))
  check('Factory env keeps shims first and pins the brain', String(fenv.PATH).startsWith(join(temp, 'shims')) && fenv.CLAUDE_PROJECT_DIR === brain)
}

// Claude warm session
{
  await claude.claudeWarm({ tabId: 'c1', cwd: brain })
  const c = await waitFor(() => calls().find((x) => x.name === 'claude' && x.argv))
  check('Claude spawned against fake bin', Boolean(c))
  check('Claude Chat is bypassPermissions', pair(c?.argv, '--permission-mode', 'bypassPermissions'), JSON.stringify(c?.argv))
  check('Claude Chat has --allow-dangerously-skip-permissions', Boolean(c?.argv?.includes('--allow-dangerously-skip-permissions')))
  check('Claude Chat never dontAsk', !c?.argv?.includes('dontAsk'))
  check('Claude Chat rules are Terminal reach', pair(c?.argv, '--append-system-prompt', reach.CHAT_RULES))
  check('Claude Chat env is not pinned', noPin(c?.env))
  check('Claude plan tab stays plan', pair(reach.claudeChatPermissionArgs(true), '--permission-mode', 'plan') && reach.claudeChatMode(false) === 'bypassPermissions')
  claude.claudeKillAll()
}

// Codex app-server
{
  await codex.codexWarm({ tabId: 'x1', cwd: brain }).catch(() => undefined)
  const spawnC = await waitFor(() => calls().find((x) => x.name === 'codex' && x.argv))
  const start = await waitFor(() => calls().find((x) => x.name === 'codex' && x.method === 'thread/start'))
  check('Codex thread/start sandbox is danger-full-access', start?.params?.sandbox === 'danger-full-access', JSON.stringify(start?.params))
  check('Codex developerInstructions are Terminal reach', start?.params?.developerInstructions === reach.CHAT_RULES)
  check('Codex env is not pinned', noPin(spawnC?.env))
  codex.codexKillAll()
  await codex.codexWarm({ tabId: 'x2', cwd: brain, resumeId: 'old-thread' }).catch(() => undefined)
  const resume = await waitFor(() => calls().find((x) => x.name === 'codex' && x.method === 'thread/resume'))
  const rp = resume?.params
  check('Codex thread/resume sandbox is danger-full-access', rp?.sandbox === 'danger-full-access', JSON.stringify(rp))
  check('Codex thread/resume approvalPolicy is never', rp?.approvalPolicy === 'never')
  check('Codex thread/resume developerInstructions are Terminal reach', rp?.developerInstructions === reach.CHAT_RULES)
  check('Codex thread/resume cwd and threadId', rp?.cwd === brain && rp?.threadId === 'old-thread')
  codex.codexKillAll()
}

// Cursor ACP
{
  await Promise.race([acp.acpWarm({ kind: 'cursor', tabId: 'u1', cwd: brain }).catch(() => undefined), new Promise((r) => setTimeout(r, 4000))])
  const u = await waitFor(() => calls().find((x) => x.name === 'cursor-agent' && x.argv))
  check('Cursor ACP keeps --workspace cwd', pair(u?.argv, '--workspace', brain), JSON.stringify(u?.argv))
  check('Cursor ACP --sandbox disabled', pair(u?.argv, '--sandbox', 'disabled'))
  check('Cursor ACP --add-dir home', pair(u?.argv, '--add-dir', home))
  check('Cursor ACP ends in acp', u?.argv?.at(-1) === 'acp')
  check('Cursor ACP env is not pinned', noPin(u?.env))
  acp.acpKillAll()
}

// Grok Chat and Factory args
{
  const g = gargs.grokAcpArgs(brain, true)
  check('Grok Chat keeps --always-approve, no --deny', g.includes('--always-approve') && !g.includes('--deny'))
  const t = gargs.grokTuiArgs(brain, undefined, true)
  check('Grok Show terminal keeps --always-approve, no --deny', t.includes('--always-approve') && !t.includes('--deny'))
  const f = gargs.grokFactoryAcpArgs(brain, true)
  check('Factory Grok has no --always-approve', !f.includes('--always-approve'))
  check('Factory session/new has no yoloMode', !JSON.stringify(acp.sessionNewParams('grok', brain, 'factory')).includes('yoloMode'))
  check('Chat Grok session/new rules are Terminal reach', (acp.sessionNewParams('grok', brain)._meta as { rules?: string }).rules === reach.CHAT_RULES)
}

// PTY: Show terminal Cursor, and the login shell
{
  const h = (globalThis as { __handlers: Record<string, (...a: unknown[]) => Promise<unknown>> }).__handlers
  ptyMod.registerPtyIpc()
  const sender = { isDestroyed: () => false, send() {} }
  const spawns = (globalThis as { __ptySpawns: { file: string; args: string[]; env: Record<string, string> }[] }).__ptySpawns
  await h['pty:create']({ sender }, { id: 'p1', cwd: brain, cols: 80, rows: 24, kind: 'cursor' })
  const sc = spawns.at(-1)
  check('Show terminal Cursor keeps --workspace cwd', pair(sc?.args, '--workspace', brain), JSON.stringify(sc?.args))
  check('Show terminal Cursor --sandbox disabled and --add-dir home', pair(sc?.args, '--sandbox', 'disabled') && pair(sc?.args, '--add-dir', home))
  check('Show terminal env is not pinned', noPin(sc?.env))
  await h['pty:create']({ sender }, { id: 'p2', cwd: brain, cols: 80, rows: 24, shell: true })
  const sh = spawns.at(-1)
  check('login Terminal is a -l shell with the same unpinned env', Boolean(sh?.args.includes('-l')) && noPin(sh?.env))
  await h['pty:create']({ sender }, { id: 'p3', cwd: brain, cols: 80, rows: 24, kind: 'claude' })
  check('Show terminal Claude env is not pinned', noPin(spawns.at(-1)?.env))
}

// Guards that stay
{
  const acpSrc = readFileSync(join(rootRepo, 'src/main/acp-session.ts'), 'utf8')
  check('brainWriteBlock still guards Chat writes', /brainWriteBlock\(/.test(acpSrc))
  check('factoryWriteBlock still guards Factory writes', /factoryWriteBlock\(/.test(acpSrc))
  const filesSrc = readFileSync(join(rootRepo, 'src/main/files.ts'), 'utf8')
  check('files.ts explorer untouched by reach (no chat-reach import)', !/chat-reach/.test(filesSrc))
}

const pass = results.every((r) => r.ok)
const out = [...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`), '', pass ? 'CHAT_REACH_PASS' : 'CHAT_REACH_FAIL'].join('\n')
writeFileSync(join(temp, 'out.txt'), out)
console.log(out)
process.exit(pass ? 0 : 1)
