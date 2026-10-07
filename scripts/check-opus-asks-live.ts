import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Unit A live: the real signed-in claude through the real opusBuildTurn (production argv, env and
// brief) in a temp repo inside a trusted Claude project whose own settings allow `echo` and carry a
// PreToolUse hook that answers allow. Joe's Mac only. Spends one or two Opus 5.5 medium turns.
// node --experimental-strip-types scripts/check-opus-asks-live.ts [trustedFolder] [artifact]

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const trusted = process.argv[2] || '/Users/joewine/Projects/brain/brain'
const artifact = process.argv[3] || join(rootRepo, 'plans', '20261007-opus-asks-check.txt')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as { transformSync: (code: string, opts: Record<string, unknown>) => { code: string } }

const temp = mkdtempSync(join(tmpdir(), 'brain-opus-live-'))
const userData = join(temp, 'userData')
mkdirSync(userData, { recursive: true })
;(globalThis as { __userData?: string }).__userData = userData
const work = mkdtempSync(join(trusted, 'opus-asks-live-'))
const marker = join(tmpdir(), `opus-asks-live-marker-${process.pid}`)
let runId = ''
let abandon: (id: string) => unknown = () => {}
const cleanup = () => {
  try {
    if (runId) abandon(runId)
  } catch {
    /* already over */
  }
  for (const p of [work, temp, marker]) rmSync(p, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130))

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

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', p)).href
const ctl = (await import(src('main/factory/controller.ts'))) as typeof import('../src/main/factory/controller.ts')
const store = (await import(src('main/factory/run-store.ts'))) as typeof import('../src/main/factory/run-store.ts')
const gates = (await import(src('main/factory/gates.ts'))) as typeof import('../src/main/factory/gates.ts')
const opus = (await import(src('main/factory/opus.ts'))) as typeof import('../src/main/factory/opus.ts')
const aicli = (await import(src('main/ai-cli.ts'))) as typeof import('../src/main/ai-cli.ts')
const { needOpusError } = (await import(src('main/factory/fallback.ts'))) as typeof import('../src/main/factory/fallback.ts')
store.setUserDataDir(() => userData)
abandon = ctl.abandonRun

const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Opus Live', '-c', 'user.email=live@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const hookOut = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'live probe hook' } })
mkdirSync(join(work, '.claude'), { recursive: true })
writeFileSync(
  join(work, '.claude', 'settings.local.json'),
  JSON.stringify(
    {
      permissions: { allow: ['Bash(echo:*)'] },
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `touch '${marker}'; printf '%s' '${hookOut}'` }] }] }
    },
    null,
    2
  )
)
writeFileSync(join(work, 'README.md'), '# Live probe\n\nThe secret word is pelican.\n')
git(['init', '-q', '-b', 'main'])
git(['add', '-A'])
git(['commit', '-q', '-m', 'init'])
const brain = join(temp, 'brain')
mkdirSync(brain)
writeFileSync(join(brain, 'AGENTS.md'), '# Probe brain\n')
const projects = join(temp, 'projects')
mkdirSync(projects)

const tee = join(temp, 'claude-stdout.ndjson')
const spawned: string[][] = []
const events: { kind: string; ev?: { kind: string; data?: string } }[] = []
const bin = aicli.resolveBin('claude')
ctl.configureFactory({
  driver: {
    warm: async () => {
      throw needOpusError('live check: Opus builds')
    },
    prompt: async () => {
      throw needOpusError('live check: Opus builds')
    },
    cancel: () => {},
    close: () => {}
  },
  emit: (e) => events.push(e as (typeof events)[number]),
  env: (r) => opus.opusEnv(gates.factoryEnv(aicli.projectBinEnv(r), gates.ensureShims(store.factoryShimDir()))),
  claudeBin: () => bin,
  projectsDir: projects,
  spawnOpus: ((b: string, args: string[], opts: Parameters<typeof spawn>[2]) => {
    spawned.push(args)
    const child = spawn(b, args, opts)
    child.stdout?.on('data', (d: Buffer) => appendFileSync(tee, d))
    return child
  }) as unknown as NonNullable<Parameters<typeof ctl.configureFactory>[0]['spawnOpus']>
})

const task = 'In this repo: first run exactly `echo live-ok` as a shell command on its own (nothing chained to it), then read README.md, then write a new file out.txt that contains only the secret word from README.md. Change nothing else.'
runId = 'run-opus-live'
const now = Date.now()
store.saveRun({
  id: runId,
  title: 'Live probe: echo, read, write',
  task,
  brainPath: brain,
  workRepo: work,
  tier: 'T1',
  risk: 'low',
  triage: { size: 'T1', original: 'T1', capped: false, reasons: [] },
  runThrough: true,
  approver: 'off',
  builder: 'opus',
  phase: 'paused',
  resumePhase: 'build',
  base: git(['rev-parse', 'HEAD']).trim(),
  acpTab: 'factory-' + runId,
  createdAt: now,
  updatedAt: now
})
const started = Date.now()
ctl.resumeRun(runId)
const run = await ctl.settle(runId)
const secs = Math.round((Date.now() - started) / 1000)

type Line = { type?: string; request_id?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> }; total_cost_usd?: number; usage?: { input_tokens?: number } }
const out: Line[] = (existsSync(tee) ? readFileSync(tee, 'utf8') : '')
  .split('\n')
  .filter((l) => l.trim().startsWith('{'))
  .map((l) => {
    try {
      return JSON.parse(l) as Line
    } catch {
      return {}
    }
  })
const asks = out.filter((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool').map((m) => ({ tool: String(m.request?.tool_name), input: m.request?.input || {} }))
const results = out.filter((m) => m.type === 'result')
const cost = results.reduce((n, m) => n + (m.total_cost_usd || 0), 0)
const builders = spawned.filter((a) => a.includes('--permission-prompt-tool'))
const echo = asks.find((a) => a.tool === 'Bash' && /^echo\s+["']?live-ok["']?$/.test(String(a.input.command).trim()))
const read = asks.find((a) => a.tool === 'Read' && String(a.input.file_path).endsWith('README.md'))
const write = asks.find((a) => a.tool === 'Write' && String(a.input.file_path).endsWith('out.txt'))
const hookRan = existsSync(marker)
const outTxt = existsSync(join(work, 'out.txt')) ? readFileSync(join(work, 'out.txt'), 'utf8').trim() : ''
const build = (run?.usage || []).filter((u) => u.phase === 'build' && u.cli === 'claude')

const checks = [
  { name: 'live every Opus turn ran with the production argv (opusBuildArgs)', ok: builders.length >= 1 && builders.every((a) => JSON.stringify(a) === JSON.stringify(opus.opusBuildArgs())), detail: JSON.stringify(spawned) },
  { name: 'live Bash `echo live-ok` on its own came to Brain as can_use_tool although the repo allows Bash(echo:*)', ok: !!echo, detail: JSON.stringify(asks) },
  { name: 'live Read README.md came to Brain as can_use_tool', ok: !!read, detail: JSON.stringify(asks) },
  { name: 'live Write out.txt came to Brain as can_use_tool', ok: !!write, detail: JSON.stringify(asks) },
  { name: "live the work repo's PreToolUse allow hook never ran (--setting-sources user)", ok: !hookRan, detail: marker },
  { name: 'live out.txt exists after Brain allowed the Write', ok: /pelican/i.test(outTxt), detail: outTxt },
  { name: 'live usage parsed from the result line', ok: build.length >= 1 && build.every((u) => u.ok && u.inTokens + u.cacheRead > 0 && !!u.model), detail: JSON.stringify(build) },
  { name: 'live the run did not fail', ok: !!run && run.phase !== 'failed' && run.phase !== 'paused', detail: JSON.stringify({ phase: run?.phase, error: run?.error }) }
]
const pass = checks.every((c) => c.ok)
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : `  ${c.detail}`}`)

const lines = [
  `# Unit A live: scripts/check-opus-asks-live.ts (${new Date().toISOString()}, claude ${execFileSync(bin || 'claude', ['--version'], { encoding: 'utf8' }).trim()})`,
  `work repo ${work} (inside ${trusted}, removed after), approver off, Approve in advance on, ${builders.length} Opus turns, ${secs} s, run phase ${run?.phase}`,
  `Bash   can_use_tool ${echo ? `yes: ${String(echo.input.command)}` : 'NO'}  (repo .claude/settings.local.json allows Bash(echo:*))`,
  `Read   can_use_tool ${read ? `yes: ${String(read.input.file_path)}` : 'NO'}`,
  `Write  can_use_tool ${write ? `yes: ${String(write.input.file_path)}` : 'NO'}  out.txt="${outTxt}"`,
  `marker ${hookRan ? 'EXISTS: the repo PreToolUse hook ran' : 'absent: the repo PreToolUse allow hook never ran'} (${marker})`,
  `all asks: ${asks.map((a) => `${a.tool}(${String(a.input.command || a.input.file_path || a.input.pattern || a.input.path || '').slice(0, 80)})`).join(', ')}`,
  `usage: ${build.map((u) => `${u.model} in ${u.inTokens} out ${u.outTokens} cacheRead ${u.cacheRead}`).join('; ')}; list-price cost $${cost.toFixed(4)}`,
  '',
  ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`),
  '',
  pass ? 'OPUS_ASKS_LIVE_PASS' : 'OPUS_ASKS_LIVE_FAIL',
  ''
]
const prior = existsSync(artifact) ? readFileSync(artifact, 'utf8') : ''
const fixture = prior.includes('# Unit A live') ? prior.slice(0, prior.indexOf('# Unit A live')).trimEnd() : prior.trimEnd()
writeFileSync(artifact, (fixture ? `${fixture}\n\n` : '') + lines.join('\n'))
console.log(`\n${pass ? 'OPUS_ASKS_LIVE_PASS' : 'OPUS_ASKS_LIVE_FAIL'} (${checks.length} checks, ${secs} s, $${cost.toFixed(4)} list)\nartifact: ${artifact}`)
process.exit(pass ? 0 : 1)
