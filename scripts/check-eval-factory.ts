import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTriageCases, readCases, sizeFromStats, type TriageCase } from '../src/main/factory/eval/cases.ts'
import { CONFIGS, dryLine } from '../src/main/factory/eval/configs.ts'
import { bugNamed, gradeReview, triageError } from '../src/main/factory/eval/grade.ts'
import { pickCases } from '../src/main/factory/eval/runner.ts'
import { splitOf } from '../src/main/factory/eval/split.ts'
import { opusArgs } from '../src/main/factory/opus.ts'
import { triage } from '../src/main/factory/triage.ts'

// Eval runner gate, no live model: Doppler guard, --dry argv, graders, case builder, split, and a review
// job on a fixture repo with a fake claude. Prints EVAL_CHECK_PASS only if every check passes.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'eval-check-'))
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Eval Check', '-c', 'user.email=eval@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function write(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
}
function commit(dir: string, msg: string) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', msg])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

const spawnLog = join(temp, 'spawns.log')
const fake = (name: string, body: string) => {
  const p = join(temp, 'bin', name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(spawnLog)}, ${JSON.stringify(name)} + ' ' + process.cwd() + '\\n')\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const claudeBin = fake(
  'claude',
  `const review = 'Missing key strip at src/opus.ts:12 in opusEnv.\\nGAPS: 1\\nFAIL'
process.stdout.write(JSON.stringify({ type: 'result', result: review, num_turns: 1, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { 'claude-fake-eval': { costUSD: 0.02 } } }))`
)
const grokBin = fake(
  'grok',
  `process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: 'T1', risk: 'none', reason: 'fake' }) }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'end', usage: { input_tokens: 7, output_tokens: 1 }, num_turns: 1, total_cost_usd: 0.001, modelUsage: { 'grok-fake-eval': { costUSD: 0.001 } } }) + '\\n')`
)

const baseEnv: NodeJS.ProcessEnv = { ...process.env, EVAL_CLAUDE_BIN: claudeBin, EVAL_GROK_BIN: grokBin }
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_TRANSLATOR_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY']) delete baseEnv[k]
const brain = join(temp, 'brain')
mkdirSync(brain)
const runner = (args: string[], env: NodeJS.ProcessEnv = baseEnv) =>
  spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts', 'eval-factory.ts'), ...args, '--brain', brain], { cwd: root, env, encoding: 'utf8' })
const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean) : [])

// Fixture case repo.
const repo = join(temp, 'case-repo')
mkdirSync(repo)
git(repo, ['init', '-q', '-b', 'main'])
write(repo, { 'src/opus.ts': Array.from({ length: 20 }, (_, i) => `export const l${i + 1} = ${i + 1}\n`).join(''), 'README.md': 'Case repo\n' })
const base = commit(repo, 'init')
write(repo, { 'src/auth/session.ts': 'export const s = 1\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n', 'src/d.ts': 'd\n' })
const typoSha = commit(repo, 'fix typo')
git(repo, ['checkout', '-q', '-b', 'feature/x'])
mkdirSync(join(repo, 'evals', 'factory', 'patches'), { recursive: true })
{
  const f = join(repo, 'src', 'opus.ts')
  const orig = readFileSync(f, 'utf8')
  writeFileSync(f, orig.replace('export const l12 = 12', 'export const l12 = "CODEMARK_EVAL"'))
  writeFileSync(join(repo, 'evals', 'factory', 'patches', 'strip.patch'), git(repo, ['diff', '--', 'src/opus.ts']))
  writeFileSync(f, orig)
}
writeFileSync(join(repo, 'evals', 'factory', 'review.jsonl'), JSON.stringify({ id: 'planted-strip', task: 'Tidy opus.ts', base: typoSha, patch: 'strip.patch', expect: { verdict: 'FAIL', bugs: [{ file: 'src/opus.ts', line: 12, symbol: 'opusEnv', severity: 'critical' }] }, source: 'planted' }) + '\n')
commit(repo, 'eval cases')

// Doppler guard: each key alone stops the runner before any spawn.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_TRANSLATOR_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY']) {
  const before = spawns().length
  const r = runner(['triage', '--repo', repo, '--config', 'grok-default-low'], { ...baseEnv, [key]: 'dummy' })
  check(`guard ${key}: non-zero exit, no spawn, names doppler run`, r.status !== 0 && spawns().length === before && /doppler run/.test(r.stderr), `${r.status} ${r.stderr.slice(0, 120)}`)
}

// --dry prints argv for every registry config.
{
  const tri = runner(['triage', '--dry', '--config', 'rules,grok-default-low,grok-default-medium,grok-4.7-low,grok-low-emptycwd'])
  const rev = runner(['review', '--dry', '--config', 'opus-medium,opus-low,sonnet-high,sonnet-medium'])
  check('dry rules says no spawn', /^rules: no spawn$/m.test(tri.stdout), tri.stdout)
  check('dry grok-4.7-low passes -m grok-4.7', /grok-4\.7-low: .*"-m","grok-4\.7"/.test(tri.stdout))
  check('dry sonnet-high is sonnet at high', /sonnet-high: .*"--model","sonnet","--effort","high"/.test(rev.stdout))
  check('dry opus-medium equals the production argv', rev.stdout.includes(`opus-medium: claude ${JSON.stringify(opusArgs('<prompt>'))}`))
  check('dry covers every registry config', Object.values(CONFIGS).every((c) => (c.job === 'triage' ? tri : rev).stdout.includes(dryLine(c))))
  check('dry spawned nothing', spawns().length === 0, spawns().join('|'))
}

// Graders.
check('weights: T0 expected, T2 got (over by 2) = 2', triageError('T0', 'T2') === 2)
check('weights: T3 expected, T1 got (under by 2) = 6', triageError('T3', 'T1') === 6)
check('weights: T1 expected, T2 got = 1', triageError('T1', 'T2') === 1)
check('weights: exact = 0', triageError('T2', 'T2') === 0)
check('PASS with GAPS: 1 grades FAIL through reviewAccept', gradeReview({ verdict: 'PASS', bugs: [] }, 'Looks fine.\nGAPS: 1\nPASS', true).verdict === 'FAIL')
check('an unparsed review never grades PASS', gradeReview({ verdict: 'PASS', bugs: [] }, 'GAPS: 0\nPASS', false).verdict === 'FAIL')
const bug = { file: 'src/opus.ts', line: 12, severity: 'critical' as const }
check('a bug is named at file:L+5', bugNamed('Problem in src/opus.ts:17', bug))
check('a bug is not named at file:L+6', !bugNamed('Problem in src/opus.ts:18', bug))
check('a bug is named on a symbol match', bugNamed('opus.ts: opusEnv keeps the key', { ...bug, line: 99, symbol: 'opusEnv' }))

// Size ladder is brief.ts LIMIT_LINE exactly.
check('ladder: one package.json file, 10 lines is T0', sizeFromStats([{ path: 'package.json', lines: 10 }]) === 'T0')
check('ladder: two small files is T1', sizeFromStats([{ path: 'src/a.ts', lines: 5 }, { path: 'src/b.ts', lines: 5 }]) === 'T1')
check('ladder: package.json plus a file is T2 (T1 allows no new dependencies)', sizeFromStats([{ path: 'package.json', lines: 5 }, { path: 'src/a.ts', lines: 5 }]) === 'T2')
check('ladder: a package.json version bump plus a file stays T1', sizeFromStats([{ path: 'package.json', lines: 2, deps: false }, { path: 'src/a.ts', lines: 5 }]) === 'T1')
check('ladder: a lockfile plus a file is T3 (T2 allows no lockfile)', sizeFromStats([{ path: 'package-lock.json', lines: 5 }, { path: 'src/a.ts', lines: 5 }]) === 'T3')
check('ladder: a migration plus a file is T3', sizeFromStats([{ path: 'db/migrations/0001.sql', lines: 5 }, { path: 'src/a.ts', lines: 5 }]) === 'T3')
check('ladder: 11 files is T3', sizeFromStats(Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }))) === 'T3')

// Case builder: expectations come from numstat and paths, never from triage().
{
  const out = buildTriageCases(repo, { max: 10 })
  const cases = readCases<TriageCase>(out.file)
  const typo = cases.find((c) => c.sha === typoSha)
  check('case builder: "fix typo" on 5 files with src/auth is T2/critical', typo?.expect.size === 'T2' && typo.expect.risk === 'critical', JSON.stringify(typo?.expect))
  check('case builder does not copy triage() (it says T0 for "fix typo")', triage('fix typo').size === 'T0')
  const again = buildTriageCases(repo, { max: 10 })
  check('case builder rerun keeps ids (idempotent)', again.added === 0 && again.total === out.total)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'triage cases'])
}

// Split.
{
  const ids = Array.from({ length: 50 }, (_, i) => ({ id: `case-${i}` }))
  const a = pickCases(ids, { split: 'holdout' }).map((c) => c.id).sort()
  const b = pickCases([...ids].reverse(), { split: 'holdout' }).map((c) => c.id).sort()
  check('split is fixed by id in any order', JSON.stringify(a) === JSON.stringify(b) && a.length > 0 && ids.every((c) => splitOf(c.id) === splitOf(c.id)))
  const r = runner(['review', '--repo', repo, '--config', 'opus-medium', '--split', 'holdout'])
  check('--split holdout without --confirm exits non-zero', r.status !== 0 && /--confirm/.test(r.stderr), r.stderr)
}

// Review job with the fake claude: case repo untouched, no leftover worktree, results carry no code.
{
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  const branch = git(repo, ['branch', '--show-current']).trim()
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all'])
  const id = 'planted-strip'
  const r = runner(['review', '--repo', repo, '--config', 'opus-medium', '--ids', id, '--split', splitOf(id), ...(splitOf(id) === 'holdout' ? ['--confirm'] : [])])
  const after = { head: git(repo, ['rev-parse', 'HEAD']).trim(), branch: git(repo, ['branch', '--show-current']).trim(), status: git(repo, ['status', '--porcelain', '--untracked-files=all']) }
  const wts = git(repo, ['worktree', 'list', '--porcelain'])
  check('review job ran and reported EVAL_OK', r.status === 0 && /EVAL_OK/.test(r.stdout), r.stderr.slice(0, 900))
  check('case repo HEAD, branch, and status are unchanged', after.head === head && after.branch === branch && after.status === status, JSON.stringify(after))
  check('no leftover eval worktree', !wts.includes('factory-eval-wt-'), wts)
  const dir = join(brain, 'projects', 'factory-evals', 'results')
  const files = existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : []
  const bodies = files.map((f) => readFileSync(f, 'utf8'))
  check('results JSON and md were written to the brain', files.some((f) => f.endsWith('.json')) && files.some((f) => f.endsWith('.md')), JSON.stringify(files))
  check('results carry no code: no marker, no diff header, no hunk line', bodies.every((b) => !b.includes('CODEMARK') && !b.includes('diff --git') && !/^@@ /m.test(b)))
  const json = JSON.parse(bodies[files.findIndex((f) => f.endsWith('.json'))] || '{}') as { rows?: { model: string; review?: { verdict: string; named: number } }[] }
  check('the served model and the grade are on the row', json.rows?.[0]?.model === 'claude-fake-eval' && json.rows[0].review?.verdict === 'FAIL' && json.rows[0].review.named === 1, JSON.stringify(json.rows?.[0]))
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const raw = join(common, 'brain-factory', 'evals')
  check('raw review text went to the case repo store', existsSync(raw) && readdirSync(raw).length > 0, raw)
}

// Triage job with the fake grok: the served model comes from the end event.
{
  const all = readCases<TriageCase>(join(repo, 'evals', 'factory', 'triage.jsonl'))
  const id = all[0]?.id || ''
  const r = runner(['triage', '--repo', repo, '--config', 'rules,grok-low-emptycwd', '--ids', id, '--split', splitOf(id), ...(splitOf(id) === 'holdout' ? ['--confirm'] : [])])
  check('triage job records grok-fake-eval from the end event; rules spawn nothing', r.status === 0 && /grok-fake-eval/.test(r.stdout) && spawns().filter((l) => l.startsWith('grok ')).length === 1, r.stdout.slice(0, 600) + r.stderr.slice(-300))
}

const pass = results.every((r) => r.ok)
console.log([...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`), '', pass ? 'EVAL_CHECK_PASS' : 'EVAL_CHECK_FAIL'].join('\n'))
process.exit(pass ? 0 : 1)
