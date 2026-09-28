import { createRequire, registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Live check (costs a few cents): drives the app's real claude-stream module against the real
// `claude` CLI on haiku. Proves (1) Send now after an interrupt gets the new answer, not a dead stop;
// (2) a background task Claude hears back about shows as its own live turn in the chat, with the
// background strip on while it runs and off after; (3) the next prompt after that still answers.
// Prints CLAUDE_TURNS_PASS only if every check passes.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}
const userData = mkdtempSync(join(tmpdir(), 'brain-claude-turns-'))
;(globalThis as { __userData?: string }).__userData = userData
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


type Sent = { tabId: string; kind: string; data?: string }
const sent: Sent[] = []
;(globalThis as { __brainWindows?: unknown }).__brainWindows = [
  { isDestroyed: () => false, webContents: { send: (_ch: string, p: Sent) => sent.push(p) } }
]
const src = (rel: string) => pathToFileURL(join(rootRepo, 'src', 'main', rel)).href
const cs = (await import(src('claude-stream.ts'))) as typeof import('../src/main/claude-stream.ts')

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })
const cwd = mkdtempSync(join(tmpdir(), 'brain-claude-cwd-'))
const tabId = 'check-claude-turns'
const base = { tabId, cwd, model: 'haiku', effort: 'low' }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 1. Interrupt, then Send now.
{
  const aEvents: string[] = []
  const bEvents: string[] = []
  const a = cs.claudePrompt({ ...base, text: 'Count slowly from 1 to 400, one number per line. Do not stop early.', onEvent: (ev) => aEvents.push(ev.kind + ':' + (ev.data || '')) })
  for (let i = 0; i < 300 && !aEvents.some((e) => e.startsWith('text:')); i++) await wait(100)
  await wait(1500)
  // What the chat does: Stop (chat:stop -> claudeCancel), then the queued note as a new prompt.
  cs.claudeCancel(tabId)
  const aText = await a
  const b = await cs.claudePrompt({ ...base, text: 'Reply with exactly the word BANANA and nothing else.', onEvent: (ev) => bEvents.push(ev.kind + ':' + (ev.data || '')) })
  check('1 the prompt sent right after an interrupt gets its own answer (not a dead stop)', /BANANA/.test(b) && bEvents.some((e) => e.startsWith('text:') && e.includes('BANANA')) && bEvents[bEvents.length - 1] === 'done:', JSON.stringify({ b, tail: bEvents.slice(-4) }))
  check('1 the interrupted count never leaks into the new answer', !/\b(?:37|38|39)\d\b/.test(b) && !bEvents.some((e) => /^text:\s*\d+\s*$/.test(e)), JSON.stringify({ b: b.slice(0, 200) }))
  check('1 the interrupted prompt settled', typeof aText === 'string', String(aText).slice(0, 80))
}

// 2. Background task: Claude starts it, ends its turn, then hears back and answers on its own.
{
  const from = sent.length
  const reply = await cs.claudePrompt({
    ...base,
    text: 'Use the Bash tool with run_in_background set to true to run exactly: sleep 12 && echo BGDONE-7731 . Then say "started" and end your turn. When you are told it finished, read its output and reply with the line it printed.',
    onEvent: () => {}
  })
  const bgOn = () => sent.slice(from).some((p) => p.tabId === tabId && p.kind === 'status' && p.data?.startsWith('bg:') && p.data !== 'bg:[]')
  for (let i = 0; i < 100 && !bgOn(); i++) await wait(100)
  check('2 the background strip gets the running task', bgOn(), JSON.stringify(sent.slice(from).filter((p) => p.data?.startsWith('bg:')).map((p) => p.data)))
  const autoDone = () => {
    const at = sent.findIndex((p, i) => i >= from && p.tabId === tabId && p.data === 'turn:auto')
    return at >= 0 && sent.slice(at).some((p) => p.tabId === tabId && p.kind === 'done')
  }
  for (let i = 0; i < 600 && !autoDone(); i++) await wait(100)
  const at = sent.findIndex((p, i) => i >= from && p.tabId === tabId && p.data === 'turn:auto')
  const autoText = sent.slice(Math.max(at, 0)).filter((p) => p.tabId === tabId && p.kind === 'text').map((p) => p.data).join('')
  check('2 the first reply ends normally', /start/i.test(reply), reply.slice(0, 120))
  check('2 Claude\'s own follow-up turn reaches the chat: turn:auto, its text, then done', at >= 0 && /BGDONE-7731/.test(autoText) && autoDone(), JSON.stringify({ at, autoText: autoText.slice(0, 160) }))
  const lastBg = sent.slice(from).filter((p) => p.tabId === tabId && p.data?.startsWith('bg:')).pop()?.data
  check('2 the background strip clears when the task ends', lastBg === 'bg:[]', String(lastBg))
}

// 3. A normal prompt after the self-started turn still answers.
{
  const c = await cs.claudePrompt({ ...base, text: 'Reply with exactly the word KIWI and nothing else.', onEvent: () => {} })
  check('3 the next prompt after a self-started turn still answers', /KIWI/.test(c), c.slice(0, 80))
}

cs.claudeKillAll()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
console.log(results.every((r) => r.ok) ? '\nCLAUDE_TURNS_PASS' : '\nCLAUDE_TURNS_FAIL')
process.exit(results.every((r) => r.ok) ? 0 : 1)
