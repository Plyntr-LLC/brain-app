import type { RunEvent, RunRecord, VerifyRow } from '../../shared/factory'
import { visibleGuide, type Outgoing } from './guide-thread'

export type Role = 'joe' | 'lead' | 'planner' | 'builder' | 'tester' | 'reviewer'

/** One line of the Factory thread. Joe and the Lead talk in bubbles; the other roles post cards. */
export type ThreadItem = {
  key: string
  at: number
  role: Role
  /** A bubble's text, or a card's one-line title. */
  text: string
  /** A card's muted second line (model, seconds). */
  meta?: string
  /** A card's folded body (plan, review, failing output, file list). */
  body?: string
  tone?: 'ok' | 'fail' | 'info'
  /** The body shows without a click: the plan Joe is asked to approve right now. */
  open?: boolean
  /** Joe's note waits for the next brief. */
  queued?: boolean
}

const name = (p: string) => p.split('/').filter(Boolean).pop() || p
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function testCard(rows: VerifyRow[]): Pick<ThreadItem, 'text' | 'meta' | 'body' | 'tone'> {
  const pass = rows.filter((r) => r.status === 'pass')
  const fail = rows.filter((r) => r.status === 'fail')
  const skip = rows.filter((r) => r.status === 'skipped')
  const ran = pass.length + fail.length
  const text = !ran ? 'No checks ran' : fail.length ? `${fail.length} failed, ${pass.length} passed` : `${plural(pass.length, 'check')} passed`
  const meta = [...pass.map((r) => `${r.script} passed`), ...fail.map((r) => `${r.script} failed`), ...skip.map((r) => `No ${r.script} script`)].join(' · ')
  const body = fail.map((r) => `npm run ${r.script}\n${r.tail || ''}`.trim()).join('\n\n') || undefined
  return { text, meta, body, tone: fail.length ? 'fail' : ran ? 'ok' : 'info' }
}

/** The Lead's repo line, with how the repo was picked so a wrong pick is plain at once. */
function repoLine(e: Extract<RunEvent, { kind: 'repo' }>): string {
  const head = `${e.moved ? 'Moved to' : 'Working in'} ${name(e.repo)} (${e.repo}).`
  if (e.planner) return `${head} The planner said the code is there.`
  if (e.moved) return head
  if (e.from === 'title') return `${head} "${e.word}" in your task is ${name(e.repo)}'s name.`
  if (e.from === 'path' || e.from === 'project' || e.from === 'given') return `${head} You named it.`
  if (e.from === 'name') return `${head} Picked from "${e.word}" in your task. Say the right one if it is wrong.`
  if (e.from === 'last') return `${head} No repo was named in the task, so this is the last Factory repo. Say the right one if it is wrong.`
  return head
}

/** The plan waiting on Joe's Approve stays open, with its full text; every other plan folds. */
const onScreen = (run: RunRecord) => run.phase === 'plan' && (run.plan?.status === 'waiting' || run.plan?.status === 'blocked') && !!run.plan.text

function fromEvent(e: RunEvent, i: number, run: RunRecord, lastPlan: number): ThreadItem {
  const key = `e${i}`
  switch (e.kind) {
    case 'repo':
      return { key, at: e.at, role: 'lead', text: repoLine(e) }
    case 'plan':
      return {
        key,
        at: e.at,
        role: 'planner',
        text: e.status === 'approved' ? 'Plan approved' : e.status === 'blocked' ? 'Could not plan here' : 'Plan ready',
        meta: e.by === 'opus' ? 'Opus' : 'Grok',
        tone: e.status === 'approved' ? 'ok' : e.status === 'blocked' ? 'fail' : 'info',
        // The newest plan event is the plan on screen: its event text is cut at 6000, run.plan has it all.
        ...(i === lastPlan && e.status !== 'approved' && onScreen(run) ? { open: true, body: run.plan?.text } : { body: e.text || undefined })
      }
    case 'turn':
      return {
        key,
        at: e.at,
        role: 'builder',
        text: e.files ? `Changed ${plural(e.files, 'file')}  +${e.added} −${e.deleted}` : 'Changed nothing',
        meta: `${e.model || 'builder'} · ${Math.max(1, Math.round(e.ms / 1000))}s${e.ok ? '' : ' · the turn ended with an error'}`,
        body: e.paths.join('\n') || undefined,
        tone: !e.ok ? 'fail' : e.files ? 'ok' : 'info'
      }
    case 'test':
      return { key, at: e.at, role: 'tester', ...testCard(e.rows) }
    case 'review':
      return {
        key,
        at: e.at,
        role: 'reviewer',
        text: `Round ${e.round}: ${e.status === 'pass' ? 'pass' : e.status === 'fail' ? 'gaps found' : 'reviewer missing'}`,
        meta: 'Opus strict review',
        body: e.text || undefined,
        tone: e.status === 'pass' ? 'ok' : e.status === 'fail' ? 'fail' : 'info'
      }
    case 'voice':
      return { key, at: e.at, role: 'reviewer', text: `Voice check: ${e.status}`, body: e.text || undefined, tone: e.status === 'pass' ? 'ok' : e.status === 'fail' ? 'fail' : 'info' }
    case 'commit':
      return { key, at: e.at, role: 'lead', text: `Committed ${e.sha.slice(0, 7)}${e.branch ? ` on ${e.branch}` : ''}.` }
    case 'push':
      if (e.ok && e.text.endsWith(' (preview)')) {
        const host = run.deployHint?.host
        return { key, at: e.at, role: 'lead', text: `Pushed a preview to ${e.text.slice(0, -' (preview)'.length)}.${host ? ` ${host} builds it.` : ''}` }
      }
      return { key, at: e.at, role: 'lead', text: e.ok ? `Pushed to ${e.text}.` : `Push failed: ${e.text}` }
    case 'deploy':
      return { key, at: e.at, role: 'lead', text: e.ok ? 'Deployed.' : `Deploy failed: ${e.text}` }
    case 'hold':
      return { key, at: e.at, role: 'lead', text: e.text }
    case 'end':
      return { key, at: e.at, role: 'lead', text: e.phase === 'done' ? 'Done.' : 'Abandoned.' }
  }
}

/** A run saved before events: the same cards from its current fields. */
function fromFields(run: RunRecord): ThreadItem[] {
  const start = run.createdAt
  const end = run.updatedAt || run.createdAt
  const out: ThreadItem[] = [{ key: 'f-repo', at: start, role: 'lead', text: `Working in ${name(run.workRepo)} (${run.workRepo}).` }]
  if (run.plan?.text) {
    out.push({
      key: 'f-plan',
      at: run.plan.approvedAt || start,
      role: 'planner',
      text: run.plan.status === 'approved' ? 'Plan approved' : run.plan.status === 'blocked' ? 'Could not plan here' : 'Plan ready',
      meta: run.plan.by === 'opus' ? 'Opus' : 'Grok',
      body: run.plan.text,
      tone: run.plan.status === 'approved' ? 'ok' : run.plan.status === 'blocked' ? 'fail' : 'info',
      ...(onScreen(run) ? { open: true } : {})
    })
  }
  const work = run.audit?.work || []
  if (run.audit) {
    out.push({
      key: 'f-build',
      at: end,
      role: 'builder',
      text: work.length ? `Changed ${plural(work.length, 'file')}  +${work.reduce((n, w) => n + w.added, 0)} −${work.reduce((n, w) => n + w.deleted, 0)}` : 'Changed nothing',
      body: work.map((w) => w.path).join('\n') || undefined,
      tone: work.length ? 'ok' : 'info'
    })
  }
  if (run.verify?.length) out.push({ key: 'f-test', at: end, role: 'tester', ...testCard(run.verify) })
  if (run.strict) out.push({ key: 'f-review', at: end, role: 'reviewer', text: `Review: ${run.strict.status === 'pass' ? 'pass' : run.strict.status === 'fail' ? 'gaps found' : 'reviewer missing'}`, meta: 'Opus strict review', body: run.strict.text || undefined, tone: run.strict.status === 'pass' ? 'ok' : run.strict.status === 'fail' ? 'fail' : 'info' })
  if (run.commitSha) out.push({ key: 'f-commit', at: end, role: 'lead', text: `Committed ${run.commitSha.slice(0, 7)}${run.branch ? ` on ${run.branch}` : ''}.` })
  if (run.pushed) out.push({ key: 'f-push', at: end, role: 'lead', text: `Pushed to ${run.pushed.remote}/${run.pushed.branch}.` })
  else if (run.pushError) out.push({ key: 'f-push', at: end, role: 'lead', text: `Push failed: ${run.pushError}` })
  return out
}

/**
 * The Factory thread: Joe's notes and the Lead's replies, then what the team did, in time order. The
 * line Joe just sent (pending) is always last, with the reply streaming under it.
 */
export function threadItems(run: RunRecord, pending: Outgoing | null): ThreadItem[] {
  const events = run.events || []
  const lastPlan = events.map((e) => e.kind).lastIndexOf('plan')
  const team = events.length ? events.map((e, i) => fromEvent(e, i, run, lastPlan)) : fromFields(run)
  const saved = run.guide || []
  const talk: ThreadItem[] = []
  saved.forEach((g, i) => {
    talk.push({ key: `j${i}`, at: g.at, role: 'joe', text: g.text, ...(g.sent ? {} : { queued: true }) })
    if (g.ack) talk.push({ key: `l${i}`, at: g.at + 1, role: 'lead', text: g.ack })
  })
  const items = [...team, ...talk].sort((a, b) => a.at - b.at)
  const shown = visibleGuide(saved, pending)
  if (pending && shown[shown.length - 1] === pending) {
    items.push({ key: 'pending', at: Number.MAX_SAFE_INTEGER, role: 'joe', text: pending.text })
    if (pending.ack) items.push({ key: 'pending-ack', at: Number.MAX_SAFE_INTEGER, role: 'lead', text: pending.ack })
  }
  return items
}
