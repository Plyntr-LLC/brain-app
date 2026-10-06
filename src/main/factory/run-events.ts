import { holdOf, type RunEvent, type RunRecord } from '../../shared/factory.ts'

export const EVENT_CAP = 300
const TEXT = 6000
const TAIL = 2000
const PATHS = 40
const ENDED: ReadonlySet<RunRecord['phase']> = new Set(['paused', 'failed', 'done', 'abandoned'])
const NONE: RunEvent[] = []

const cut = (s: string | undefined, n: number): string => String(s || '').slice(0, n)

/**
 * The run's event list after one persist: prev is the last persisted run, next the one about to be
 * saved. Same array back when nothing happened. Within one persist the order is repo, plan, turn, test,
 * review, voice, commit, push, deploy, hold, end. A builder turn (a build usage row, matched once by
 * its at) is told when the controller writes the audit after it, when the run leaves build, or when it
 * stops. A fix turn runs in review, so it waits for its own audit, never the one before it.
 */
export function nextEvents(prev: RunRecord | undefined, next: RunRecord, at: number): RunEvent[] {
  const had = next.events || NONE
  const add: RunEvent[] = []

  if (!prev || prev.workRepo !== next.workRepo) {
    const why = !prev && next.repoFrom ? { from: next.repoFrom.from, ...(next.repoFrom.word ? { word: next.repoFrom.word } : {}) } : {}
    add.push({ at, kind: 'repo', repo: next.workRepo, moved: !!prev, ...why, ...(prev && next.planRepo === next.workRepo ? { planner: true } : {}) })
  }

  const plan = next.plan
  if (plan?.text && (plan.status !== prev?.plan?.status || plan.text !== prev?.plan?.text)) {
    add.push({ at, kind: 'plan', status: plan.status, by: plan.by, text: cut(plan.text, TEXT) })
  }

  if (next.audit !== prev?.audit || (prev?.phase === 'build' && next.phase !== 'build') || ENDED.has(next.phase)) {
    const told = new Set(had.flatMap((e) => (e.kind === 'turn' ? [e.call] : [])))
    const work = next.audit?.work || []
    for (const row of next.usage || []) {
      if (row.phase !== 'build' || told.has(row.at)) continue
      add.push({
        at,
        kind: 'turn',
        call: row.at,
        model: row.model,
        ms: row.ms,
        ok: row.ok,
        files: work.length,
        added: work.reduce((n, w) => n + w.added, 0),
        deleted: work.reduce((n, w) => n + w.deleted, 0),
        paths: work.slice(0, PATHS).map((w) => w.path)
      })
    }
  }

  if (next.verify?.length && JSON.stringify(next.verify) !== JSON.stringify(prev?.verify || [])) {
    add.push({ at, kind: 'test', rows: next.verify.map((r) => (r.tail ? { ...r, tail: cut(r.tail, TAIL) } : r)) })
  }

  const strict = next.strict
  if (strict && (strict.status !== prev?.strict?.status || strict.text !== prev?.strict?.text)) {
    add.push({ at, kind: 'review', round: had.filter((e) => e.kind === 'review').length + 1, status: strict.status, text: cut(strict.text, TEXT) })
  }

  if (next.voice && next.voice.status !== prev?.voice?.status) add.push({ at, kind: 'voice', status: next.voice.status, text: cut(next.voice.tail, TAIL) })

  if (next.commitSha && next.commitSha !== prev?.commitSha) add.push({ at, kind: 'commit', sha: next.commitSha, ...(next.branch ? { branch: next.branch } : {}) })

  if (next.pushed && next.pushed.at !== prev?.pushed?.at) add.push({ at, kind: 'push', ok: true, text: `${next.pushed.remote}/${next.pushed.branch}` })
  else if (next.pushError && next.pushError !== prev?.pushError) add.push({ at, kind: 'push', ok: false, text: cut(next.pushError, TAIL) })

  if (next.deployed && next.deployed.at !== prev?.deployed?.at) add.push({ at, kind: 'deploy', ok: true, text: '' })
  else if (next.deployError && next.deployError !== prev?.deployError) add.push({ at, kind: 'deploy', ok: false, text: cut(next.deployError, TAIL) })

  const hold = holdOf(next)
  const was = prev ? holdOf(prev) : null
  if (hold && (hold.kind !== was?.kind || hold.text !== was?.text)) add.push({ at, kind: 'hold', hold: hold.kind, text: cut(hold.text, TEXT) })

  if ((next.phase === 'done' || next.phase === 'abandoned') && prev?.phase !== next.phase) add.push({ at, kind: 'end', phase: next.phase })

  return add.length ? [...had, ...add].slice(-EVENT_CAP) : had
}

/** An event that carries text the repo store keeps (a test row's tail counts). */
export function hasText(e: RunEvent): boolean {
  if (e.kind === 'test') return e.rows.some((r) => !!r.tail)
  return 'text' in e && !!e.text
}

/** userData keeps the timeline without its text: plan, review, test, voice, push and hold text stay in the repo store. */
export function eventsWithoutText(events: RunEvent[]): RunEvent[] {
  return events.map((e) => {
    if (e.kind === 'test') return { ...e, rows: e.rows.map(({ tail: _t, ...r }) => r) }
    if ('text' in e) return { ...e, text: '' }
    return e
  })
}
