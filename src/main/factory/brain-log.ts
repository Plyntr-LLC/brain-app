import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, sep } from 'node:path'
import type { RunRecord } from '../../shared/factory.ts'
import { realish, underPath } from './paths.ts'
import { usageTotals } from './usage.ts'

/**
 * The brain's record of Factory work: one entry per run in `<folder>/factory-log.md`, upserted by run id
 * each time a finished run is saved. Metadata only: what, where, which models, verdicts, SHAs. No code.
 */

export const LOG_NAME = 'factory-log.md'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** A brain-relative folder, or null when it is absolute, climbs out, or resolves (symlinks too) outside the brain. */
export function safeBrainFolder(brainPath: string, folder: string | undefined): string | null {
  const f = String(folder || '').trim()
  if (!f || isAbsolute(f)) return null
  const norm = normalize(f)
  if (norm === '.' || norm.split(sep).includes('..')) return null
  const root = realish(brainPath)
  const target = realish(join(brainPath, norm))
  if (target === root || !underPath(root, target)) return null
  return norm
}

/** profile brainFolder, then clients/<repo>, then projects/<repo>, else a new projects/<repo>. */
export function logFolder(brainPath: string, workRepo: string, brainFolder?: string): string {
  const own = safeBrainFolder(brainPath, brainFolder)
  if (own) return own
  const name = basename(workRepo)
  for (const f of [join('clients', name), join('projects', name)]) if (isDir(join(brainPath, f))) return f
  return join('projects', name)
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

export function renderEntry(run: RunRecord): string {
  const u = usageTotals(run.usage)
  const models = [...new Set((run.usage || []).filter((r) => r.model).map((r) => `${r.phase} ${r.model} ${r.effort}`))]
  const verify = (run.verify || []).map((v) => `${v.script} ${v.status}`).join(', ')
  const llm = run.triage.llm
  const shadow = run.shadow
  const lines = [
    `### ${day(run.createdAt)}: ${run.title}`,
    `<!-- factory-run:${run.id} -->`,
    '',
    `- **Outcome:** ${run.phase}${run.commitSha ? `, commit \`${run.commitSha.slice(0, 12)}\`` : ''}${run.branch ? ` on \`${run.branch}\`` : ''}${run.pushed ? `, pushed to ${run.pushed.remote}/${run.pushed.branch}` : ''}${run.deployed ? ', deployed' : ''}`,
    `- **Repo:** \`${run.workRepo}\` (base \`${String(run.base || '').slice(0, 12)}\`)`,
    `- **Size:** ${run.tier}, risk ${run.risk}. Rules said ${run.triage.original}${llm?.size ? `, model said ${llm.size}/${llm.risk}` : llm?.skipped ? `, model triage skipped (${llm.skipped})` : ''}.`,
    `- **Review:** ${run.strict ? `strict ${run.strict.status}` : 'no strict review'}${run.reviewCycles ? ` after ${run.reviewCycles} fail cycle(s)` : ''}${run.followUps?.length ? `, ${run.followUps.length} follow-up(s) outside the repo` : ''}.`,
    ...(verify ? [`- **Checks:** ${verify}${run.voice ? `, voice ${run.voice.status}` : ''}.`] : []),
    `- **Models:** ${models.length ? models.join('; ') : 'none recorded'}.`,
    `- **Usage:** ${u.calls} call(s), ${u.tokens.toLocaleString('en-US')} tokens, ${Math.round(u.ms / 1000)} s, $${u.costEq.toFixed(2)} list-price equivalent.`,
    ...(shadow?.judgments.length || shadow?.auto
      ? [`- **Loop vs Joe:** ${shadow.judgments.map((j) => `loop ${j.wouldShip ? 'ship' : 'hold'}, Joe ${j.action} (${j.agree ? 'agree' : 'disagree'})`).join('; ') || 'no clicks'}${shadow.auto ? `; ${shadow.auto} automatic ship(s)` : ''}.`]
      : []),
    `<!-- /factory-run:${run.id} -->`
  ]
  return lines.join('\n')
}

function header(name: string): string {
  return `# Factory log: ${name}\n\nWritten by Brain.app's Factory when a run finishes. One entry per run, newest last. The code and reviews stay in the repo; this is the record.\n`
}

/** Insert or replace this run's entry. Returns the brain-relative path written. */
export function upsertLog(brainPath: string, run: RunRecord, brainFolder?: string): string {
  const folder = logFolder(brainPath, run.workRepo, brainFolder)
  const dir = join(brainPath, folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LOG_NAME)
  const body = existsSync(file) ? readFileSync(file, 'utf8') : header(basename(run.workRepo))
  const entry = renderEntry(run)
  const start = body.indexOf(`<!-- factory-run:${run.id} -->`)
  let next: string
  if (start >= 0) {
    const head = body.lastIndexOf('### ', start)
    const endTag = `<!-- /factory-run:${run.id} -->`
    const end = body.indexOf(endTag, start) + endTag.length
    next = body.slice(0, head) + entry + body.slice(end)
  } else {
    next = `${body.trimEnd()}\n\n${entry}\n`
  }
  // Written in place: a temp file beside it would show in another run's brain audit as a stray.
  if (next !== body) writeFileSync(file, next)
  return join(folder, LOG_NAME)
}
