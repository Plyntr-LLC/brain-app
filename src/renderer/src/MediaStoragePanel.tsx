import { useEffect, useState } from 'react'
import { canTurnOnGithubSync } from '@shared/contracts'
import {
  MEDIA_NOTES,
  MEDIA_OFF_KEYLESS,
  MEDIA_OFF_OTHER,
  MEDIA_OFF_OWNER,
  MEDIA_ON,
  MEDIA_PASS_COPY,
  MEDIA_PROJECT_WATCH,
  MEDIA_RECOVERY_COPY,
  mediaUsedLine,
  type MediaStatus
} from '@shared/media'
import { ipcErrorText } from '@shared/plyntr-org-copy'
import { WorkPulse } from './WorkPulse'

export function MediaAdminFields({
  folder,
  onDone
}: {
  folder: string
  onDone: (detail: string) => void
}) {
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    let dead = false
    void window.brain.media.status(folder).then((st) => {
      if (!dead) setHidden(!st.routes)
    }).catch(() => {
      if (!dead) setHidden(true)
    })
    return () => {
      dead = true
    }
  }, [folder])

  if (hidden || !window.brain.media) return null

  async function saveCap() {
    const gb = Number(cap)
    if (!Number.isFinite(gb) || gb <= 0) {
      onDone('Enter a storage limit in GB.')
      return
    }
    setBusy(true)
    try {
      await window.brain.media.setCap({ folder, capBytes: Math.round(gb * 1024 * 1024 * 1024) })
      onDone(`Storage limit saved (${gb} GB).`)
    } catch (e) {
      onDone(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function turnOn() {
    setBusy(true)
    try {
      const res = await window.brain.media.turnOnBucket(folder)
      onDone(res.bucket ? 'Storage for this brain is on.' : 'Storage for this brain is on.')
    } catch (e) {
      onDone(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <label className="field">
        Storage limit (GB)
        <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" />
      </label>
      <div className="actions tight">
        <button className="ghost" type="button" disabled={busy} onClick={() => void saveCap()}>
          Save
        </button>
        <button className="primary" type="button" disabled={busy} onClick={() => void turnOn()}>
          Turn on storage for this brain
        </button>
      </div>
    </>
  )
}

export function MediaStoragePanel({
  folder,
  role,
  joe,
  onDone
}: {
  folder: string
  role?: string
  joe?: boolean
  onDone: (detail: string) => void
}) {
  const [st, setSt] = useState<MediaStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'secrets'>('idle')
  const [words, setWords] = useState('')
  const [recovery, setRecovery] = useState('')
  const [own, setOwn] = useState('')
  const [own2, setOwn2] = useState('')
  const [saved, setSaved] = useState(false)
  const [root, setRoot] = useState('')
  const [lost, setLost] = useState(false)
  const canEnable = canTurnOnGithubSync(role, Boolean(joe))

  async function refresh() {
    const next = await window.brain.media.status(folder)
    setSt(next)
    if (next.projects[0] && !root) setRoot(next.projects[0].root)
    return next
  }

  useEffect(() => {
    let dead = false
    void refresh().catch((e) => {
      if (!dead) setErr(ipcErrorText(e))
    })
    return () => {
      dead = true
    }
  }, [folder])

  if (!st) return null
  if (!st.routes) return null

  async function enable() {
    setBusy(true)
    setErr('')
    try {
      await window.brain.media.enable({ folder })
      const pass = await window.brain.media.takePassphrase(folder)
      const rec = await window.brain.media.takeRecoveryKey(folder)
      setWords(pass || '')
      setRecovery(rec || '')
      setPhase('secrets')
      await refresh()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function finishSecrets() {
    if (!saved) {
      setErr('Check the box after you save both.')
      return
    }
    if (own || own2) {
      if (own !== own2) {
        setErr('Type the same passphrase twice.')
        return
      }
      try {
        await window.brain.media.setPassphrase({ folder, passphrase: own })
      } catch (e) {
        setErr(ipcErrorText(e))
        return
      }
    }
    setWords('')
    setRecovery('')
    setOwn('')
    setOwn2('')
    setSaved(false)
    setPhase('idle')
    onDone('Plyntr storage is on.')
    void refresh()
  }

  async function addFile() {
    if (!root) {
      setErr('Pick a project.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await window.brain.media.add({ folder, root })
      if (!res.ok) setErr(res.detail)
      else onDone(res.detail)
      await refresh()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  const builder = canEnable && st.hasSeatToken

  return (
    <div className="set-block" data-media-block="1">
      <h3 className="set-h">Videos and images</h3>
      {phase === 'secrets' ? (
        <>
          <p>{MEDIA_PASS_COPY}</p>
          {words ? <p><code>{words}</code></p> : null}
          <div className="actions tight">
            <button
              className="ghost"
              type="button"
              onClick={() => {
                if (words) void navigator.clipboard?.writeText(words)
              }}
            >
              Copy
            </button>
          </div>
          <label className="field">
            Use your own
            <input value={own} onChange={(e) => setOwn(e.target.value)} type="password" />
          </label>
          <label className="field">
            Type it again
            <input value={own2} onChange={(e) => setOwn2(e.target.value)} type="password" />
          </label>
          <p>{MEDIA_RECOVERY_COPY}</p>
          {recovery ? <p><code>{recovery}</code></p> : null}
          <div className="actions tight">
            <button
              className="ghost"
              type="button"
              onClick={() => {
                if (recovery) void navigator.clipboard?.writeText(recovery)
              }}
            >
              Copy
            </button>
          </div>
          <label className="tiny">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved both
          </label>
          {err ? <p className="note">{err}</p> : null}
          <div className="actions tight">
            <button className="primary" type="button" onClick={() => void finishSecrets()}>
              Done
            </button>
          </div>
        </>
      ) : !st.on ? (
        <>
          <p>{!st.hasSeatToken ? MEDIA_OFF_KEYLESS : builder ? MEDIA_OFF_OWNER : MEDIA_OFF_OTHER}</p>
          {builder ? (
            <>
              <div className="actions tight">
                <button className="primary" type="button" disabled={busy} onClick={() => void enable()}>
                  {busy ? 'Turning on…' : 'Use Plyntr storage'}
                </button>
              </div>
              <p className="tiny">{MEDIA_NOTES}</p>
            </>
          ) : null}
          {err ? <p className="note">{err}</p> : null}
        </>
      ) : (
        <>
          <p>{MEDIA_ON}</p>
          <p className="tiny">{mediaUsedLine(st)}</p>
          {!builder ? <p className="tiny">{MEDIA_PROJECT_WATCH}</p> : null}
          {builder && st.projects.length ? (
            <>
              <label className="field">
                Project
                <select value={root} onChange={(e) => setRoot(e.target.value)}>
                  {st.projects.map((p) => (
                    <option key={p.root} value={p.root}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions tight">
                <button className="primary" type="button" disabled={busy} onClick={() => void addFile()}>
                  Add a video or image
                </button>
              </div>
              {busy ? <WorkPulse label="Uploading" /> : null}
            </>
          ) : null}
          {builder
            ? st.waiting.map((w) => (
                <div className="set-row" key={w.deviceId}>
                  <span>
                    Waiting: {w.name} · Mac {w.fingerprint} · {w.project || 'brain'}
                  </span>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      void window.brain.media.allow({ folder, deviceId: w.deviceId }).then((res) => {
                        onDone(res.detail)
                        void refresh()
                      })
                    }}
                  >
                    Allow
                  </button>
                </div>
              ))
            : null}
          {st.fingerprint ? <p className="tiny">This Mac: {st.fingerprint}.</p> : null}
          {builder ? (
            <>
              <div className="actions tight">
                <button className="ghost" type="button" onClick={() => setLost((v) => !v)}>
                  This computer is lost
                </button>
              </div>
              {lost ? (
                <p className="tiny">
                  On a new computer, ask for an email code, then type your passphrase or recovery key.
                </p>
              ) : null}
            </>
          ) : null}
          {err ? <p className="note">{err}</p> : null}
        </>
      )}
    </div>
  )
}
