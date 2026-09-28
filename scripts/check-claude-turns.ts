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


type Sent = { tabId: string; kind: string; data?: string; busy?: boolean }
const sent: Sent[] = []
const src = (rel: string) => pathToFileURL(join(rootRepo, 'src', 'main', rel)).href
const fan = (await import(src('chat-fan.ts'))) as typeof import('../src/main/chat-fan.ts')
;(globalThis as { __brainWindows?: unknown }).__brainWindows = [
  { isDestroyed: () => false, webContents: { send: (_ch: string, p: Sent) => sent.push({ ...p, busy: fan.isChatBusy(p.tabId) }) } }
]
const cs = (await import(src('claude-stream.ts'))) as typeof import('../src/main/claude-stream.ts')

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail })
  console.error(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`)
}
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

// Like chat:send in ipc-stubs: a prompt's events go to the chat through emitChat.
const appEvent = (ev: { kind: string; data?: string }) => fan.emitChat({ tabId, cli: 'claude', ev: ev as never })
const bgStart = (tag: string, secs: number) =>
  cs.claudePrompt({
    ...base,
    text: `Use the Bash tool with run_in_background set to true to run exactly: sleep ${secs} && echo ${tag} . Then say "started" and end your turn. When you are told it finished, read its output and reply with the line it printed.`,
    onEvent: appEvent
  })
const autoWith = (from: number, tag: string) => {
  const at = sent.findIndex((p, i) => i >= from && p.tabId === tabId && p.data === 'turn:auto')
  if (at < 0) return { at, text: '', closed: false }
  const rest = sent.slice(at)
  const end = rest.findIndex((p) => p.tabId === tabId && (p.kind === 'done' || p.data === 'turn:auto-done'))
  const text = rest.slice(0, end < 0 ? undefined : end).filter((p) => p.kind === 'text').map((p) => p.data).join('')
  return { at, text, closed: end >= 0 && text.includes(tag) }
}

console.error('[live] starting 4a')
// 4a. Send while a background task still runs: the prompt gets its own answer, the wake turn comes after.
{
  const from = sent.length
  await bgStart('BGDONE-4A', 14)
  const b = await cs.claudePrompt({ ...base, text: 'Reply with exactly the word BANANA and nothing else.', onEvent: appEvent })
  for (let i = 0; i < 600 && !autoWith(from, 'BGDONE-4A').closed; i++) await wait(100)
  const w = autoWith(from, 'BGDONE-4A')
  const shown = sent.slice(from).filter((p) => p.tabId === tabId && p.kind === 'text').map((p) => p.data).join('')
  check('4a a prompt sent while background work runs gets its own answer; the task result still reaches the chat', /BANANA/.test(b) && (w.closed || /BGDONE-4A/.test(b)) && shown.includes('BGDONE-4A'), JSON.stringify({ b: b.slice(0, 80), w }))
}

console.error('[live] starting 4b')
// 4b. The background task finishes during a longer prompt: that prompt keeps its answer; the wake comes after.
{
  const from = sent.length
  await bgStart('BGDONE-4B', 6)
  const b = await cs.claudePrompt({ ...base, text: 'Count from 1 to 120, one number per line, then write DONE-COUNT on the last line.', onEvent: appEvent })
  for (let i = 0; i < 600 && !autoWith(from, 'BGDONE-4B').closed; i++) await wait(100)
  const w = autoWith(from, 'BGDONE-4B')
  const shown = sent.slice(from).filter((p) => p.tabId === tabId && p.kind === 'text').map((p) => p.data).join('')
  // Claude may fold the finished task into the running reply or answer it in its own turn; either way nothing is lost.
  check('4b a task that finishes during a prompt: the prompt keeps its answer and the task result still shows', /DONE-COUNT/.test(b) && (w.closed || /BGDONE-4B/.test(b)) && shown.includes('BGDONE-4B'), JSON.stringify({ tail: b.slice(-60), w }))
}

console.error('[live] starting 4c')
// 4c. Send during Claude's own wake turn: the wake closes with turn:auto-done (tab stays busy), then the prompt answers.
{
  const from = sent.length
  // Let the earlier cases' turns finish first, so the only turn:auto after this point is 4C's.
  await wait(3000)
  await bgStart('BGDONE-4C', 5)
  const mark = sent.length
  const wakeOpen = () => sent.some((p, k) => k >= mark && p.tabId === tabId && p.data === 'turn:auto')
  for (let i = 0; i < 600 && !wakeOpen(); i++) await wait(50)
  const c = await cs.claudePrompt({ ...base, text: 'Reply with exactly the word KIWI and nothing else.', onEvent: appEvent })
  const shownC = () => sent.slice(mark).filter((p) => p.tabId === tabId && p.kind === 'text').map((p) => p.data).join('')
  for (let i = 0; i < 300 && !shownC().includes('BGDONE-4C'); i++) await wait(100)
  const late = sent.slice(from).filter((p) => p.tabId === tabId && (p.data === 'turn:auto-done' || (p.kind === 'done' && sent.slice(from).some((q) => q.data === 'turn:auto'))))
  const autoDone = sent.slice(from).find((p) => p.tabId === tabId && p.data === 'turn:auto-done')
  const w = autoWith(from, 'BGDONE-4C')
  check(
    '4c a prompt sent during Claude\'s own turn: no hang, the tab stays busy until one done, the prompt is answered in the chat',
    (() => {
      const trail = sent.slice(mark).filter((p) => p.tabId === tabId && p.kind !== 'thought')
      const doneAt = trail.findIndex((p) => p.kind === 'done')
      // Claude may fold the new message into its own turn and answer only that: what it says is its call.
      // What the app owns: no hang, the tab busy from turn:auto until one done, the prompt answered in the chat.
      return wakeOpen() && /KIWI/.test(c) && shownC().includes('KIWI') && doneAt >= 0 && trail.filter((p) => p.kind === 'done').length === 1 &&
        trail.slice(trail.findIndex((p) => p.data === 'turn:auto'), doneAt).every((p) => p.busy === true) && (!autoDone || autoDone.busy === true)
    })(),
    JSON.stringify({ c: c.slice(0, 60), wake: wakeOpen(), shown: shownC().slice(0, 200), autoDone, trail: sent.slice(mark).filter((p) => p.tabId === tabId && p.kind !== 'thought').map((p) => `${p.kind}:${String(p.data || '').slice(0, 30)}:${p.busy ? 'B' : '-'}`).slice(0, 40) })
  )
}

cs.claudeKillAll()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
console.log(results.every((r) => r.ok) ? '\nCLAUDE_TURNS_PASS' : '\nCLAUDE_TURNS_FAIL')
process.exit(results.every((r) => r.ok) ? 0 : 1)
