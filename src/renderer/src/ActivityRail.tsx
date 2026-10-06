import { useEffect, useState } from 'react'
import type { Activity, RailState } from './factory-activity'

const FILES_SHOWN = 6

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Mark({ state }: { state: RailState }) {
  return <span className={`rail-mark ${state}`} aria-label={state} />
}

/** The right rail: what the run is doing now, where it is, who is on it, what changed, and Push. */
export function ActivityRail({ activity, onPush }: { activity: Activity; onPush?: () => void }) {
  const { now, progress, team, files, ship } = activity
  const [, setTick] = useState(0)
  const [allFiles, setAllFiles] = useState(false)
  useEffect(() => {
    if (!now.since) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [now.since])
  const added = files.reduce((n, f) => n + f.added, 0)
  const deleted = files.reduce((n, f) => n + f.deleted, 0)
  return (
    <div className="activity-rail">
      <section className={`rail-box rail-now ${now.tone}`}>
        <h5>Now</h5>
        <p className="rail-now-text">{now.text}</p>
        {now.since ? <p className="rail-sub">{elapsed(now.since)}</p> : null}
      </section>
      <section className="rail-box">
        <h5>Progress</h5>
        {progress.map((p) => (
          <div key={p.label} className={`rail-row ${p.state}`}>
            <Mark state={p.state} />
            <span className="rail-label">{p.label}</span>
            {p.note ? <span className="rail-note">{p.note}</span> : null}
          </div>
        ))}
      </section>
      <section className="rail-box">
        <h5>Team</h5>
        {team.map((m) => (
          <div key={m.role} className={`rail-row team ${m.state}`}>
            <span className={`who w-${m.role.toLowerCase()}`}>{m.role[0]}</span>
            <span className="rail-who">
              <span className="rail-label">{m.role}</span>
              <span className="rail-note">
                {m.who} · {m.note}
              </span>
            </span>
            <Mark state={m.state} />
          </div>
        ))}
      </section>
      {files.length ? (
        <section className="rail-box rail-files">
          <h5>
            Changed · {files.length} {files.length === 1 ? 'file' : 'files'} <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
          </h5>
          {(allFiles ? files : files.slice(0, FILES_SHOWN)).map((f) => (
            <div key={f.path} className="rail-file" title={f.path}>
              <span className="rail-path">{f.path}</span>
              <span className="plus">+{f.added}</span>
            </div>
          ))}
          {!allFiles && files.length > FILES_SHOWN ? (
            <button type="button" className="rail-more" onClick={() => setAllFiles(true)}>
              {files.length - FILES_SHOWN} more
            </button>
          ) : null}
        </section>
      ) : null}
      {ship ? (
        <section className="rail-box rail-ship">
          <h5>Ship</h5>
          <p className="rail-sub">{ship.line}</p>
          {ship.pushed ? null : (
            <>
              <button type="button" className="primary" disabled={!!ship.block || !onPush} onClick={() => onPush?.()}>
                Push
              </button>
              {ship.block ? <p className="rail-sub rail-block">{ship.block}</p> : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}
