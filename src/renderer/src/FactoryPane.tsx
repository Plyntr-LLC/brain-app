import { Fragment, useEffect, useRef, useState } from 'react'
import { APPROVER_NAME, APPROVERS, callCount, modelsLine, REVIEW_MAX, strictRequired, VOICE_MAX, type Approver, type FactoryTriage, type LiveCall, type RunPhase, type RunRecord } from '../../shared/factory'
import { applyFactoryText, showOutgoing, type Outgoing } from './guide-thread'
import type { Activity } from './activity'
import { factoryActivity } from './factory-activity'
import { threadItems } from './factory-thread'
import { FactoryThread } from './FactoryThread'

type Perm = { title?: string; path?: string; detail?: string; options?: { id: string; label: string }[]; tabId?: string; requestId?: string }

const ASK_CHOICE: Record<Approver, string> = { fable: 'Fable decides each ask', opus: 'Opus 5.5 decides each ask', off: 'No model: the card, or Approve in advance' }

/** "Fable decides asks · 12 allowed, 1 refused, 1 to you" */
function askChip(run: RunRecord): string {
  const a = run.asks
  const counts = a ? [`${a.allowed} allowed`, ...(a.denied ? [`${a.denied} refused`] : []), ...(a.carded ? [`${a.carded} to you`] : [])].join(', ') : ''
  return `${APPROVER_NAME[run.approver || 'off']} decides asks${counts ? ` · ${counts}` : ''}`
}
type FileHit = { path: string; tool?: string; live: boolean }

const BUILDER_NAME = { grok: 'Grok', cursor: 'Cursor Grok', opus: 'Opus' } as const

/** Live file list per run on the In use rail, same cap for every tier. */
const FILE_CAP = 40

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p
}

const STATUS_WORD: Partial<Record<RunPhase, string>> = {
  triage: 'checking',
  plan: 'planning',
  build: 'building',
  verify: 'testing',
  review: 'reviewing',
  commit: 'committing',
  paused: 'paused',
  upgrade: 'needs a decision',
  failed: 'failed',
  abandoned: 'abandoned',
  done: 'done'
}

/** "review · opus medium · 0:42" for a call in flight. */
function nowLine(c: LiveCall): string {
  const secs = Math.max(0, Math.floor((Date.now() - c.since) / 1000))
  return `Now: ${c.phase} · ${c.model}${c.effort ? ` ${c.effort}` : ''} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** "4 model calls, 182k tokens, 3m 10s" for the run header. */
function usageLine(rows: NonNullable<RunRecord['usage']>): string {
  const tokens = rows.reduce((n, r) => n + r.inTokens + r.outTokens + r.cacheRead + r.cacheWrite, 0)
  const secs = Math.round(rows.reduce((n, r) => n + r.ms, 0) / 1000)
  const t = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  const calls = callCount(rows)
  return `${calls} model call${calls === 1 ? '' : 's'}, ${t} tokens, ${time}`
}

export function FactoryPane(props: {
  id: string
  runId?: string
  cwd: string
  active: boolean
  onRun: (runId: string, title: string) => void
  /** This run's files go to the right In use rail, keyed by the Factory tab id. */
  onFiles: (id: string, files: FileHit[]) => void
  /** What the right rail shows for this run (null: no run yet, or the tab closed). */
  onActivity: (id: string, activity: Activity | null) => void
}) {
  const { id, runId, cwd, active, onRun, onFiles, onActivity } = props
  const [run, setRun] = useState<RunRecord | null>(null)
  const [task, setTask] = useState('')
  const [runThrough, setRunThrough] = useState(true)
  const [shipThrough, setShipThrough] = useState(true)
  const [approver, setApprover] = useState<Approver>('fable')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<Outgoing | null>(null)
  const [workRepo, setWorkRepo] = useState('')
  const [repoFrom, setRepoFrom] = useState('')
  const [repoError, setRepoError] = useState('')
  const [tri, setTri] = useState<FactoryTriage | null>(null)
  const [error, setError] = useState('')
  const [needsProceed, setNeedsProceed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState<Perm | null>(null)
  const [activity, setActivity] = useState('')
  const [work, setWork] = useState('')
  const [repoLine, setRepoLine] = useState('')
  const [voiceOn, setVoiceOn] = useState(false)
  const [reason, setReason] = useState('')
  const calls = run?.live || []
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!calls.length) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [calls.length])
  const [pushBlock, setPushBlock] = useState<string | null>(null)
  const [pushAnyway, setPushAnyway] = useState(false)
  const [deployBlock, setDeployBlock] = useState<string | null>(null)
  const [files, setFiles] = useState<FileHit[]>([])
  const runRef = useRef<string>(runId || '')
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  // In use follows this list; a closed tab leaves nothing behind.
  useEffect(() => {
    onFilesRef.current(id, files)
  }, [id, files])
  useEffect(() => () => onFilesRef.current(id, []), [id])

  // The right rail follows the run: Now, Progress, Team, Changed files, Ship.
  useEffect(() => {
    onActivityRef.current(id, run ? factoryActivity(run, pushBlock) : null)
  }, [id, run, pushBlock])
  useEffect(() => () => onActivityRef.current(id, null), [id])

  // The thread follows the newest line, the way Chat does.
  const lines = (run?.events?.length || 0) + (run?.guide?.length || 0) + (pending ? 1 : 0) + (pending?.ack ? 1 : 0)
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, run?.phase])

  useEffect(() => {
    runRef.current = runId || ''
    setFiles([])
    if (!runId) return
    void window.brain.factory.get(runId).then((r) => {
      if (r && 'id' in r) setRun(r)
    })
  }, [runId])

  useEffect(() => {
    return window.brain.factory.onEvent((e) => {
      if (!runRef.current || e.runId !== runRef.current) return
      if (e.kind === 'run') {
        setRun(e.run)
        if (e.run.phase !== 'build' && e.run.phase !== 'review') setPermission(null)
        // One T3 worker's done or error is not the end of the build: live clears when no builder turn can be running.
        if (e.run.phase !== 'build' && !(e.run.phase === 'review' && !e.run.diff)) setFiles((f) => (f.some((x) => x.live) ? f.map((x) => ({ ...x, live: false })) : f))
        return
      }
      if (e.kind === 'guide') {
        const ev = e.ev
        if (ev.kind === 'text' && ev.data) {
          setPending((p) => {
            if (!p) return p
            const next = applyFactoryText({ activity: '', guideAck: p.ack, raw: p.raw }, 'guide', ev.data || '')
            return { ...p, ack: next.guideAck, raw: next.raw }
          })
        }
        return
      }
      if (e.kind !== 'stream') return
      const ev = e.ev
      if (ev.kind === 'permission' && ev.clear) setPermission((p) => (p?.requestId === ev.requestId ? null : p))
      else if (ev.kind === 'permission') setPermission({ title: ev.title, path: ev.path, detail: ev.detail, options: ev.options, tabId: ev.tabId, requestId: ev.requestId })
      else if (ev.kind === 'text' && ev.data) setActivity((a) => applyFactoryText({ activity: a, guideAck: '' }, 'stream', ev.data || '').activity.slice(-1200))
      else if (ev.kind === 'status' && ev.data?.startsWith('work:')) setWork(ev.data.slice(5))
      else if (ev.kind === 'error' && ev.data) setWork(ev.data)
      if (ev.kind === 'file' && ev.path) {
        const hit: FileHit = { path: ev.path, tool: ev.tool, live: true }
        setFiles((f) => (f.length >= FILE_CAP || f.some((x) => x.path === hit.path) ? f : [...f, hit]))
      }
    })
  }, [])

  useEffect(() => {
    if (run || !task.trim()) {
      setTri(null)
      return
    }
    const t = window.setTimeout(() => {
      void window.brain.factory.triage(task).then(setTri)
    }, 250)
    return () => window.clearTimeout(t)
  }, [task, run])

  // The work repo comes from the task (a path or a Projects folder name), else the last Factory repo.
  useEffect(() => {
    if (run) return
    const t = window.setTimeout(() => {
      void window.brain.factory.resolveRepo(task, cwd).then((r) => {
        setWorkRepo(r.ok ? r.workRepo : '')
        setRepoFrom(r.ok ? r.from : '')
        setRepoError(r.ok ? '' : r.error)
      })
    }, 250)
    return () => window.clearTimeout(t)
  }, [task, cwd, run])

  useEffect(() => {
    if (run || !workRepo.trim()) {
      setRepoLine('')
      return
    }
    const t = window.setTimeout(() => {
      void window.brain.factory.profile(workRepo).then((r) => {
        if (!r.ok) return setRepoLine('')
        setRepoLine(r.line)
        setVoiceOn(r.profile.voice.on)
      })
    }, 250)
    return () => window.clearTimeout(t)
  }, [workRepo, run])

  const doneSha = run?.phase === 'done' ? run.commitSha || '' : ''
  const pushedAt = run?.pushed?.at || 0
  useEffect(() => {
    if (!run || !doneSha) {
      setPushAnyway(false)
      return setPushBlock(null)
    }
    void window.brain.factory.publishBlock(run.id).then((r) => setPushBlock(r.ok ? r.block : r.error))
    void window.brain.factory.publishAnywayFor(run.id).then((r) => setPushAnyway(r.ok ? r.offer : false))
  }, [run?.id, doneSha, pushedAt])

  const deployedAt = run?.deployed?.at || 0
  useEffect(() => {
    if (!run || !pushedAt) return setDeployBlock(null)
    void window.brain.factory.deployBlock(run.id).then((r) => setDeployBlock(r.ok ? r.block : r.error))
  }, [run?.id, pushedAt, deployedAt])

  async function toggleVoice(on: boolean) {
    setVoiceOn(on)
    const r = await window.brain.factory.saveProfile(workRepo, { voice: { on } })
    if (!r.ok) {
      setVoiceOn(!on)
      setError(r.error)
    } else setRepoLine(r.line)
  }

  async function start(proceedCritical = false) {
    setBusy(true)
    setError('')
    try {
      const res = await window.brain.factory.start({ task, brainPath: cwd, runThrough, shipThrough, proceedCritical, approver })
      if (res.ok) {
        runRef.current = res.run.id
        setRun(res.run)
        setActivity('')
        setFiles([])
        setNeedsProceed(false)
        onRun(res.run.id, res.run.title)
      } else {
        setError(res.error)
        setNeedsProceed(Boolean(res.needsProceed))
      }
    } finally {
      setBusy(false)
    }
  }

  async function act(p: Promise<{ ok: true; run: RunRecord | null } | { ok: false; error: string }>) {
    setError('')
    const res = await p
    if (!res.ok) setError(res.error)
    else if (res.run) setRun(res.run)
  }

  if (!run) {
    const critical = tri?.risk === 'critical'
    return (
      <div className={`factorywrap ${active ? 'on' : ''}`}>
        <div className="factory">
          <h3 className="factory-h">Factory</h3>
          <p className="tiny">
            Brain runs a change in a code repo, checks it, and commits it. Name the repo in the task (a path or the Projects folder name). Push and
            Deploy stay your click.
          </p>
          <label className="factory-field">
            <span>What should change?</span>
            <textarea value={task} rows={4} onChange={(e) => setTask(e.target.value)} placeholder="Fix the typo in the footer" />
          </label>
          {tri ? (
            <div className="factory-triage">
              <strong>
                {tri.size} · risk {tri.risk}
              </strong>
              <ul>
                {tri.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="tiny">
            Work repo: {workRepo ? <strong>{baseName(workRepo)}</strong> : repoError || '...'}
            {workRepo ? ` ${workRepo}` : ''}
          </p>
          {workRepo && repoFrom === 'last' ? <p className="tiny">Last Factory repo. Name the folder in the task if this is wrong.</p> : null}
          {repoLine ? <p className="tiny factory-repo-line">{repoLine}</p> : null}
          <p className="tiny">Brain: {cwd}</p>
          <div className="factory-checks">
            {repoLine ? (
              <label className="tiny">
                <input type="checkbox" checked={voiceOn} onChange={(e) => void toggleVoice(e.target.checked)} />
                <span>Voice check</span>
              </label>
            ) : null}
            <label className="tiny">
              <span aria-hidden="true" />
              <span>
                Asks:{' '}
                <select value={approver} onChange={(e) => setApprover(e.target.value as Approver)}>
                  {APPROVERS.map((a) => (
                    <option key={a} value={a}>
                      {ASK_CHOICE[a]}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="tiny">
              <input type="checkbox" checked={runThrough} onChange={(e) => setRunThrough(e.target.checked)} />
              <span>
                {approver === 'off' ? 'Approve in advance (plan, asks, and a clean Commit go ahead; never deploys)' : 'Approve in advance (plan and a clean Commit go ahead; never deploys)'}
              </span>
            </label>
            <label className="tiny">
              <input type="checkbox" checked={shipThrough} onChange={(e) => setShipThrough(e.target.checked)} />
              <span>
                Ship in advance: after an Opus review with no gaps, Brain commits and pushes. On its own it never pushes staging, prod, production, or Kennel main, master, and staging.
              </span>
            </label>
          </div>
          {error ? <p className="factory-err">{error}</p> : null}
          <div className="factory-actions">
            {critical || needsProceed ? (
              <button type="button" className="primary" disabled={busy || !task.trim()} onClick={() => void start(true)}>
                Proceed at {tri ? tri.size : 'T2'}
              </button>
            ) : (
              <button type="button" className="primary" disabled={busy || !task.trim()} onClick={() => void start(false)}>
                Start
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const live = run.phase !== 'done' && run.phase !== 'abandoned'
  const planWaiting = run.phase === 'plan' && run.plan?.status === 'waiting' && !!run.plan.text
  const planBlocked = run.phase === 'plan' && run.plan?.status === 'blocked' && !!run.plan.text
  const prepWaiting = run.phase === 'triage' && run.needsPrep === 'dirty'
  const running =
    run.phase === 'build' ||
    run.phase === 'verify' ||
    (run.phase === 'triage' && !run.needsProceed && !prepWaiting) ||
    (run.phase === 'plan' && !planWaiting && !planBlocked) ||
    (run.phase === 'review' && !run.diff)
  const waitLine =
    run.phase === 'triage' && !run.needsProceed && !prepWaiting
      ? 'Checking size and risk'
      : run.phase === 'plan' && !planWaiting && !planBlocked
        ? 'Opus is writing the plan'
        : run.phase === 'review' && !run.diff && run.note
          ? `${BUILDER_NAME[run.builder || 'grok']} is fixing: ${run.note.split('\n')[0].slice(0, 140)}`
          : run.phase === 'review' && !run.diff && run.tier === 'T1' && !run.selfChecked
            ? `${BUILDER_NAME[run.builder || 'grok']} is re-reading its diff`
            : run.phase === 'review' && !run.diff && strictRequired(run) && !run.strict
          ? 'Opus strict review running'
          : ''
  const strictHeld = run.phase === 'review' && !!run.diff && run.strict?.status === 'fail' && (run.reviewCycles || 0) >= REVIEW_MAX
  // The true count; runs saved before dirtyCount only kept the first 20 paths.
  const dirtyN = run.dirtyCount ?? run.dirtyFiles?.length ?? 0
  const dirtyLabel = run.dirtyCount === undefined && dirtyN >= 20 ? '20+' : String(dirtyN)
  const opusReviews = strictRequired(run)

  async function sendNote() {
    const text = note.trim()
    if (!text || !run) return
    setError('')
    setPending(showOutgoing(text))
    setNote('')
    const res = await window.brain.factory.conduct(run.id, text)
    if (!res.ok) {
      setPending(null)
      setNote((n) => (n.trim() ? n : text))
      setError(res.error)
      return
    }
    setPending(null)
    if (res.run) setRun(res.run)
  }
  const voiceHeld = run.voice?.status === 'fail'
  const items = threadItems(run, pending)
  return (
    <div className={`factorywrap run ${active ? 'on' : ''}`}>
      <div className="factory">
        <div className="factory-head">
          <div className="factory-titlerow">
            <h3 className="factory-h">{run.title}</h3>
            <div className="factory-headbtns">
              {running ? (
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.pause(run.id))}>
                  Pause
                </button>
              ) : null}
              {live ? (
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.abandon(run.id))}>
                  Abandon run
                </button>
              ) : null}
            </div>
          </div>
          <div className="factory-chips">
            <span className="fchip">
              {baseName(run.workRepo)}
              {run.branch ? ` · ${run.branch}` : ''}
            </span>
            <span className="fchip">
              {run.tier} · risk {run.risk}
            </span>
            <span className={`fchip status ${run.phase}`}>{STATUS_WORD[run.phase] || run.phase}</span>
            {run.runThrough ? <span className="fchip">Approve in advance</span> : null}
            {run.approver && run.approver !== 'off' ? <span className="fchip">{askChip(run)}</span> : null}
            {run.shipThrough ? <span className="fchip">{opusReviews ? 'Ship in advance' : 'Ship in advance waits for an Opus review'}</span> : null}
          </div>
          <p className="tiny factory-meta">
            Work repo: <strong>{baseName(run.workRepo)}</strong> {run.workRepo}
            {run.builder ? ` · Builder: ${BUILDER_NAME[run.builder]}` : ''}
            {run.usage?.length ? ` · ${usageLine(run.usage)}` : ''}
            {calls.map((c) => ` · ${nowLine(c)}`).join('')}
            {modelsLine(run.usage) ? ` · Models: ${modelsLine(run.usage)}` : ''}
          </p>
        </div>
        <div className="factory-body" ref={bodyRef}>
          <FactoryThread items={items} />
          {run.audit?.brain.length ? (
            <div className="factory-brain">
              <strong>Brain changed (not reverted)</strong>
              <ul>
                {run.audit.brain.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.phase === 'plan' && run.audit?.work.length ? <p className="factory-warn">The plan turn changed files.</p> : null}
          {run.verifyArtifact ? <p className="tiny factory-note">Verify output: {run.verifyArtifact}</p> : null}
          {run.pushWarn && !run.pushed ? <p className="tiny factory-note">{run.pushWarn}</p> : null}
          {run.moved ? <p className="tiny factory-note">{run.moved}</p> : null}
          {run.tripwire?.auto ? <p className="tiny factory-note">Moved to {run.tier} in advance: {run.tripwire.reasons.join(' ')}</p> : null}
          {run.tier === 'T3' && run.slices?.length ? (
            <details className="factory-slices">
              <summary>Split into {run.slices.length} jobs</summary>
              <ul>
                {run.slices.map((sl, i) => (
                  <li key={`${i}-${sl.title}`}>
                    {sl.title} <span className="tiny">{sl.files.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {running && (work || waitLine) ? (
            <div className="factory-liveline">
              <span className="dot live" />
              <span>{[waitLine, work].filter(Boolean).join(' · ')}</span>
            </div>
          ) : null}
          {permission ? (
            <div className="skin-perm factory-ask">
              <p className="skin-perm-title">{permission.title || 'Allow this?'}</p>
              {permission.path ? <p className="tiny">{permission.path}</p> : null}
              {permission.detail ? <pre className="skin-perm-detail">{permission.detail}</pre> : null}
              <div className="skin-perm-actions">
                {(permission.options?.length
                  ? permission.options
                  : [
                      { id: 'allowOnce', label: 'Allow' },
                      { id: 'skip', label: 'Skip' }
                    ]
                ).map((o, i) => (
                  <button
                    type="button"
                    key={o.id}
                    className={i === 0 ? 'primary' : 'ghost'}
                    onClick={() => {
                      void window.brain.skin.decide(permission.tabId || run.acpTab, o.id)
                      setPermission(null)
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {prepWaiting ? (
            <div className="factory-trip">
              <strong>
                This repo has uncommitted changes ({dirtyLabel} {dirtyN === 1 ? 'file' : 'files'}). Commit them first, or
                stash them, then Factory starts.
              </strong>
              {run.dirtyFiles?.length ? (
                <ul>
                  {run.dirtyFiles.slice(0, 8).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : null}
              <div className="factory-actions">
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'prep-commit'))}>
                  Commit first
                </button>
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'prep-stash'))}>
                  Stash first
                </button>
              </div>
            </div>
          ) : null}
          {run.phase === 'triage' && run.needsProceed ? (
            <div className="factory-trip">
              <strong>{run.triage.llm?.skipped ? 'Model triage did not answer' : `${run.triage.llm?.by === 'jev' ? 'Jev' : 'Grok'} says this is critical risk`}</strong>
              <ul>
                {run.triage.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="factory-actions">
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'proceed'))}>
                  Proceed at {run.tier}
                </button>
                {run.triage.llm?.skipped ? (
                  <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'retry-triage'))}>
                    Retry triage
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {planWaiting && run.plan ? (
            <div className="factory-plan factory-trip">
              <strong>
                {run.plan.unready
                  ? 'The planner did not say the plan is ready. Read it above, then approve it or re-plan with a reason.'
                  : `The plan by ${run.plan.by === 'opus' ? 'Opus' : 'Grok'} is above. Approve it, or reject it with a reason.`}
              </strong>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why reject? (optional)" spellCheck={false} />
              <div className="factory-actions">
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'approve-plan'))}>
                  Approve plan
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    const why = reason
                    setReason('')
                    void act(window.brain.factory.decide(run.id, 'reject-plan', why))
                  }}
                >
                  Reject
                </button>
              </div>
              <p className="tiny">Rejects: {run.plan.rejects} of 3</p>
            </div>
          ) : null}
          {planBlocked && run.plan ? (
            <div className="factory-plan factory-trip">
              <strong>The planner could not plan here. Its reason is above. Re-plan with a note, or abandon the run.</strong>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A note for the next plan (optional)" spellCheck={false} />
              <div className="factory-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const why = reason
                    setReason('')
                    void act(window.brain.factory.decide(run.id, 'reject-plan', why))
                  }}
                >
                  Re-plan
                </button>
              </div>
            </div>
          ) : null}
          {run.phase === 'upgrade' && run.tripwire ? (
            <div className="factory-trip">
              <strong>Over the {run.tier} limit</strong>
              <ul>
                {run.tripwire.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {!run.tripwire.suggest ? <p className="tiny">A lockfile or schema change. Trim the change or stop.</p> : null}
              {run.tripwire.suggest === 'T2' || run.tripwire.suggest === 'T3' ? (
                <p className="tiny">
                  Moving to {run.tripwire.suggest} skips the plan (the work is done) and adds the {run.tripwire.suggest} checks and Opus strict review.
                </p>
              ) : null}
              <div className="factory-actions">
                {run.tripwire.suggest ? (
                  <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'upgrade'))}>
                    Move to {run.tripwire.suggest}
                  </button>
                ) : null}
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'trim'))}>
                  Trim
                </button>
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'stop'))}>
                  Stop
                </button>
              </div>
            </div>
          ) : null}
          {strictHeld ? (
            <div className="factory-trip">
              <strong>{`Opus has not approved after ${REVIEW_MAX - 1} fixes. Gaps still count.`}</strong>
              <p className="tiny">
                Reviews so far: {run.reviewCycles}. Commit anyway is your call, not an Opus approval. Approve in advance and Ship in advance do not
                commit or push from here.
              </p>
              <div className="factory-actions">
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'keep-fix'))}>
                  Keep fixing
                </button>
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 're-review'))}>
                  Re-review
                </button>
                <button type="button" className="ghost" onClick={() => noteRef.current?.focus()}>
                  Guide
                </button>
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'trim'))}>
                  Trim
                </button>
                <button type="button" className="ghost" onClick={() => void act(window.brain.factory.pause(run.id))}>
                  Pause
                </button>
              </div>
            </div>
          ) : null}
          {run.followUps?.length ? (
            <div className="tiny factory-note">
              Follow-ups outside this change (not gaps):
              <ul>
                {run.followUps.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.phase === 'review' && run.diff ? (
            <div className="factory-trip factory-ready">
              <strong>
                {voiceHeld
                  ? run.voiceCycles && run.voiceCycles >= VOICE_MAX
                    ? `Voice has not approved after ${VOICE_MAX} fixes.`
                    : 'Voice check said REJECT. Fix the copy before Commit.'
                  : strictHeld
                    ? 'Commit anyway is your call.'
                    : 'Reviewed. Ready to commit.'}
              </strong>
              {voiceHeld && run.voice?.tail ? <pre className="fcard-body">{run.voice.tail}</pre> : null}
              <details className="factory-changes">
                <summary>See changes</summary>
                <pre className="factory-diff">{run.diff}</pre>
              </details>
              <div className="factory-actions">
                <button type="button" className="primary" disabled={voiceHeld} onClick={() => void act(window.brain.factory.commit(run.id))}>
                  {strictHeld ? 'Commit anyway' : 'Commit'}
                </button>
                {voiceHeld ? (
                  <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'fix-copy'))}>
                    Fix copy
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {run.phase === 'paused' || run.phase === 'failed' ? (
            <div className="factory-trip">
              <strong>{run.phase === 'failed' ? 'The run failed.' : 'The run is paused.'}</strong>
              {run.error ? <p className="factory-err">{run.error}</p> : null}
              <div className="factory-actions">
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.resume(run.id))}>
                  Resume
                </button>
              </div>
            </div>
          ) : run.error ? (
            <p className="factory-err">{run.error}</p>
          ) : null}
          {run.phase === 'done' && run.commitSha ? (
            <div className="factory-trip factory-ship">
              {run.shipHeld && !run.pushed ? <p className="factory-note">{run.shipHeld}</p> : null}
              {run.deployHint ? <p className="factory-deploy">{run.deployHint.line}</p> : null}
              {run.previewError ? <p className="factory-err">{run.previewError}</p> : null}
              <div className="factory-actions">
                {!run.pushed ? (
                  <>
                    <span className="tiny">
                      Committed {run.commitSha.slice(0, 7)}
                      {run.branch ? ` on ${run.branch}` : ''}. Not pushed.
                    </span>
                    <button type="button" className="primary" disabled={!!pushBlock} onClick={() => void act(window.brain.factory.publish(run.id))}>
                      Push
                    </button>
                    {pushAnyway && run.branch ? (
                      <button
                        type="button"
                        onClick={() => {
                          const kennel = /mykennel/i.test(run.workRepo)
                          const ask = `Brain normally never pushes ${run.branch}. Push this commit to ${run.profile?.publish.remote || 'origin'}/${run.branch}?${kennel ? ' Brain runs the Kennel gate first (a fresh Opus 5.5 medium review) and pushes only if it approves.' : ''}`
                          if (!window.confirm(ask)) return
                          void act(window.brain.factory.publishAnyway(run.id))
                        }}
                      >
                        {`Push to ${run.branch} anyway…`}
                      </button>
                    ) : null}
                    {pushBlock ? <span className="tiny">{pushBlock}</span> : null}
                    {run.deployHint && !run.preview ? (
                      <button type="button" className="ghost" onClick={() => void act(window.brain.factory.publishPreview(run.id))}>
                        Push a preview branch
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span className="tiny">
                    Committed {run.pushed.sha.slice(0, 7)}. Pushed to {run.pushed.remote}/{run.pushed.branch}.
                    {run.deployed ? ' Deployed.' : ''}
                  </span>
                )}
                {run.pushed && !run.deployed ? (
                  <>
                    <button type="button" className="primary" disabled={!!deployBlock} onClick={() => void act(window.brain.factory.deploy(run.id))}>
                      Deploy
                    </button>
                    {deployBlock ? <span className="tiny">{deployBlock}</span> : null}
                  </>
                ) : null}
                {run.deployError && !run.deployed ? <span className="factory-err">{run.deployError}</span> : null}
                {run.pushError && !run.pushed ? <span className="factory-err">{run.pushError}</span> : null}
              </div>
            </div>
          ) : null}
          {error ? <p className="factory-err">{error}</p> : null}
        </div>
        {live ? (
          <div className="factory-compose">
            <textarea
              ref={noteRef}
              value={note}
              rows={2}
              placeholder="Talk to the team: ask, redirect, add something, or say go"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void sendNote()
                }
              }}
            />
            <button type="button" className="primary" disabled={!note.trim()} onClick={() => void sendNote()}>
              Send
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
