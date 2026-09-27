import { useEffect, useRef, useState } from 'react'
import type { FactoryTriage, RunPhase, RunRecord } from '../../shared/factory'

type Perm = { title?: string; path?: string; detail?: string; options?: { id: string; label: string }[] }

const RAIL: { key: RunPhase; label: string }[] = [
  { key: 'triage', label: 'Triage' },
  { key: 'build', label: 'Build' },
  { key: 'verify', label: 'Verify' },
  { key: 'review', label: 'Review' },
  { key: 'commit', label: 'Commit' }
]

const STATUS_WORD: Partial<Record<RunPhase, string>> = {
  paused: 'paused',
  upgrade: 'needs a decision',
  failed: 'failed',
  abandoned: 'abandoned',
  done: 'done'
}

function railIndex(run: RunRecord): number {
  const at = run.phase === 'paused' || run.phase === 'failed' || run.phase === 'upgrade' ? run.resumePhase || 'build' : run.phase
  if (at === 'done' || at === 'commit') return 4
  if (at === 'upgrade') return 1
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
              {tri.capped ? <p className="factory-warn">Capped at T1 in this version. Brain does the smallest safe slice.</p> : null}
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
          <p className="tiny">Brain: {cwd}</p>
          {error ? <p className="factory-err">{error}</p> : null}
          <div className="factory-actions">
            {critical || needsProceed ? (
              <button type="button" className="primary" disabled={busy || !task.trim() || !workRepo.trim()} onClick={() => void start(true)}>
                Proceed at T1
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
  const running = run.phase === 'build' || run.phase === 'verify' || run.phase === 'triage' || (run.phase === 'review' && !run.diff)
  return (
    <div className={`factorywrap ${active ? 'on' : ''}`}>
      <div className="factory">
        <h3 className="factory-h">{run.title}</h3>
        <div className="phaserail">
          {RAIL.map((r, i) => (
            <span key={r.key} className={`phase ${i === idx ? 'on' : ''} ${i < idx || run.phase === 'done' ? 'past' : ''}`}>
              {r.label}
            </span>
          ))}
          {word ? <span className={`phase-word ${run.phase}`}>{word}</span> : null}
          <span className="phase-chip">
            {run.tier} · risk {run.risk}
          </span>
        </div>
        <p className="tiny">Work repo: {run.workRepo}</p>
        {run.triage.capped ? <p className="factory-warn">Triage said {run.triage.original}. Capped at T1 in this version.</p> : null}
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
        {running && (work || activity) ? (
          <div className="factory-activity">
            {work ? <p className="tiny">{work}</p> : null}
            {activity ? <pre>{activity}</pre> : null}
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
            {!run.tripwire.suggest ? <p className="tiny">Bigger tiers come in a later version. Trim the change or stop.</p> : null}
            <div className="factory-actions">
              {run.tripwire.suggest ? (
                <button type="button" className="primary" onClick={() => void act(window.brain.factory.decide(run.id, 'upgrade'))}>
                  Move to T1
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
        {run.verify?.length ? (
          <div className="factory-verify">
            {run.verify.map((v) => (
              <div key={v.script} className={`verify-row ${v.status}`}>
                <span>npm run {v.script}</span>
                <span>{v.status}</span>
                {v.status === 'fail' && v.tail ? <pre>{v.tail}</pre> : null}
              </div>
            ))}
          </div>
        ) : null}
        {run.phase === 'review' && run.diff ? <pre className="factory-diff">{run.diff}</pre> : null}
        {run.error ? <p className="factory-err">{run.error}</p> : null}
        {error ? <p className="factory-err">{error}</p> : null}
        <div className="factory-actions">
          {run.phase === 'review' && run.diff ? (
            <button type="button" className="primary" onClick={() => void act(window.brain.factory.commit(run.id))}>
              Commit
            </button>
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
          {run.phase === 'done' && run.commitSha ? <span className="tiny">Committed {run.commitSha.slice(0, 7)}. Not pushed.</span> : null}
        </div>
      </div>
    </div>
  )
}
