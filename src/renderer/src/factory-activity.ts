import { APPROVER_NAME, holdOf, strictRequired, type LiveCall, type RunPhase, type RunRecord } from '../../shared/factory'
import type { Activity, RailState } from './activity'

const ROLE: Record<LiveCall['phase'], string> = { triage: 'Lead', plan: 'Planner', build: 'Builder', review: 'Reviewer', approve: 'Approver' }
const ORDER: RunPhase[] = ['triage', 'plan', 'build', 'verify', 'review', 'commit', 'done']

/** Where the run is, reading a paused or failed run at the phase it resumes to. */
function stageAt(run: RunRecord): number {
  const at = run.phase === 'paused' || run.phase === 'failed' || run.phase === 'upgrade' ? run.resumePhase || 'build' : run.phase
  const i = ORDER.indexOf(at)
  return i < 0 ? 0 : i
}

function lastModel(run: RunRecord, phase: LiveCall['phase'], fallback: string): string {
  const row = [...(run.usage || [])].reverse().find((u) => u.phase === phase && u.model)
  return row?.model || fallback
}

export function factoryActivity(run: RunRecord, pushBlock: string | null): Activity {
  const hold = holdOf(run)
  const live = [...(run.live || [])].pop()
  const at = stageAt(run)
  const stopped = run.phase === 'paused' || run.phase === 'failed'
  const planned = run.tier === 'T2' || run.tier === 'T3'
  const fixing = run.phase === 'review' && !run.diff && run.strict?.status === 'fail'
  const fails = (run.verify || []).filter((r) => r.status === 'fail').length
  const passes = (run.verify || []).filter((r) => r.status === 'pass').length
  const done = run.phase === 'done'
  const stuck = (i: number): RailState | null => (stopped && at === i ? (run.phase === 'failed' ? 'fail' : 'ask') : null)

  const plan: RailState = run.plan?.status === 'approved' ? 'done' : hold?.kind === 'plan' ? 'ask' : stuck(1) || (run.phase === 'plan' ? 'live' : at > 1 ? 'done' : 'todo')
  const build: RailState = stuck(2) || (run.phase === 'build' || (fixing && live?.phase === 'build') ? 'live' : at > 2 ? 'done' : 'todo')
  const test: RailState = stuck(3) || (run.phase === 'verify' ? 'live' : at > 3 && fails ? 'fail' : at > 3 ? 'done' : 'todo')
  const review: RailState =
    hold?.kind === 'review' || hold?.kind === 'voice' ? 'ask' : stuck(4) || (run.strict?.status === 'pass' && !fixing ? 'done' : run.phase === 'review' ? 'live' : at > 4 ? 'done' : 'todo')
  const push: RailState = run.pushed ? 'done' : done && run.commitSha ? (run.pushError ? 'fail' : 'ask') : 'todo'

  const progress: NonNullable<Activity['progress']> = [
    ...(planned ? [{ label: 'Plan', state: plan }] : []),
    { label: 'Build', state: build, ...(fixing ? { note: 'fixing review gaps' } : {}) },
    { label: 'Test', state: test, ...(run.verify?.length ? { note: `${passes} passed${fails ? `, ${fails} failed` : ''}` } : {}) },
    { label: 'Review', state: review, ...(run.reviewCycles ? { note: `${run.reviewCycles} with gaps` } : {}) },
    { label: 'Push', state: push, ...(push === 'ask' ? { note: 'waiting on you' } : {}) }
  ]

  const busy = (phase: LiveCall['phase']) => (run.live || []).some((c) => c.phase === phase)
  const asks = run.asks
  const team: NonNullable<Activity['team']> = [
    { role: 'Lead', who: 'Grok 4.6', state: done || run.phase === 'abandoned' ? 'done' : 'live', note: hold ? 'waiting on you' : 'listening' },
    ...(planned ? [{ role: 'Planner', who: lastModel(run, 'plan', 'Opus'), state: busy('plan') ? ('live' as const) : plan === 'done' ? ('done' as const) : ('todo' as const), note: busy('plan') ? 'writing the plan' : plan === 'done' ? 'plan approved' : 'not yet' }] : []),
    { role: 'Builder', who: lastModel(run, 'build', run.builder || 'grok'), state: busy('build') ? 'live' : run.audit?.work.length ? 'done' : 'todo', note: busy('build') ? 'building' : `${run.audit?.work.length || 0} files changed` },
    { role: 'Tester', who: 'repo scripts', state: run.phase === 'verify' ? 'live' : fails ? 'fail' : run.verify?.length ? 'done' : 'todo', note: run.verify?.length ? `${passes} passed${fails ? `, ${fails} failed` : ''}` : 'not yet' },
    ...(strictRequired(run)
      ? [{ role: 'Reviewer', who: lastModel(run, 'review', 'Opus'), state: busy('review') ? ('live' as const) : run.strict?.status === 'pass' ? ('done' as const) : run.strict?.status === 'fail' ? ('fail' as const) : ('todo' as const), note: busy('review') ? 'reviewing' : run.strict ? `round ${(run.reviewCycles || 0) + (run.strict.status === 'pass' ? 1 : 0)}: ${run.strict.status}` : 'not yet' }]
      : []),
    ...(run.approver && run.approver !== 'off'
      ? [
          {
            role: 'Approver',
            who: APPROVER_NAME[run.approver],
            state: busy('approve') ? ('live' as const) : asks ? ('done' as const) : ('todo' as const),
            note: busy('approve') ? 'checking an ask' : asks ? `${asks.allowed} allowed${asks.denied ? `, ${asks.denied} refused` : ''}${asks.carded ? `, ${asks.carded} to you` : ''}` : 'no asks yet'
          }
        ]
      : [])
  ]

  const now: Activity['now'] = live
    ? { text: `${ROLE[live.phase]} · ${live.model}${live.effort ? ` ${live.effort}` : ''}`, since: live.since, tone: 'live' }
    : hold
      ? { text: hold.text, tone: 'ask' }
      : done
        ? { text: run.pushed ? 'Done and pushed.' : run.commitSha ? 'Done. Ready to push.' : 'Done.', tone: 'done' }
        : run.phase === 'abandoned'
          ? { text: 'Abandoned.', tone: 'idle' }
          : run.phase === 'review' && run.diff
            ? { text: 'Reviewed. Ready to commit.', tone: 'ask' }
            : { text: 'Working.', tone: 'idle' }

  const remote = run.profile?.publish.remote || 'origin'
  const ship: Activity['ship'] =
    done && run.commitSha
      ? run.pushed
        ? { line: `Pushed ${run.pushed.sha.slice(0, 7)} to ${run.pushed.remote}/${run.pushed.branch}.`, block: null, pushed: true }
        : {
            line: `Commit ${run.commitSha.slice(0, 7)}${run.branch ? ` on ${run.branch}` : ''}. Push sends it to ${remote}${run.branch ? `/${run.branch}` : ''}.`,
            block: pushBlock,
            pushed: false,
            ...(run.deployHint ? { deploy: run.deployHint.line } : {})
          }
      : undefined

  return { runId: run.id, now, progress, team, files: run.audit?.work || [], ...(ship ? { ship } : {}) }
}
