import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Unit C live: Joe's finished run-5073ec51 (done, pushed) asked through the real Factory Grok ACP watcher
// (the run's -orch tab, watch-only). Joe's stores stay untouched: the run record is copied into a temp
// userData, its code store into a temp work repo's git dir, and the brain is a temp folder. The Grok
// leader is stubbed off so Grok runs --no-leader (the app's own fallback) and never touches the leader
// socket Joe's running Brain.app owns. Joe's Mac only; uses his Grok login.
// node --experimental-strip-types scripts/check-watcher-after-run.ts [artifact]

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const artifact = process.argv[2] || join(rootRepo, 'plans', '20261007-watcher-after-run.txt')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as { transformSync: (code: string, opts: Record<string, unknown>) => { code: string } }
const RUN = 'run-5073ec51-8df'
const realRun = join(homedir(), 'Library', 'Application Support', 'brain-app', 'factory', 'runs', `${RUN}.json`)
const realCode = join('/Users/joewine/Projects/lotline/.git/brain-factory', RUN)

// The watcher's grok would otherwise auto-update, and the update restarts the leaders of Joe's running Brain.app.
process.env.GROK_DISABLE_AUTOUPDATER = '1'
const temp = mkdtempSync(join(tmpdir(), 'brain-watcher-live-'))
const userData = join(temp, 'userData')
mkdirSync(join(userData, 'factory', 'runs'), { recursive: true })
;(globalThis as { __userData?: string }).__userData = userData
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130))

const grokArgs = pathToFileURL(join(rootRepo, 'src', 'main', 'grok-args.ts')).href
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (/(^|\/)grok-leader$/.test(spec)) return { url: 'stub:grok-leader', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getVersion: () => '0.0.0', getPath: () => globalThis.__userData, isPackaged: false }
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
export const clipboard = {}, dialog = {}, ipcMain = { handle() {}, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url === 'stub:grok-leader') {
      const source = `export { grokAcpArgs, grokFactoryAcpArgs, grokFactorySocket, grokLeaderSocket, grokTuiArgs } from '${grokArgs}'
const no = async () => false
export const ensureGrokLeader = no, ensureGrokFactoryLeader = no
export const grokLeaderLive = () => false, grokFactoryLeaderLive = () => false
export const killGrokLeader = () => {}, killGrokFactoryLeader = () => {}, setGrokFactoryLeaderEnv = () => {}
export function makeLeader() { return { ensure: no, live: () => false, kill() {} } }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      return { format: 'module', shortCircuit: true, source: esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code }
    }
    return next(url, ctx)
  }
})

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', p)).href
const acp = (await import(src('main/acp-session.ts'))) as typeof import('../src/main/acp-session.ts')
const ctl = (await import(src('main/factory/controller.ts'))) as typeof import('../src/main/factory/controller.ts')
const conductor = (await import(src('main/factory/conductor.ts'))) as typeof import('../src/main/factory/conductor.ts')
const store = (await import(src('main/factory/run-store.ts'))) as typeof import('../src/main/factory/run-store.ts')
const gates = (await import(src('main/factory/gates.ts'))) as typeof import('../src/main/factory/gates.ts')
const opus = (await import(src('main/factory/opus.ts'))) as typeof import('../src/main/factory/opus.ts')
const aicli = (await import(src('main/ai-cli.ts'))) as typeof import('../src/main/ai-cli.ts')
store.setUserDataDir(() => userData)

const work = join(temp, 'lotline-copy')
const brain = join(temp, 'brain')
mkdirSync(work)
mkdirSync(brain)
writeFileSync(join(brain, 'AGENTS.md'), '# Probe brain\n')
const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Watcher Live', '-c', 'user.email=watcher@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(['init', '-q', '-b', 'main'])
writeFileSync(join(work, 'README.md'), '# A copy of the lotline run store for the watcher check\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'init'])
cpSync(realCode, join(work, '.git', 'brain-factory', RUN), { recursive: true })
const record = JSON.parse(readFileSync(realRun, 'utf8')) as Record<string, unknown>
writeFileSync(join(userData, 'factory', 'runs', `${RUN}.json`), JSON.stringify({ ...record, workRepo: work, brainPath: brain, repos: [{ repo: work, base: record.base }] }, null, 2))

ctl.configureFactory({
  driver: {
    warm: (o) => acp.factoryWarm(o),
    prompt: (o) => acp.factoryPrompt(o),
    cancel: (tabId) => void acp.factoryCancel(tabId),
    close: (tabId) => acp.factoryClose(tabId),
    setEffort: (tabId, effort) => acp.factorySetEffort(tabId, effort),
    info: (tabId) => acp.factoryInfo(tabId)
  },
  emit: () => {},
  env: (repo) => opus.opusEnv(gates.factoryEnv(aicli.projectBinEnv(repo), gates.ensureShims(store.factoryShimDir()))),
  projectsDir: join(temp, 'projects')
})

const before = ctl.getRun(RUN)
if (!before) throw new Error('the copied run did not load')
const files = (before.audit?.work || []).map((w) => w.path)
const review = before.strict?.status || ''
const sentBefore = (before.guide || []).filter((g) => g.sent).length
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

const q1 = 'What did this run change, and did the review pass?'
const t1 = Date.now()
const r1 = await conductor.conduct(RUN, q1)
const s1 = Math.round((Date.now() - t1) / 1000)
const a1 = String(r1.guide?.at(-1)?.ack || '')
const namesFile = files.some((f) => a1.includes(f) || a1.includes(f.split('/').pop() || f))
check('C-live the answer names a file from the audit and the review status', namesFile && new RegExp(`\\b${review}`, 'i').test(a1), JSON.stringify({ files, review, a1 }))
check('C-live the question leaves the run done', r1.phase === 'done' && r1.workRepo === before.workRepo, r1.phase)

const q2 = 'Add a dark mode toggle to the map page.'
const t2 = Date.now()
const r2 = await conductor.conduct(RUN, q2)
const s2 = Math.round((Date.now() - t2) / 1000)
const a2 = String(r2.guide?.at(-1)?.ack || '')
const notes = r2.guide || []
check('C-live a change request on the done run: still done, nothing queued, only the two Q and A notes added', r2.phase === 'done' && notes.length === (before.guide || []).length + 2 && notes.filter((g) => !g.sent).length === (before.guide || []).length - sentBefore && notes.filter((g) => g.sent).length === sentBefore + 2, JSON.stringify({ phase: r2.phase, notes }))
check('C-live the reply ends with the nothing-was-sent sentence', a2.endsWith(conductor.RUN_OVER), a2)

acp.acpKillAll()
const pass = results.every((r) => r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
writeFileSync(
  artifact,
  [
    `# Unit C live: scripts/check-watcher-after-run.ts (${new Date().toISOString()}, grok ${execFileSync(aicli.resolveBin('grok') || 'grok', ['--version'], { encoding: 'utf8' }).trim()})`,
    `run ${RUN} copied from Joe's store (work repo and brain pointed at temp copies; Grok --no-leader). Audit files: ${files.join(', ')}. Review: ${review}.`,
    `before: phase ${before.phase}, guide ${(before.guide || []).length} (${sentBefore} sent)`,
    '',
    `Joe: ${q1}`,
    `Watcher (${s1} s): ${a1}`,
    `after: phase ${r1.phase}, guide ${(r1.guide || []).length}`,
    '',
    `Joe: ${q2}`,
    `Watcher (${s2} s): ${a2}`,
    `after: phase ${r2.phase}, guide ${notes.length} (${notes.filter((g) => g.sent).length} sent, ${notes.filter((g) => !g.sent).length} queued)`,
    '',
    ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`),
    '',
    pass ? 'WATCHER_AFTER_RUN_PASS' : 'WATCHER_AFTER_RUN_FAIL',
    ''
  ].join('\n')
)
console.log(`\n${pass ? 'WATCHER_AFTER_RUN_PASS' : 'WATCHER_AFTER_RUN_FAIL'} (${results.length} checks)\nartifact: ${artifact}`)
process.exit(pass ? 0 : 1)
