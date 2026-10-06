import { useEffect, useState } from 'react'
import type { Activity, RailState } from './activity'

const FILES_SHOWN = 6

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function clock(at: number): string {
  const d = new Date(at)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Mark({ state }: { state: RailState }) {
  return <span className={`rail-mark ${state}`} aria-label={state} />
}

/**
 * The right rail: what the tab is doing now and what it did. Sections show when the activity has them:
 * Progress, Team and Ship for a Factory run; Plan and Done so far for a chat. openFile, when given,
 * makes a chat's file line a link (a file outside the open folder stays a plain line).
 */
export function ActivityRail({
  activity,
  onPush,
  openFile
}: {
  activity: Activity
  onPush?: () => void
  openFile?: { open: (path: string) => void; canOpen: (path: string) => boolean }
}) {
  const { now, progress, steps, team, log, files, ship } = activity
  const [, setTick] = useState(0)
  const [allFiles, setAllFiles] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  useEffect(() => {
    if (!now.since) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [now.since])
  const added = files.reduce((n, f) => n + (f.added || 0), 0)
  const deleted = files.reduce((n, f) => n + (f.deleted || 0), 0)
  const counted = files.some((f) => f.added !== undefined)
  const showFiles = !activity.filesFolded || filesOpen
  // Only a chat's files open: a Factory run's paths are inside its work repo, not this folder.
  const opener = activity.filesFolded ? openFile : undefined
  return (
    <div className="activity-rail">
      <section className={`rail-box rail-now ${now.tone}`}>
        <h5>Now</h5>
        <p className="rail-now-text">{now.text}</p>
        {now.since ? <p className="rail-sub rail-timer">{elapsed(now.since)}</p> : null}
      </section>
      {progress?.length ? (
        <section className="rail-box rail-progress">
          <h5>Progress</h5>
          {progress.map((p) => (
            <div key={p.label} className={`rail-row ${p.state}`}>
              <Mark state={p.state} />
              <span className="rail-label">{p.label}</span>
              {p.note ? <span className="rail-note">{p.note}</span> : null}
            </div>
          ))}
        </section>
      ) : null}
      {steps?.length ? (
        <section className="rail-box rail-steps">
          <h5>Plan</h5>
          {steps.map((s, i) => (
            <div key={`${i}-${s.title}`} className={`rail-row ${s.state}`}>
              <Mark state={s.state} />
              <span className="rail-label">{s.title}</span>
            </div>
          ))}
        </section>
      ) : null}
      {team?.length ? (
        <section className="rail-box rail-team">
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
      ) : null}
      {log?.length ? (
        <section className="rail-box rail-log">
          <h5>Done so far</h5>
          {log.map((l, i) => (
            <div key={`${i}-${l.at}`} className="rail-logline">
              <span className="rail-time">{clock(l.at)}</span>
              <span className="rail-logtext">{l.text}</span>
            </div>
          ))}
        </section>
      ) : null}
      {files.length ? (
        <section className="rail-box rail-files">
          {activity.filesFolded ? (
            <button type="button" className="rail-fold" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
              <h5>Files · {files.length}</h5>
            </button>
          ) : (
            <h5>
              Changed · {files.length} {files.length === 1 ? 'file' : 'files'}
              {counted ? (
                <>
                  {' '}
                  <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
                </>
              ) : null}
            </h5>
          )}
          {showFiles
            ? (allFiles ? files : files.slice(0, FILES_SHOWN)).map((f) =>
                opener?.canOpen(f.path) ? (
                  <button key={f.path} type="button" className={`rail-file link${f.live ? ' live' : ''}`} title={f.path} onClick={() => opener.open(f.path)}>
                    <span className="rail-path">{f.path}</span>
                  </button>
                ) : (
                  <div key={f.path} className={`rail-file${f.live ? ' live' : ''}`} title={f.path}>
                    <span className="rail-path">{f.path}</span>
                    {f.added !== undefined ? <span className="plus">+{f.added}</span> : null}
                  </div>
                )
              )
            : null}
          {showFiles && !allFiles && files.length > FILES_SHOWN ? (
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
