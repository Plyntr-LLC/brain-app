import { useEffect, useRef, useState } from 'react'
import type { FactoryTriage, RunPhase, RunRecord } from '../../shared/factory'

type Perm = { title?: string; path?: string; detail?: string; options?: { id: string; label: string }[] }

const RAIL: { key: RunPhase; label: string }[] = [
  { key: 'triage', label: 'Triage' },
  { key: 'plan', label: 'Plan' },
  { key: 'build', label: 'Build' },
  { key: 'verify', label: 'Verify' },
  { key: 'review', label: 'Review' },
  { key: 'commit', label: 'Commit' }
]

const STATUS_WORD: Partial<Record<RunPhase, string>> = {
  plan: 'plan',
  paused: 'paused',
  upgrade: 'needs a decision',
  failed: 'failed',
  abandoned: 'abandoned',
  done: 'done'
}

function railIndex(run: RunRecord): number {
  const at = run.phase === 'paused' || run.phase === 'failed' || run.phase === 'upgrade' ? run.resumePhase || 'build' : run.phase
  if (at === 'done' || at === 'commit') return 5
  if (at === 'upgrade') return 2
  const i = RAIL.findIndex((r) => r.key === at)
  return i < 0 ? 0 : i
}

export function FactoryPane(props: {
  id: string
  runId?: string
  cwd: string
  active: boolean
  onRun: (runId: string, title: string) => void
}) {
  const { runId, cwd, active, onRun } = props
  const [run, setRun] = useState<RunRecord | null>(null)
  const [task, setTask] = useState('')
  const [workRepo, setWorkRepo] = useState('')
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
  const [pushBlock, setPushBlock] = useState<string | null>(null)
  const runRef = useRef<string>(runId || '')

  useEffect(() => {
    runRef.current = runId || ''
    if (!runId) {
      void window.brain.factory.lastRepo().then((p) => setWorkRepo((cur) => cur || p || ''))
      return
    }
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
        return
      }
      const ev = e.ev
      if (ev.kind === 'permission') setPermission({ title: ev.title, path: ev.path, detail: ev.detail, options: ev.options })
      else if (ev.kind === 'text' && ev.data) setActivity((a) => (a + ev.data).slice(-1200))
      else if (ev.kind === 'status' && ev.data?.startsWith('work:')) setWork(ev.data.slice(5))
      else if (ev.kind === 'error' && ev.data) setWork(ev.data)
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
    if (!run || !doneSha) return setPushBlock(null)
    void window.brain.factory.publishBlock(run.id).then((r) => setPushBlock(r.ok ? r.block : r.error))
  }, [run?.id, doneSha, pushedAt])

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
      const res = await window.brain.factory.start({ task, workRepo, brainPath: cwd, proceedCritical })
      if (res.ok) {
        runRef.current = res.run.id
        setRun(res.run)
        setActivity('')
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
          <p className="tiny">Brain runs one small change in a code repo, checks it, and commits it when you say so. No push, no deploy.</p>
          <label className="factory-field">
            <span>What should change?</span>
            <textarea value={task} rows={4} onChange={(e) => setTask(e.target.value)} placeholder="Fix the typo in the footer" />
          </label>
          {tri ? (
            <div className="factory-triage">
              <strong>
                {tri.size} · risk {tri.risk}
              </strong>
              {tri.capped ? <p className="factory-warn">Capped at T2 in this version. Brain does the smallest safe slice.</p> : null}
              <ul>
                {tri.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <label className="factory-field">
            <span>Work repo</span>
            <div className="factory-repo">
              <input value={workRepo} onChange={(e) => setWorkRepo(e.target.value)} placeholder="/Users/you/Projects/site" spellCheck={false} />
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void window.brain.factory.pickRepo().then((p) => {
                    if (p) setWorkRepo(p)
                  })
                }
              >
                Choose folder
              </button>
            </div>
          </label>
          {repoLine ? (
            <div className="factory-repo-line">
              <span className="tiny">{repoLine}</span>
              <label className="tiny">
                <input type="checkbox" checked={voiceOn} onChange={(e) => void toggleVoice(e.target.checked)} /> Voice check
              </label>
            </div>
          ) : null}
          <p className="tiny">Brain: {cwd}</p>
          {error ? <p className="factory-err">{error}</p> : null}
          <div className="factory-actions">
            {critical || needsProceed ? (
              <button type="button" className="primary" disabled={busy || !task.trim() || !workRepo.trim()} onClick={() => void start(true)}>
                Proceed at {tri && tri.size !== 'T3' ? tri.size : 'T2'}
              </button>
            ) : (
              <button type="button" className="primary" disabled={busy || !task.trim() || !workRepo.trim()} onClick={() => void start(false)}>
                Start
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const idx = railIndex(run)
  const word = STATUS_WORD[run.phase]
  const live = run.phase !== 'done' && run.phase !== 'abandoned'
  const planWaiting = run.phase === 'plan' && run.plan?.status === 'waiting' && !!run.plan.text
  const running =
    run.phase === 'build' ||
    run.phase === 'verify' ||
    (run.phase === 'triage' && !run.needsProceed) ||
    (run.phase === 'plan' && !planWaiting) ||
    (run.phase === 'review' && !run.diff)
  const waitLine =
    run.phase === 'triage' && !run.needsProceed
      ? 'Checking size with Grok (up to 8 s)'
      : run.phase === 'plan' && !planWaiting
        ? run.plan && run.plan.rejects === 2
          ? 'Opus is writing the plan'
          : 'Grok is writing the plan'
        : run.phase === 'review' && !run.diff && (run.tier === 'T2' || run.risk !== 'none') && !run.strict
          ? 'Opus strict review running'
          : ''
  const strictHeld = run.strict?.status === 'fail' && (run.reviewCycles || 0) >= 2
  const voiceHeld = run.voice?.status === 'fail'
  return (
    <div className={`factorywrap ${active ? 'on' : ''}`}>
      <div className="factory">
        <h3 className="factory-h">{run.title}</h3>
        <div className="phaserail">
          {RAIL.map((r, i) => (
            <span
              key={r.key}
              className={
                r.key === 'plan' && run.tier !== 'T2'
                  ? 'phase past'
                  : `phase ${i === idx ? 'on' : ''} ${i < idx || run.phase === 'done' ? 'past' : ''}`
              }
            >
              {r.label}
            </span>
          ))}
          {word ? <span className={`phase-word ${run.phase}`}>{word}</span> : null}
          <span className="phase-chip">
            {run.tier} · risk {run.risk}
          </span>
        </div>
        <p className="tiny">Work repo: {run.workRepo}</p>
        {run.triage.capped ? <p className="factory-warn">Triage said {run.triage.original}. Capped at T2 in this version.</p> : null}
        {permission ? (
          <div className="skin-perm">
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
                    void window.brain.skin.decide(run.acpTab, o.id)
                    setPermission(null)
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {running && (work || activity || waitLine) ? (
          <div className="factory-activity">
            {waitLine ? <p className="tiny">{waitLine}</p> : null}
            {work ? <p className="tiny">{work}</p> : null}
            {activity ? <pre>{activity}</pre> : null}
          </div>
        ) : null}
        {run.phase === 'triage' && run.needsProceed ? (
          <div className="factory-trip">
            <strong>Grok says this is critical risk</strong>
            <ul>
              {run.triage.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="factory-actions">
              <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'proceed'))}>
                Proceed at {run.tier}
              </button>
            </div>
          </div>
        ) : null}
        {planWaiting && run.plan ? (
          <div className="factory-plan">
            <strong>Plan by {run.plan.by === 'opus' ? 'Opus' : 'Grok'}</strong>
            <pre>{run.plan.text}</pre>
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
        {run.phase === 'upgrade' && run.tripwire ? (
          <div className="factory-trip">
            <strong>Over the {run.tier} limit</strong>
            <ul>
              {run.tripwire.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {!run.tripwire.suggest ? <p className="tiny">T3 comes in a later version. Trim the change or stop.</p> : null}
            {run.tripwire.suggest === 'T2' ? <p className="tiny">Moving to T2 skips the plan (the work is done) and adds the T2 checks and Opus strict review.</p> : null}
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
        {run.audit ? (
          <div className="factory-audit">
            <strong>Work repo changes</strong>
            {run.phase === 'plan' && run.audit.work.length ? <p className="factory-warn">The plan turn changed files.</p> : null}
            {run.audit.work.length ? (
              <ul>
                {run.audit.work.map((w) => (
                  <li key={w.path}>
                    {w.path} <span className="tiny">+{w.added} -{w.deleted}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tiny">None yet.</p>
            )}
            {run.audit.brain.length ? (
              <div className="factory-brain">
                <strong>Brain changed (not reverted)</strong>
                <ul>
                  {run.audit.brain.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {run.verify?.length || run.strict || run.voice ? (
          <div className="factory-verify">
            {(run.verify || []).map((v) => (
              <div key={v.script} className={`verify-row ${v.status}`}>
                <span>npm run {v.script}</span>
                <span>{v.status}</span>
                {v.status === 'fail' && v.tail ? <pre>{v.tail}</pre> : null}
              </div>
            ))}
            {run.strict ? (
              <div className={`verify-row ${run.strict.status === 'missing' ? 'skipped' : run.strict.status}`}>
                <span>Opus strict review</span>
                <span>{run.strict.status === 'missing' ? 'skipped' : run.strict.status}</span>
                {run.strict.status === 'fail' ? <pre>{run.strict.text}</pre> : null}
                {run.strict.status === 'missing' ? <p className="tiny">{run.strict.text}</p> : null}
              </div>
            ) : null}
            {run.voice ? (
              <div className={`verify-row ${run.voice.status}`}>
                <span>Voice check</span>
                <span>{run.voice.status}</span>
                {run.voice.status === 'fail' && run.voice.tail ? <pre>{run.voice.tail}</pre> : null}
                {run.voice.status === 'skipped' && run.voice.tail ? <p className="tiny">{run.voice.tail}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {run.phase === 'review' && run.diff ? <pre className="factory-diff">{run.diff}</pre> : null}
        {run.error ? <p className="factory-err">{run.error}</p> : null}
        {error ? <p className="factory-err">{error}</p> : null}
        <div className="factory-actions">
          {run.phase === 'review' && run.diff ? (
            <button type="button" className="primary" disabled={voiceHeld} onClick={() => void act(window.brain.factory.commit(run.id))}>
              {strictHeld ? 'Commit anyway' : 'Commit'}
            </button>
          ) : null}
          {run.phase === 'review' && run.diff && voiceHeld ? (
            <>
              <button type="button" className="ghost" onClick={() => void act(window.brain.factory.decide(run.id, 'fix-copy'))}>
                Fix copy
              </button>
              <span className="tiny">Voice check said REJECT. Fix the copy before Commit.</span>
            </>
          ) : null}
          {running ? (
            <button type="button" className="ghost" onClick={() => void act(window.brain.factory.pause(run.id))}>
              Pause
            </button>
          ) : null}
          {run.phase === 'paused' || run.phase === 'failed' ? (
            <button type="button" className="primary" onClick={() => void act(window.brain.factory.resume(run.id))}>
              Resume
            </button>
          ) : null}
          {live ? (
            <button type="button" className="ghost" onClick={() => void act(window.brain.factory.abandon(run.id))}>
              Abandon run
            </button>
          ) : null}
          {run.phase === 'done' && run.commitSha && !run.pushed ? (
            <>
              <span className="tiny">
                Committed {run.commitSha.slice(0, 7)}
                {run.branch ? ` on ${run.branch}` : ''}. Not pushed.
              </span>
              <button type="button" className="primary" disabled={!!pushBlock} onClick={() => void act(window.brain.factory.publish(run.id))}>
                Push
              </button>
              {pushBlock ? <span className="tiny">{pushBlock}</span> : null}
            </>
          ) : null}
          {run.phase === 'done' && run.pushed ? (
            <span className="tiny">
              Committed {run.pushed.sha.slice(0, 7)}. Pushed to {run.pushed.remote}/{run.pushed.branch}.
            </span>
          ) : null}
          {run.phase === 'done' && run.pushError && !run.pushed ? <span className="factory-err">{run.pushError}</span> : null}
        </div>
      </div>
    </div>
  )
}
