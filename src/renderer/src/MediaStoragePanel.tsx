import { useEffect, useState } from 'react'
import { primeMediaLibrary } from './MediaLibraryPane'
import { canTurnOnGithubSync } from '@shared/contracts'
import {
  MEDIA_AUTO_STORE,
  MEDIA_LOST_COPY,
  computerLine,
  MEDIA_NOTES,
  MEDIA_OFF_KEYLESS,
  MEDIA_OFF_OTHER,
  MEDIA_OFF_OWNER,
  MEDIA_ON,
  MEDIA_PASS_COPY,
  MEDIA_PROJECT_WATCH,
  MEDIA_RECOVERY_COPY,
  mediaUsedLine,
  parseStorageGb,
  storageBytesToGb,
  storageEstimateLine,
  storageGbToBytes,
  type MediaStatus
} from '@shared/media'
import { ipcErrorText } from '@shared/plyntr-org-copy'

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
  onDone,
  onSeeFiles
}: {
  folder: string
  role?: string
  joe?: boolean
  onDone: (detail: string) => void
  onSeeFiles?: () => void
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
  const [lost, setLost] = useState(false)
  const [reclaimEmail, setReclaimEmail] = useState('')
  const [reclaimCode, setReclaimCode] = useState('')
  const [reclaimPass, setReclaimPass] = useState('')
  const [reclaimRec, setReclaimRec] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [removeId, setRemoveId] = useState('')
  const [computerName, setComputerName] = useState('')
  const [enableCode, setEnableCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [capGb, setCapGb] = useState('10')
  const [capTouched, setCapTouched] = useState(false)
  const canEnable = st?.hasSeatToken
    ? canTurnOnGithubSync(role, Boolean(joe))
    : canTurnOnGithubSync(role, false)

  async function refresh() {
    const next = await window.brain.media.status(folder)
    setSt(next)
    const gb = storageBytesToGb(next.capBytes)
    if (gb != null && !capTouched) setCapGb(String(gb))
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

  async function applyCap(gb: number) {
    await window.brain.media.setCap({ folder, capBytes: storageGbToBytes(gb) })
    await window.brain.media.turnOnBucket(folder)
  }

  async function saveCap() {
    const gb = parseStorageGb(capGb)
    if (gb == null) {
      setErr('Enter a whole number of GB, at least 1.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await applyCap(gb)
      setCapTouched(false)
      onDone(`Storage limit saved (${gb} GB).`)
      await refresh()
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function enable() {
    if (parseStorageGb(capGb) == null) {
      setErr('Enter a whole number of GB, at least 1.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await window.brain.media.enable({ folder, code: enableCode || undefined })
      if (res.needsCode) {
        setEnableCode('')
        setNeedCode(true)
        setErr(res.detail)
        return
      }
      if (!res.ok) {
        setErr(res.detail)
        await refresh()
        return
      }
      const pass = await window.brain.media.takePassphrase(folder)
      const rec = await window.brain.media.takeRecoveryKey(folder)
      setWords(pass || '')
      setRecovery(rec || '')
      setPhase('secrets')
      setNeedCode(false)
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
    const gb = parseStorageGb(capGb)
    if (gb == null) {
      setErr('Enter a whole number of GB, at least 1, then Save.')
      void refresh()
      return
    }
    setBusy(true)
    try {
      await applyCap(gb)
      setCapTouched(false)
      onDone(`Plyntr storage is on (${gb} GB).`)
    } catch (e) {
      setErr(ipcErrorText(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const builder = Boolean(canEnable)
  const picked = st.others.find((w) => w.deviceId === removeId)
  const computersBlock = (
    <>
      <label className="field">
        Computers
        <select
          value={removeId}
          onChange={(e) => {
            setRemoveId(e.target.value)
            setComputerName(st.others.find((w) => w.deviceId === e.target.value)?.label || '')
          }}
        >
          <option value="">Pick a computer</option>
          {st.others.map((w) => (
            <option key={w.deviceId} value={w.deviceId}>
              {computerLine(w)}
              {w.mine ? ' (this Mac)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Name
        <input value={computerName} onChange={(e) => setComputerName(e.target.value)} maxLength={40} />
      </label>
      <div className="actions tight">
        <button
          className="ghost"
          type="button"
          disabled={busy || !removeId || !computerName.trim()}
          onClick={() => {
            setBusy(true)
            void window.brain.media
              .renameDevice({ folder, deviceId: removeId, label: computerName })
              .then((res) => {
                onDone(res.detail)
                void refresh()
              })
              .catch((e) => setErr(ipcErrorText(e)))
              .finally(() => setBusy(false))
          }}
        >
          Save
        </button>
        <button
          className="ghost"
          type="button"
          disabled={busy || !picked || picked.mine}
          onClick={() => {
            setBusy(true)
            void window.brain.media
              .revokeDevice({ folder, deviceId: removeId })
              .then((res) => {
                onDone(res.detail)
                setRemoveId('')
                setComputerName('')
                void refresh()
              })
              .catch((e) => setErr(ipcErrorText(e)))
              .finally(() => setBusy(false))
          }}
        >
          Remove that computer
        </button>
      </div>
      {picked && !picked.mine ? (
        <p className="tiny">
          Remove that computer stops {computerLine(picked)} from opening files here. Other computers keep working.
        </p>
      ) : picked?.mine ? (
        <p className="tiny">This is the computer you are on. Remove it from another computer.</p>
      ) : null}
    </>
  )
  const lostBlock = builder ? (
    <>
      <div className="actions tight">
        <button className="ghost" type="button" onClick={() => setLost((v) => !v)}>
          Emergency restore
        </button>
      </div>
      {lost ? (
        <>
          <p className="tiny">{MEDIA_LOST_COPY}</p>
          <label className="field">
            Email
            <input value={reclaimEmail} onChange={(e) => setReclaimEmail(e.target.value)} />
          </label>
          <div className="actions tight">
            <button
              className="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                void window.brain.media.requestCode({ email: reclaimEmail }).then((res) => {
                  onDone(res.detail)
                })
              }}
            >
              Email me a code
            </button>
          </div>
          <label className="field">
            Code
            <input value={reclaimCode} onChange={(e) => setReclaimCode(e.target.value)} />
          </label>
          <label className="field">
            Passphrase
            <input value={reclaimPass} onChange={(e) => setReclaimPass(e.target.value)} type="password" />
          </label>
          <label className="field">
            Recovery key
            <input value={reclaimRec} onChange={(e) => setReclaimRec(e.target.value)} type="password" />
          </label>
          <div className="actions tight">
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void window.brain.media
                  .reclaim({
                    folder,
                    email: reclaimEmail,
                    code: reclaimCode,
                    passphrase: reclaimPass || undefined,
                    recovery: reclaimRec || undefined
                  })
                  .then((res) => {
                    onDone(res.detail)
                    setReclaimPass('')
                    setReclaimRec('')
                    setReclaimCode('')
                    void refresh()
                  })
                  .catch((e) => setErr(ipcErrorText(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Open storage on this computer
            </button>
          </div>
          {st.waiting[0] ? (
            <p className="tiny">New sign-in by email, not approved on a known Mac.</p>
          ) : null}
          <label className="field">
            Add a person
            <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          </label>
          <div className="actions tight">
            <button
              className="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                void window.brain.media
                  .invitePerson({ folder, email: inviteEmail })
                  .then((res) => {
                    onDone(res.detail)
                    if (res.ok) setInviteEmail('')
                  })
                  .catch((e) => setErr(ipcErrorText(e)))
              }}
            >
              Add
            </button>
          </div>
        </>
      ) : null}
    </>
  ) : null

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
      ) : !st.on && st.joining ? (
        <>
          <p>{st.detail}</p>
          {lostBlock}
          {err ? <p className="note">{err}</p> : null}
        </>
      ) : !st.on ? (
        <>
          <p>{builder ? MEDIA_OFF_OWNER : st.hasSeatToken ? MEDIA_OFF_OTHER : MEDIA_OFF_KEYLESS}</p>
          {builder ? (
            <>
              <label className="field">
                Storage limit (GB)
                <input
                  value={capGb}
                  onChange={(e) => {
                    setCapGb(e.target.value)
                    setCapTouched(true)
                  }}
                  inputMode="numeric"
                />
              </label>
              {parseStorageGb(capGb) != null ? (
                <p className="tiny">{storageEstimateLine(parseStorageGb(capGb) as number)}</p>
              ) : null}
              {needCode ? (
                <label className="field">
                  Email code
                  <input value={enableCode} onChange={(e) => setEnableCode(e.target.value)} />
                </label>
              ) : null}
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
          {onSeeFiles ? (
            <div className="actions tight">
              <button
                className="ghost"
                type="button"
                onClick={() => {
                  // Start the list now; the library tab picks it up and shows any failure there.
                  primeMediaLibrary(folder, window.brain.media.library({ folder }))
                  onSeeFiles()
                }}
              >
                See files
              </button>
            </div>
          ) : null}
          {!builder ? <p className="tiny">{MEDIA_PROJECT_WATCH}</p> : null}
          {builder ? <p className="tiny">{MEDIA_AUTO_STORE}</p> : null}
          {builder ? (
            <>
              <label className="field">
                Storage limit (GB)
                <input
                  value={capGb}
                  onChange={(e) => {
                    setCapGb(e.target.value)
                    setCapTouched(true)
                  }}
                  inputMode="numeric"
                />
              </label>
              {parseStorageGb(capGb) != null ? (
                <p className="tiny">{storageEstimateLine(parseStorageGb(capGb) as number)}</p>
              ) : null}
              <div className="actions tight">
                <button className="ghost" type="button" disabled={busy} onClick={() => void saveCap()}>
                  Save
                </button>
              </div>
            </>
          ) : null}
          {builder
            ? st.waiting.map((w) => (
                <div className="set-row" key={w.deviceId}>
                  <span>
                    Waiting: {w.name} · {computerLine(w)} · {w.project || 'brain'}
                  </span>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      void window.brain.media
                        .allow({ folder, deviceId: w.deviceId })
                        .then((res) => {
                          onDone(res.detail)
                          void refresh()
                        })
                        .catch((e) => setErr(ipcErrorText(e)))
                    }}
                  >
                    Allow
                  </button>
                </div>
              ))
            : null}
          {st.fingerprint ? <p className="tiny">This Mac: {st.fingerprint}.</p> : null}
          {builder ? computersBlock : null}
          {lostBlock}
          {err ? <p className="note">{err}</p> : null}
        </>
      )}
    </div>
  )
}
