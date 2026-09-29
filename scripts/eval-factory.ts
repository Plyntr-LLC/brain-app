import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setUserDataDir, listRuns } from '../src/main/factory/run-store.ts'
import { agreement, agreementLine } from '../src/main/factory/shadow.ts'
import { buildTriageCases } from '../src/main/factory/eval/cases.ts'
import { configsFor, dryLine, type ReviewConfig, type TriageConfig } from '../src/main/factory/eval/configs.ts'
import { reportMd, summarize, writeResults } from '../src/main/factory/eval/report.ts'
import { findBin, keyGuard, runReview, runTriage } from '../src/main/factory/eval/runner.ts'
import { opusEnv, runOpus } from '../src/main/factory/opus.ts'
import { triage } from '../src/main/factory/triage.ts'
import { llmTriage } from '../src/main/factory/triage-llm.ts'
import type { Split } from '../src/main/factory/eval/split.ts'

const USAGE = `npm run eval:factory -- <job> [options]
  triage | review   --repo <path> --config a,b [--split train|holdout --confirm] [--limit n per config] [--repeats n] [--ids a,b] [--dry] [--brain <path>]
  cases-triage      --repo <path> [--since <date>] [--max n]
  agreement         [--repo <path>] [--user-data <path>]
  probe             one tiny call per CLI; prints the usage row each one reports`

function args(argv: string[]): { job: string; flags: Record<string, string | true> } {
  const [job = '', ...rest] = argv
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) continue
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      flags[a.slice(2)] = next
      i++
    } else flags[a.slice(2)] = true
  }
  return { job, flags }
}

function fail(msg: string): never {
  console.error(msg)
  console.log('EVAL_FAIL')
  process.exit(2)
}

const { job, flags } = args(process.argv.slice(2))
const str = (k: string) => (typeof flags[k] === 'string' ? String(flags[k]) : '')
const repo = str('repo') ? resolve(str('repo')) : ''
const brain = resolve(str('brain') || process.env.EVAL_BRAIN || join(homedir(), 'Projects', 'agency-brain'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

if (job === 'cases-triage') {
  if (!repo) fail('cases-triage needs --repo.')
  const out = buildTriageCases(repo, { since: str('since') || undefined, max: Number(str('max')) || undefined })
  console.log(`Wrote ${out.added} new case(s), ${out.total} total: ${out.file}`)
  console.log('EVAL_OK')
  process.exit(0)
}

if (job === 'agreement') {
  setUserDataDir(() => str('user-data') || join(homedir(), 'Library', 'Application Support', 'brain-app'))
  const runs = listRuns().filter((r) => !repo || resolve(r.workRepo) === repo)
  for (const a of agreement(runs)) console.log(`${a.repo}: ${agreementLine(a)}`)
  if (!runs.length) console.log('No Factory runs yet.')
  console.log('EVAL_OK')
  process.exit(0)
}

if (job !== 'triage' && job !== 'review' && job !== 'probe') fail(USAGE)
const guard = keyGuard(process.env)
if (guard) fail(guard)
if (job === 'probe') {
  const env = opusEnv(process.env)
  const task = 'Fix the typo in the Settings footer copy'
  const t = await llmTriage({ task, rules: triage(task), cwd: brain, env, bin: findBin('grok', process.env), timeoutMs: 60_000 })
  console.log('grok triage:', JSON.stringify(t.usage))
  const o = await runOpus({ cwd: brain, prompt: 'Reply with the single word OK.', env, bin: findBin('claude', process.env), timeoutMs: 120_000, phase: 'review', run: { effort: 'low' } })
  console.log('claude -p:', JSON.stringify(o.usage))
  console.log(t.usage.model && o.usage.model ? 'EVAL_OK' : 'EVAL_FAIL')
  process.exit(t.usage.model && o.usage.model ? 0 : 1)
}
const names = (str('config') || (job === 'triage' ? 'rules,grok-default-low' : 'opus-medium')).split(',').map((s) => s.trim()).filter(Boolean)
let configs: (TriageConfig | ReviewConfig)[] = []
try {
  configs = configsFor(job, names)
} catch (e) {
  fail(String((e as Error).message))
}
if (flags.dry) {
  for (const c of configs) console.log(dryLine(c))
  console.log('EVAL_OK')
  process.exit(0)
}
if (!repo) fail(`${job} needs --repo.`)
const split: Split = str('split') === 'holdout' ? 'holdout' : 'train'
if (split === 'holdout' && !flags.confirm) fail('The holdout split is for confirming a final pick. Add --confirm to run it.')
const pick = { split, limit: Number(str('limit')) || undefined, ids: str('ids') ? str('ids').split(',') : undefined }
const repeats = Math.max(1, Number(str('repeats')) || 1)
const deps = { env: process.env }
try {
  const rows =
    job === 'triage'
      ? await runTriage({ repo, brain, configs: configs as TriageConfig[], pick, repeats, deps })
      : await runReview({ repo, configs: configs as ReviewConfig[], pick, repeats, deps, stamp })
  const sums = summarize(rows)
  const name = `${stamp}-${job}-${names.join('+')}`
  const md = reportMd({ job, repo, split, stamp, rows, sums })
  const out = writeResults(join(brain, 'projects', 'factory-evals', 'results'), name, { job, repo, split, stamp, configs: names, repeats, summary: sums, rows }, md)
  console.log(md)
  console.log(`Results: ${out.json}\n         ${out.md}`)
  console.log('EVAL_OK')
} catch (e) {
  fail(`Runner error: ${String((e as Error).stack || e)}`)
}
