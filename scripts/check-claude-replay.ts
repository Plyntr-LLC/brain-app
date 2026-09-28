import { createRequire, registerHooks } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Deterministic replay (no model, no cost): a fake `claude` plays back the one interleaving live runs
// cannot force. Claude's own wake turn opens and ends before it takes the prompt we just wrote, and the
// wake's result carries origin task-notification. The prompt must end on its own answer.
// Prints CLAUDE_REPLAY_PASS only if every check passes.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}
const temp = mkdtempSync(join(tmpdir(), 'brain-claude-replay-'))
;(globalThis as { __userData?: string }).__userData = join(temp, 'userData')
mkdirSync(join(temp, 'userData'), { recursive: true })
process.env.HOME = join(temp, 'home')
const bin = join(temp, 'home', '.local', 'bin')
mkdirSync(bin, { recursive: true })
// The fake: on each user line, play the scripted events for that prompt word.
writeFileSync(
  join(bin, 'claude'),
  `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const text = (t) => out({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  const lines = buf.split('\\n')
  buf = lines.pop()
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (o.type !== 'user') continue
    const said = JSON.stringify(o.message.content)
    if (said.includes('MANGO')) {
      // Wake first: its own turn, no echo, origin on the result. Then the prompt's turn.
      out({ type: 'system', subtype: 'init' })
      text('BGDONE-R1')
      out({ type: 'result', subtype: 'success', result: 'BGDONE-R1', origin: { kind: 'task-notification' } })
      out({ type: 'system', subtype: 'init' })
      out({ type: 'user', isReplay: true, message: o.message })
      text('MANGO')
      out({ type: 'result', subtype: 'success', result: 'MANGO' })
    } else {
      out({ type: 'system', subtype: 'init' })
      out({ type: 'user', isReplay: true, message: o.message })
      text('OK')
      out({ type: 'result', subtype: 'success', result: 'OK' })
    }
  }
})
`
)
chmodSync(join(bin, 'claude'), 0o755)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
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
export const BrowserWindow = { getAllWindows: () => globalThis.__brainWindows || [], fromWebContents: () => null }
export const clipboard = {}, dialog = {}, ipcMain = { handle() {}, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})


type Sent = { tabId: string; kind: string; data?: string; busy?: boolean }
const sent: Sent[] = []
const src = (rel: string) => pathToFileURL(join(rootRepo, 'src', 'main', rel)).href
const fan = (await import(src('chat-fan.ts'))) as typeof import('../src/main/chat-fan.ts')
;(globalThis as { __brainWindows?: unknown }).__brainWindows = [
  { isDestroyed: () => false, webContents: { send: (_ch: string, p: Sent) => sent.push({ ...p, busy: fan.isChatBusy(p.tabId) }) } }
]
const cs = (await import(src('claude-stream.ts'))) as typeof import('../src/main/claude-stream.ts')
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })
const tabId = 'check-claude-replay'
const cwd = mkdtempSync(join(tmpdir(), 'brain-claude-replay-cwd-'))
const appEvent = (ev: { kind: string; data?: string }) => fan.emitChat({ tabId, cli: 'claude', ev: ev as never })
const base = { tabId, cwd, model: 'haiku', effort: 'low', onEvent: appEvent }

// A first prompt so the session is past its first turn (Claude's own turns only count after one).
const first = await cs.claudePrompt({ ...base, text: 'hello' })
check('R0 the fake answers a plain prompt', first === 'OK', first)
const mark = sent.length
fan.markChatBusy(tabId, true)
const got = await Promise.race([cs.claudePrompt({ ...base, text: 'Reply with MANGO' }), new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 5000))])
const trail = sent.slice(mark).filter((p) => p.tabId === tabId).map((p) => `${p.kind}:${p.data || ''}:${p.busy ? 'B' : '-'}`)
const autoAt = trail.findIndex((t) => t.startsWith('status:turn:auto:'))
const autoDoneAt = trail.findIndex((t) => t.startsWith('status:turn:auto-done'))
const doneAt = trail.findIndex((t) => t.startsWith('done:'))
check('R1 wake first: the prompt ends on its own answer (MANGO), not the wake result', got === 'MANGO', JSON.stringify({ got, trail }))
check(
  'R1 the wake shows as its own turn: turn:auto, its text, then turn:auto-done (tab still busy), then MANGO and one done',
  autoAt >= 0 && trail.slice(autoAt).some((t) => t.startsWith('text:BGDONE-R1')) && autoDoneAt > autoAt && trail[autoDoneAt].endsWith(':B') &&
    trail.slice(autoDoneAt).some((t) => t.startsWith('text:MANGO')) && doneAt > autoDoneAt && trail.filter((t) => t.startsWith('done:')).length === 1,
  JSON.stringify(trail)
)
cs.claudeKillAll()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
console.log(results.every((r) => r.ok) ? '\nCLAUDE_REPLAY_PASS' : '\nCLAUDE_REPLAY_FAIL')
process.exit(results.every((r) => r.ok) ? 0 : 1)
