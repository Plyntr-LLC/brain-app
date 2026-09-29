import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResultRow } from './runner.ts'

/** Scores and usage per config. Metadata only: case ids, SHAs, grades, tokens, time. */

export type Summary = {
  config: string
  runs: number
  ok: number
  models: string[]
  score: number
  /** Spread of the per-repeat score: the noise bar. */
  spread: number
  meanError?: number
  riskAcc?: number
  recall?: number
  falseRejects?: number
  missedCritical?: number
  tokens: number
  ms: number
  costEq: number
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d

export function summarize(rows: ResultRow[]): Summary[] {
  const by = new Map<string, ResultRow[]>()
  for (const r of rows) by.set(r.config, [...(by.get(r.config) || []), r])
  return [...by.entries()].map(([config, list]) => {
    const reps = [...new Set(list.map((r) => r.rep))]
    const scoreOf = (xs: ResultRow[]) =>
      xs.length ? xs.filter((r) => (r.triage ? r.triage.sizeOk && r.triage.riskOk : r.review?.verdictOk)).length / xs.length : 0
    const perRep = reps.map((n) => scoreOf(list.filter((r) => r.rep === n)))
    const u = list.map((r) => r.usage).filter((x): x is NonNullable<typeof x> => !!x)
    const tri = list.filter((r) => r.triage)
    const rev = list.filter((r) => r.review)
    const bugs = rev.reduce((n, r) => n + (r.review?.bugs || 0), 0)
    return {
      config,
      runs: list.length,
      ok: list.filter((r) => r.ok).length,
      models: [...new Set(list.map((r) => r.model).filter(Boolean))],
      score: round(scoreOf(list)),
      spread: round(perRep.length ? Math.max(...perRep) - Math.min(...perRep) : 0),
      ...(tri.length
        ? { meanError: round(tri.reduce((n, r) => n + (r.triage?.error || 0), 0) / tri.length), riskAcc: round(tri.filter((r) => r.triage?.riskOk).length / tri.length) }
        : {}),
      ...(rev.length
        ? {
            recall: bugs ? round(rev.reduce((n, r) => n + (r.review?.named || 0), 0) / bugs) : 1,
            falseRejects: rev.filter((r) => r.review?.falseReject).length,
            missedCritical: rev.filter((r) => r.review?.missedCritical).length
          }
        : {}),
      tokens: u.reduce((n, x) => n + x.inTokens + x.outTokens + x.cacheRead + x.cacheWrite, 0),
      ms: u.reduce((n, x) => n + x.ms, 0),
      costEq: round(u.reduce((n, x) => n + x.costEq, 0), 4)
    }
  })
}

export function reportMd(o: { job: string; repo: string; split: string; stamp: string; rows: ResultRow[]; sums: Summary[] }): string {
  const head =
    o.job === 'triage'
      ? '| Config | Served model | Runs | Exact | Risk | Mean error | Spread | Tokens | Time | List-price eq |\n|---|---|---|---|---|---|---|---|---|---|'
      : '| Config | Served model | Runs | Verdict | Bug recall | False rejects | Missed critical | Spread | Tokens | Time | List-price eq |\n|---|---|---|---|---|---|---|---|---|---|---|'
  const line = (s: Summary) =>
    o.job === 'triage'
      ? `| ${s.config} | ${s.models.join(', ') || '(none)'} | ${s.runs} | ${s.score} | ${s.riskAcc} | ${s.meanError} | ${s.spread} | ${s.tokens.toLocaleString('en-US')} | ${Math.round(s.ms / 1000)} s | $${s.costEq} |`
      : `| ${s.config} | ${s.models.join(', ') || '(none)'} | ${s.runs} | ${s.score} | ${s.recall} | ${s.falseRejects} | ${s.missedCritical} | ${s.spread} | ${s.tokens.toLocaleString('en-US')} | ${Math.round(s.ms / 1000)} s | $${s.costEq} |`
  const misses = o.rows.filter((r) => (r.triage ? !(r.triage.sizeOk && r.triage.riskOk) : !r.review?.verdictOk))
  return [
    `# Factory eval: ${o.job} (${o.stamp})`,
    '',
    `Repo: \`${o.repo}\`. Split: ${o.split}. Every call ran on the signed-in CLI. List-price eq is what the same tokens would cost on the API; the login is not billed that.`,
    '',
    head,
    ...o.sums.map(line),
    '',
    `## Misses (${misses.length})`,
    '',
    ...misses.map((r) =>
      r.triage
        ? `- ${r.config} ${r.caseId} (rep ${r.rep}): got ${r.got?.size}/${r.got?.risk}, error ${r.triage.error}${r.why ? `, ${r.why}` : ''}`
        : `- ${r.config} ${r.caseId} (rep ${r.rep}): ${r.review?.verdict}, named ${r.review?.named}/${r.review?.bugs}${r.review?.missedCritical ? ', missed a critical bug' : ''}${r.why ? `, ${r.why}` : ''}`
    ),
    ''
  ].join('\n')
}

export function writeResults(dir: string, name: string, data: unknown, md: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true })
  const json = join(dir, `${name}.json`)
  const mdPath = join(dir, `${name}.md`)
  writeFileSync(json, JSON.stringify(data, null, 2))
  writeFileSync(mdPath, md)
  return { json, md: mdPath }
}
