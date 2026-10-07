import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Unit B: every watch starts through the real publishRun or shipRun (case 13: the Check deploy again
// click on Joe's own lotline push). The work repo's origin url is a GitHub repo and its pushurl a local
// bare, so pushes stay local. A fake gh answers from a scripted timeline; the Factory shim dir is first on
// PATH as in the Factory env. Case 13 reads GitHub with the real gh.
// node --experimental-strip-types scripts/check-deploy-watch.ts [artifact]

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const artifact = process.argv[2] || join(rootRepo, 'plans', '20261007-deploy-watch-check.txt')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as { transformSync: (code: string, opts: Record<string, unknown>) => { code: string } }

const temp = mkdtempSync('/tmp/dw-')
const userData = join(temp, 'userData')
mkdirSync(userData, { recursive: true })
;(globalThis as { __userData?: string }).__userData = userData

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
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
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      return { format: 'module', shortCircuit: true, source: esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code }
    }
    return next(url, ctx)
  }
})

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', p)).href
const ctl = (await import(src('main/factory/controller.ts'))) as typeof import('../src/main/factory/controller.ts')
const store = (await import(src('main/factory/run-store.ts'))) as typeof import('../src/main/factory/run-store.ts')
const gates = (await import(src('main/factory/gates.ts'))) as typeof import('../src/main/factory/gates.ts')
const opus = (await import(src('main/factory/opus.ts'))) as typeof import('../src/main/factory/opus.ts')
const shared = (await import(pathToFileURL(join(rootRepo, 'src', 'shared', 'factory.ts')).href)) as typeof import('../src/shared/factory.ts')
store.setUserDataDir(() => userData)

const fakeBin = join(temp, 'fakebin')
const ghLog = join(temp, 'gh.jsonl')
const ghScript = join(temp, 'gh-script.json')
const ghCount = join(temp, 'gh-count')
mkdirSync(fakeBin)
writeFileSync(
  join(fakeBin, 'gh'),
  `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ at: Date.now(), args }) + '\\n')
const script = JSON.parse(fs.readFileSync(${JSON.stringify(ghScript)}, 'utf8'))
if (args[0] === 'auth') process.exit(script.signedOut ? 1 : 0)
const path = String(args[1] || '')
let n = 0
try { n = Number(fs.readFileSync(${JSON.stringify(ghCount)}, 'utf8')) || 0 } catch {}
if (/\\/deployments\\?/.test(path)) { n++; fs.writeFileSync(${JSON.stringify(ghCount)}, String(n)) }
const step = script.steps[Math.min(Math.max(n, 1), script.steps.length) - 1] || {}
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0) }
if (/\\/deployments\\?/.test(path)) out((step.deployments || []).map(({ status, ...d }) => d))
const m = /\\/deployments\\/(\\d+)\\/statuses/.exec(path)
if (m) { const d = (step.deployments || []).find((x) => String(x.id) === m[1]); out(d && d.status ? [d.status] : []) }
if (/\\/commits\\/[^/]+\\/status$/.test(path)) out({ state: 'pending', statuses: step.statuses || [] })
if (/\\/check-runs$/.test(path)) out({ total_count: 0, check_runs: step.checks || [] })
process.stderr.write('fake gh: no answer for ' + path)
process.exit(1)
`
)
chmodSync(join(fakeBin, 'gh'), 0o755)

let ghOnPath = true
const factoryEnvFor = () => opus.opusEnv(gates.factoryEnv({ ...process.env, PATH: [ghOnPath ? fakeBin : '', '/usr/bin', '/bin'].filter(Boolean).join(':') }, gates.ensureShims(store.factoryShimDir())))
const deploys: { repo: string; cmd: string }[] = []
type Ev = { runId: string; kind: string; run?: import('../src/shared/factory.ts').RunRecord; t: number }
const events: Ev[] = []
const deps: Parameters<typeof ctl.configureFactory>[0] = {
  driver: { warm: async () => ({ sessionId: 'x' }), prompt: async () => '', cancel: () => {}, close: () => {} },
  emit: (e) => events.push({ ...(e as Omit<Ev, 't'>), t: Date.now() }),
  env: () => factoryEnvFor(),
  deploy: async (repo, cmd) => {
    deploys.push({ repo, cmd })
    return { ok: true, out: 'deployed' }
  },
  deployWatch: { pollMs: 50, noneMs: 1500, stuckMs: 2000 }
}
ctl.configureFactory(deps)

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Watch Check', '-c', 'user.email=watch@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let n = 0
/** A work repo linked to Vercel; origin fetches from GitHub (url) and pushes to a local bare (pushurl). */
function workRepo(o: { github?: string | null } = {}): string {
  const dir = join(temp, `work-${++n}`)
  const bare = join(temp, `bare-${n}.git`)
  mkdirSync(join(dir, '.vercel'), { recursive: true })
  git(temp, ['init', '-q', '--bare', '-b', 'main', bare])
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_fixture', orgId: 'team_fixture' }))
  writeFileSync(join(dir, 'index.ts'), 'export const n = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  git(dir, ['remote', 'add', 'origin', o.github === null ? bare : o.github || 'https://github.com/acme/site.git'])
  git(dir, ['config', 'remote.origin.pushurl', bare])
  git(dir, ['push', '-q', 'origin', 'main'])
  return dir
}

/** A run that committed and waits for Push (publish), or one back in review with a change after a restart (ship). */
function runIn(dir: string, phase: 'done' | 'review'): string {
  const id = `run-dw-${n}`
  const now = Date.now()
  if (phase === 'review') writeFileSync(join(dir, 'index.ts'), `export const n = ${n + 1}\n`)
  else {
    writeFileSync(join(dir, 'index.ts'), `export const n = ${n + 1}\n`)
    git(dir, ['commit', '-q', '-am', 'run commit'])
  }
  const head = git(dir, ['rev-parse', 'HEAD']).trim()
  store.saveRun({
    id,
    title: 'Fix the footer copy',
    task: 'Fix the footer copy',
    brainPath: join(temp, 'brain'),
    workRepo: dir,
    tier: 'T1',
    risk: 'low',
    triage: { size: 'T1', original: 'T1', capped: false, reasons: [] },
    phase: phase === 'review' ? 'paused' : 'done',
    ...(phase === 'review' ? { resumePhase: 'review' as const } : {}),
    base: phase === 'review' ? head : git(dir, ['rev-parse', 'HEAD~1']).trim(),
    ...(phase === 'review' ? { diff: 'diff --git a/index.ts b/index.ts' } : { commitSha: head, branch: 'main' }),
    acpTab: 'factory-' + id,
    createdAt: now,
    updatedAt: now
  })
  if (phase === 'review') ctl.resumeRun(id)
  return id
}
mkdirSync(join(temp, 'brain'))

const SHA = 'pushed'
const dep = (id: number, sha: string, state: string, url?: string, environment = 'Production') => ({ id, sha, environment, creator: { login: 'vercel[bot]' }, status: { state, ...(url ? { environment_url: url } : {}) } })
function script(steps: unknown[], o: { signedOut?: boolean } = {}): void {
  writeFileSync(ghScript, JSON.stringify({ steps, ...o }))
  writeFileSync(ghCount, '0')
}
/** The fake's timeline uses the literal sha 'pushed'; this swaps in the run's real pushed sha. */
function scriptFor(sha: string, steps: unknown[], o: { signedOut?: boolean } = {}): void {
  script(JSON.parse(JSON.stringify(steps).replaceAll(`"${SHA}"`, JSON.stringify(sha))), o)
}
type GhRow = { at: number; args: string[] }
const ghRows = (): GhRow[] => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhRow) : [])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean, ms = 6000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (pred()) return true
  return pred()
}
const watchOf = (id: string) => ctl.getRun(id)?.deployWatch
/** The watch states the run went through, from the run events Brain emitted. */
function statesOf(id: string, from: number): string[] {
  const out: string[] = []
  for (const e of events.slice(from)) {
    const s = e.runId === id && e.kind === 'run' ? e.run?.deployWatch?.state : undefined
    if (s && out.at(-1) !== s) out.push(s)
  }
  return out
}
const ENDS = new Set(['live', 'failed', 'none', 'unknown'])
/** gh calls after the run first showed an end state (live, failed, none, unknown). */
function ghAfterEnd(id: string, from: number): number | string {
  const end = events.slice(from).find((e) => e.runId === id && e.kind === 'run' && ENDS.has(String(e.run?.deployWatch?.state)))
  return end ? ghRows().filter((c) => c.at > end.t).length : 'no end'
}

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })
const lines: string[] = []
const blocks: Record<string, string | null> = {}
const afterEnds: Record<string, number | string> = {}
const line = (label: string, o: { states: string[]; after: number | string; spy: number; block: string | null; extra?: string }) =>
  (afterEnds[label.trim()] = o.after) !== undefined &&
  lines.push(`${label}  states=${o.states.join('>') || 'none'}  gh calls after end=${o.after}  deploy spy=${o.spy}  deployBlockFor=${o.block === null ? 'null (Deploy on)' : JSON.stringify(o.block)}${o.extra ? `  ${o.extra}` : ''}`)

// 1. Push, then nothing, then in_progress, then success.
{
  const dir = workRepo()
  const id = runIn(dir, 'done')
  const sha = git(dir, ['rev-parse', 'HEAD']).trim()
  scriptFor(sha, [{}, { deployments: [dep(11, SHA, 'in_progress')] }, { deployments: [dep(11, SHA, 'success', 'https://site-acme.vercel.app')] }])
  const e0 = events.length
  const g0 = ghRows().length
  const r = await ctl.publishRun(id, { by: 'joe' })
  blocks.watching = ctl.deployBlockFor(id)
  await until(() => watchOf(id)?.state === 'live')
  const endAt = Date.now()
  await sleep(300)
  const w = watchOf(id)
  const calls = ghRows().slice(g0)
  const deployCalls = calls.filter((c) => /\/deployments\?/.test(c.args[1] || ''))
  const after = calls.filter((c) => c.at > endAt).length
  const states = statesOf(id, e0)
  blocks.live = ctl.deployBlockFor(id)
  check('1 push to live: watching, building, live with host, env and URL', !!r.pushed && JSON.stringify(states) === '["watching","building","live"]' && w?.state === 'live' && w.host === 'Vercel' && w.env === 'Production' && w.url === 'https://site-acme.vercel.app', JSON.stringify({ states, w }))
  check('1 the fake gh answered, not the Factory shim (auth status then api calls)', calls[0]?.args.join(' ') === 'auth status --hostname github.com' && deployCalls.length >= 3, JSON.stringify(calls.slice(0, 2)))
  check('1 every deployments call carried sha=<pushed sha>', deployCalls.length > 0 && deployCalls.every((c) => c.args[1] === `repos/acme/site/deployments?sha=${sha}&per_page=20`), JSON.stringify(deployCalls.map((c) => c.args[1])))
  check('1 no gh call after live', after === 0, String(after))
  line('case 1 ', { states, after, spy: deploys.length, block: blocks.live, extra: `url=${w && 'url' in w ? w.url : ''}` })
}

// 2. Another sha's deployment is live, and so is a Preview of this sha; this push's Production only builds.
{
  const dir = workRepo()
  const id = runIn(dir, 'done')
  const sha = git(dir, ['rev-parse', 'HEAD']).trim()
  const other = dep(22, 'f'.repeat(40), 'success', 'https://old.vercel.app')
  const preview = dep(23, SHA, 'success', 'https://preview.vercel.app', 'Preview')
  scriptFor(sha, [{ deployments: [other, preview] }, { deployments: [other, preview] }, { deployments: [dep(21, SHA, 'in_progress'), other, preview] }])
  const e0 = events.length
  await ctl.publishRun(id, { by: 'joe' })
  await until(() => watchOf(id)?.state === 'building')
  await sleep(400)
  const states = statesOf(id, e0)
  blocks.building = ctl.deployBlockFor(id)
  check('2 another sha live, or a Preview of this sha live, does not make this push live: watching, then building, never live', JSON.stringify(states) === '["watching","building"]' && watchOf(id)?.state === 'building', JSON.stringify(states))
  ctl.abandonRun(id)
  line('case 2 ', { states, after: '-', spy: deploys.length, block: blocks.building })
}

// 3 and 4. No signal: none; Deploy on with the host's own command; the clean-tree and HEAD gates.
{
  const dir = workRepo()
  const id = runIn(dir, 'done')
  scriptFor('x', [{}])
  const e0 = events.length
  const g0 = ghRows().length
  await ctl.publishRun(id, { by: 'joe' })
  await until(() => watchOf(id)?.state === 'none')
  const endAt = Date.now()
  await sleep(300)
  const after = ghRows().slice(g0).filter((c) => c.at > endAt).length
  const states = statesOf(id, e0)
  blocks.none = ctl.deployBlockFor(id)
  const cmd = ctl.deployCmdFor(id)
  check('3 no signal in the window: none, Deploy on, the standard command is vercel deploy --prod --yes on main', JSON.stringify(states) === '["watching","none"]' && blocks.none === null && cmd === 'vercel deploy --prod --yes', JSON.stringify({ states, block: blocks.none, cmd }))
  check('5 no gh call after none', after === 0, String(after))
  line('case 3 ', { states, after, spy: deploys.length, block: blocks.none, extra: `cmd="${cmd}"` })
  writeFileSync(join(dir, 'scratch.txt'), 'untracked\n')
  const dirty = ctl.deployBlockFor(id)
  const dirtyRun = await ctl.deployRun(id)
  git(dir, ['clean', '-qfd'])
  writeFileSync(join(dir, 'index.ts'), 'export const n = 99\n')
  git(dir, ['commit', '-q', '-am', 'later commit'])
  const moved = ctl.deployBlockFor(id)
  check(
    '4 the host CLI uploads the folder: a dirty tree and a moved HEAD each turn Deploy off with why, and a click does not deploy',
    dirty === "Vercel's CLI uploads this folder, and it has uncommitted changes. Commit or stash them first." &&
      moved === "Vercel's CLI uploads this folder, and HEAD is no longer the pushed commit." &&
      dirtyRun.deployError === dirty &&
      deploys.length === 0,
    JSON.stringify({ dirty, moved, err: dirtyRun.deployError, deploys: deploys.length })
  )
  lines.push(`case 4   dirty tree -> ${JSON.stringify(dirty)}; HEAD moved -> ${JSON.stringify(moved)}; deploy spy=${deploys.length}`)
}

// 5. Abandon while building: polling stops.
{
  const dir = workRepo()
  const id = runIn(dir, 'done')
  const sha = git(dir, ['rev-parse', 'HEAD']).trim()
  scriptFor(sha, [{ deployments: [dep(51, SHA, 'in_progress')] }])
  const e0 = events.length
  await ctl.publishRun(id, { by: 'joe' })
  await until(() => watchOf(id)?.state === 'building')
  ctl.abandonRun(id)
  const endAt = Date.now()
  await sleep(400)
  const after = ghRows().filter((c) => c.at > endAt).length
  check('5 abandon during building: no gh call after abandon', after === 0 && !ctl.deployWatchLive(id), String(after))
  line('case 5 ', { states: statesOf(id, e0), after, spy: deploys.length, block: ctl.deployBlockFor(id), extra: 'abandoned while building; live and none ends: see cases 1 and 3' })
}

// 6. Not a GitHub remote: unknown at once, no gh call.
{
  const dir = workRepo({ github: null })
  const id = runIn(dir, 'done')
  const g0 = ghRows().length
  const e0 = events.length
  const t0 = Date.now()
  await ctl.publishRun(id, { by: 'joe' })
  await until(() => watchOf(id)?.state === 'unknown', 2000)
  const w = watchOf(id)
  const ms = Date.now() - t0
  blocks.unknown = ctl.deployBlockFor(id)
  check('6 a local remote: unknown at once with the reason, no gh call', w?.state === 'unknown' && w.why === 'origin is not a github.com remote.' && ghRows().length === g0 && ms < 400, JSON.stringify({ w, ms, calls: ghRows().length - g0 }))
  line('case 6 ', { states: statesOf(id, e0), after: ghAfterEnd(id, e0), spy: deploys.length, block: blocks.unknown, extra: `why=${JSON.stringify(w && 'why' in w ? w.why : '')}` })
}

// 7. No gh on PATH.
{
  const dir = workRepo()
  const id = runIn(dir, 'done')
  ghOnPath = false
  const e0 = events.length
  await ctl.publishRun(id, { by: 'joe' })
  await until(() => watchOf(id)?.state === 'unknown', 2000)
  ghOnPath = true
  const w = watchOf(id)
  check('7 gh missing: unknown at once, the reason names the GitHub CLI', w?.state === 'unknown' && /GitHub CLI/.test(w.why), JSON.stringify(w))
  line('case 7 ', { states: statesOf(id, e0), after: ghAfterEnd(id, e0), spy: deploys.length, block: ctl.deployBlockFor(id), extra: `why=${JSON.stringify(w && 'why' in w ? w.why : '')}` })
}

// 8. Let's get this live while the host deploys: shipRun returns at watching, Brain never deploys.
{
  const dir = workRepo()
  const id = runIn(dir, 'review')
  scriptFor('x', [{}])
  const e0 = events.length
  const d0 = deploys.length
  const shipped = await ctl.shipRun(id)
  const at = shipped.deployWatch?.state
  const sha = shipped.pushed?.sha || ''
  scriptFor(sha, [{}, { deployments: [dep(81, SHA, 'in_progress')] }, { deployments: [dep(81, SHA, 'success', 'https://ship.vercel.app')] }])
  await until(() => watchOf(id)?.state === 'live')
  await sleep(300)
  const states = statesOf(id, e0)
  check('8 shipRun resolves while the watch is still watching; the host goes live; the deploy spy stays 0', !!shipped.pushed && at === 'watching' && JSON.stringify(states) === '["watching","building","live"]' && deploys.length === d0, JSON.stringify({ at, states, deploys: deploys.length - d0 }))
  line('case 8 ', { states, after: ghAfterEnd(id, e0), spy: deploys.length - d0, block: ctl.deployBlockFor(id), extra: `shipRun returned at ${at}` })
}

// 9. Let's get this live, nothing starts: Brain deploys once, after none.
{
  const dir = workRepo()
  const id = runIn(dir, 'review')
  scriptFor('x', [{}])
  const e0 = events.length
  const d0 = deploys.length
  await ctl.shipRun(id)
  const before = deploys.length - d0
  await until(() => !!ctl.getRun(id)?.deployed)
  await sleep(200)
  const states = statesOf(id, e0)
  check('9 shipRun, nothing started: none, then the deploy spy exactly once with the host command', before === 0 && JSON.stringify(states) === '["watching","none"]' && deploys.length - d0 === 1 && deploys.at(-1)?.cmd === 'vercel deploy --prod --yes', JSON.stringify({ before, states, spy: deploys.slice(d0) }))
  line('case 9 ', { states, after: ghAfterEnd(id, e0), spy: deploys.length - d0, block: ctl.deployBlockFor(id), extra: `cmd=${deploys.at(-1)?.cmd}` })
}

// 10. Let's get this live where Brain cannot watch: deploys at once.
{
  ctl.configureFactory({ ...deps, deployWatch: { pollMs: 50, noneMs: 60_000, stuckMs: 120_000 } })
  const dir = workRepo({ github: null })
  const id = runIn(dir, 'review')
  const e0 = events.length
  const d0 = deploys.length
  const t0 = Date.now()
  await ctl.shipRun(id)
  await until(() => deploys.length - d0 === 1, 2000)
  const ms = Date.now() - t0
  await sleep(200)
  check('10 shipRun, not a GitHub remote: the deploy spy once, at once (well inside the none window)', deploys.length - d0 === 1 && ms < 1500 && watchOf(id)?.state === 'unknown', JSON.stringify({ spy: deploys.length - d0, ms }))
  line('case 10', { states: statesOf(id, e0), after: ghAfterEnd(id, e0), spy: deploys.length - d0, block: ctl.deployBlockFor(id), extra: `deployed after ${ms} ms (none window 60 s)` })
  ctl.configureFactory(deps)
}

// 11. Let's get this live, the host fails: no deploy, Deploy on.
{
  const dir = workRepo()
  const id = runIn(dir, 'review')
  scriptFor('x', [{}])
  const e0 = events.length
  const d0 = deploys.length
  const shipped = await ctl.shipRun(id)
  scriptFor(shipped.pushed?.sha || '', [{ deployments: [dep(111, SHA, 'failure', 'https://fail.vercel.app')] }])
  await until(() => watchOf(id)?.state === 'failed')
  await sleep(300)
  const states = statesOf(id, e0)
  blocks.failed = ctl.deployBlockFor(id)
  const w = watchOf(id)
  check('11 shipRun, host failed: failed with the URL, the deploy spy 0, Deploy on', w?.state === 'failed' && w.url === 'https://fail.vercel.app' && deploys.length === d0 && blocks.failed === null, JSON.stringify({ states, spy: deploys.length - d0, block: blocks.failed }))
  line('case 11', { states, after: ghAfterEnd(id, e0), spy: deploys.length - d0, block: blocks.failed })
}

// 11b. Let's get this live, the build sticks past the window: unknown, no deploy, Deploy on.
{
  const dir = workRepo()
  const id = runIn(dir, 'review')
  scriptFor('x', [{}])
  const e0 = events.length
  const d0 = deploys.length
  const shipped = await ctl.shipRun(id)
  scriptFor(shipped.pushed?.sha || '', [{ deployments: [dep(112, SHA, 'in_progress')] }])
  await until(() => watchOf(id)?.state === 'unknown', 4000)
  await sleep(300)
  const states = statesOf(id, e0)
  const w = watchOf(id)
  const block = ctl.deployBlockFor(id)
  check('11b shipRun, stuck build: unknown (still building), the deploy spy 0, Deploy on', w?.state === 'unknown' && /still building/.test(w.why) && JSON.stringify(states) === '["watching","building","unknown"]' && deploys.length === d0 && block === null, JSON.stringify({ states, w, spy: deploys.length - d0, block }))
  line('case 11b', { states, after: ghAfterEnd(id, e0), spy: deploys.length - d0, block, extra: `why=${JSON.stringify(w && 'why' in w ? w.why : '')}` })
}

// 11c. Let's get this live with no gh: unknown at once, deploys once at once.
{
  const dir = workRepo()
  const id = runIn(dir, 'review')
  ghOnPath = false
  const e0 = events.length
  const d0 = deploys.length
  const t0 = Date.now()
  await ctl.shipRun(id)
  await until(() => deploys.length - d0 === 1, 2000)
  const ms = Date.now() - t0
  ghOnPath = true
  await sleep(200)
  const w = watchOf(id)
  check('11c shipRun, gh missing: unknown naming the GitHub CLI, the deploy spy once, at once', w?.state === 'unknown' && /GitHub CLI/.test(w.why) && deploys.length - d0 === 1 && ms < 1500, JSON.stringify({ w, spy: deploys.length - d0, ms }))
  line('case 11c', { states: statesOf(id, e0), after: ghAfterEnd(id, e0), spy: deploys.length - d0, block: ctl.deployBlockFor(id), extra: `deployed after ${ms} ms` })
}

// 12. Deploy per watch state, from the real deployBlockFor above.
{
  const off = ['watching', 'building', 'live'].every((s) => typeof blocks[s] === 'string' && blocks[s] === shared.watchDeployBlock(s === 'watching' ? { state: 'watching', since: 0 } : { state: s as 'building', host: 'Vercel', since: 0 }))
  const on = ['none', 'failed', 'unknown'].every((s) => blocks[s] === null)
  check('12 Deploy off while watching, building and live (with the sentence); on for none, failed and unknown', off && on, JSON.stringify(blocks))
  lines.push(`case 12  ${Object.entries(blocks).map(([s, b]) => `${s}: ${b === null ? 'Deploy on' : `off "${b}"`}`).join('; ')}`)
}

check('5 polling stops at every end state: no gh call after live, failed, none or unknown in any case', Object.values(afterEnds).every((a) => a === 0 || a === '-'), JSON.stringify(afterEnds))

// 13. Live read with the real gh: Joe's own lotline push, through the Check deploy again click.
{
  const realGh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => existsSync(p))
  const wrapDir = join(temp, 'realgh')
  const wrapLog = join(temp, 'realgh.jsonl')
  mkdirSync(wrapDir)
  writeFileSync(join(wrapDir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${wrapLog}'\nexec '${realGh}' "$@"\n`)
  chmodSync(join(wrapDir, 'gh'), 0o755)
  const LOTLINE_SHA = '8fe5f16560559d19d9168325e74d0d924f373e81'
  const dir = join(temp, 'lotline-read')
  mkdirSync(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['remote', 'add', 'origin', 'https://github.com/joeprosynergy/lotline.git'])
  const id = 'run-dw-live'
  const now = Date.now()
  store.saveRun({
    id,
    title: 'Live read of lotline 8fe5f16',
    task: 'Live read',
    brainPath: join(temp, 'brain'),
    workRepo: dir,
    tier: 'T1',
    risk: 'low',
    triage: { size: 'T1', original: 'T1', capped: false, reasons: [] },
    phase: 'done',
    base: LOTLINE_SHA,
    commitSha: LOTLINE_SHA,
    branch: 'main',
    pushed: { remote: 'origin', branch: 'main', sha: LOTLINE_SHA, at: now },
    acpTab: 'factory-' + id,
    createdAt: now,
    updatedAt: now
  })
  const realEnv = () => opus.opusEnv(gates.factoryEnv({ ...process.env, PATH: [wrapDir, '/usr/bin', '/bin'].join(':') }, gates.ensureShims(store.factoryShimDir())))
  ctl.configureFactory({ ...deps, env: realEnv, deployWatch: { pollMs: 10_000, noneMs: 180_000, stuckMs: 1_200_000 } })
  const e0 = events.length
  ctl.checkDeployAgain(id)
  await until(() => !!watchOf(id) && watchOf(id)?.state !== 'watching', 60_000)
  const w = watchOf(id)
  const calls = existsSync(wrapLog) ? readFileSync(wrapLog, 'utf8').trim().split('\n') : []
  const polls = calls.filter((c) => c.includes('/deployments?sha=')).length
  check('13 live read, real gh: lotline 8fe5f16 is live on Vercel, Production, with the URL, on the first poll', !!realGh && w?.state === 'live' && w.host === 'Vercel' && w.env === 'Production' && /^https:\/\//.test(String(w.url)) && polls === 1, JSON.stringify({ w, polls, calls }))
  line('case 13', { states: statesOf(id, e0), after: '-', spy: 0, block: ctl.deployBlockFor(id), extra: `polls=${polls} ${w ? shared.deployWatchLine(w) : ''}` })
  ctl.abandonRun(id)
  ctl.configureFactory(deps)
}

const pass = results.every((r) => r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  ${r.detail}`}`)
writeFileSync(artifact, [`# Unit B: scripts/check-deploy-watch.ts (${new Date().toISOString()})`, ...lines, '', ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`), '', pass ? 'DEPLOY_WATCH_PASS' : 'DEPLOY_WATCH_FAIL', ''].join('\n'))
console.log(`\n${pass ? 'DEPLOY_WATCH_PASS' : 'DEPLOY_WATCH_FAIL'} (${results.length} checks)\nartifact: ${artifact}`)
process.exit(pass ? 0 : 1)
