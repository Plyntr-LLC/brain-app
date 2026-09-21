import { useEffect, useRef, useState } from 'react'
import type { AiKind } from '@shared/contracts'
import { WorkPulse } from './WorkPulse'

type ToolNeed = {
  id: string
  label: string
  line: string
  present: boolean
  warn: string
  accept: string
}

type Status = {
  ready: boolean
  watching: boolean
  brainPath?: string | null
  items: ToolNeed[]
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function asReady(
  st: Status,
  extra: { ready?: boolean; watching?: boolean }
): { ready: boolean; watching: boolean; ai?: AiKind; brainPath?: string } {
  return {
    ready: extra.ready ?? st.ready,
    watching: extra.watching ?? st.watching,
    ai: pickAi(st.items),
    brainPath: st.brainPath || undefined
  }
}

function pickAi(items: ToolNeed[]): AiKind | undefined {
  const has = (id: string) => items.some((i) => i.id === id && i.present)
  if (has('grok')) return 'grok'
  if (has('claude')) return 'claude'
  if (has('cursor')) return 'cursor'
  if (has('gpt')) return 'gpt'
  return undefined
}

export function SetupNeeds({
  onReady,
  onNeedFolder
}: {
  onReady: (info: { ready: boolean; watching: boolean; ai?: AiKind; brainPath?: string }) => void
  onNeedFolder?: () => void
}) {
  const [items, setItems] = useState<ToolNeed[]>([])
  const [watching, setWatching] = useState(false)
  const [brainPath, setBrainPath] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [phase, setPhase] = useState<'review' | 'run'>('review')
  const [busyId, setBusyId] = useState('')
  const [busyLabel, setBusyLabel] = useState('')
  const [banner, setBanner] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const stop = useRef(false)
  const skipWait = useRef(false)

  useEffect(() => {
    stop.current = false
    void refresh()
    return () => {
      stop.current = true
    }
  }, [])

  useEffect(() => {
    if (phase !== 'run') {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [phase])

  async function refresh(): Promise<Status> {
    const st = await window.brain.setup.status()
    setItems(st.items)
    setWatching(st.watching)
    setBrainPath(st.brainPath || null)
    setLoaded(true)
    return st
  }

  async function pollUntil(test: (st: Status) => boolean, waiting: string): Promise<boolean> {
    for (let i = 0; i < 400; i++) {
      if (stop.current) return false
      const st = await refresh()
      if (test(st)) return true
      if (skipWait.current) {
        skipWait.current = false
        const again = await refresh()
        if (test(again)) return true
      }
      setNote(waiting)
      await sleep(1500)
    }
    return false
  }

  async function runOne(item: ToolNeed): Promise<void> {
    if (stop.current) return
    setBusyId(item.id)
    setBusyLabel(item.label)
    if (item.accept) {
      setBanner(`Coming up: ${item.accept}`)
      await sleep(700)
    } else {
      setBanner('')
    }
    setNote(`Installing ${item.label}…`)
    const r = await window.brain.setup.install(item.id)
    if (!r.ok) throw new Error(r.detail || `Could not install ${item.label}.`)
    setNote(r.detail || `${item.label} done.`)
    if (r.wait === 'present' || r.wait === 'watching') {
      setBanner(item.accept || `Finish ${item.label}, then this window continues.`)
      const ok = await pollUntil(
        (st) =>
          r.wait === 'watching'
            ? Boolean(st.watching)
            : Boolean(st.items.find((i) => i.id === item.id)?.present),
        r.wait === 'watching'
          ? 'Waiting on Agency Brain. Sign in there and pick the shared folder. We continue when it is watching.'
          : `Waiting on ${item.label}. ${item.accept || 'Finish that window, then we continue.'}`
      )
      await window.brain.setup.bringFront()
      if (stop.current) return
      if (!ok) {
        throw new Error(
          r.wait === 'watching'
            ? 'Agency Brain is not watching a folder yet. Finish sign-in there, then Recheck.'
            : `${item.label} is still missing. Finish that installer, then Start setup again.`
        )
      }
    }
  }

  async function start() {
    setErr('')
    setPhase('run')
    stop.current = false
    try {
      const first = await refresh()
      if (first.ready) {
        onReady(asReady(first, { ready: true, watching: Boolean(first.brainPath || first.watching) }))
        return
      }
      const missing = first.items.filter((i) => !i.present)
      const required = new Set(['brew', 'git', 'cloudflared'])
      for (const item of missing) {
        if (stop.current) {
          setPhase('review')
          setBusyId('')
          setBusyLabel('')
          setBanner('')
          return
        }
        try {
          await runOne(item)
        } catch (e) {
          if (required.has(item.id)) throw e
          setNote(String((e as Error).message || e))
        }
      }
      const st = await refresh()
      setBusyId('')
      setBusyLabel('')
      setBanner('')
      const ai = pickAi(st.items)
      if (!ai) {
        setPhase('review')
        setErr('Install Grok, Claude, Cursor, or ChatGPT. Chat needs one of them. Then Start setup again.')
        return
      }
      if (st.ready) {
        onReady(asReady(st, { ready: true, watching: Boolean(st.brainPath || st.watching) }))
        return
      }
      if ((st.brainPath || st.watching) && ai) {
        onReady(asReady(st, { ready: false, watching: Boolean(st.brainPath || st.watching) }))
        return
      }
      setPhase('review')
      if (!st.brainPath && !st.watching) {
        setErr('The shared folder is not on this computer yet. Finish GitHub, then Recheck.')
        return
      }
      setNote('Still missing a watched folder or an AI tool. Finish the open installer, then Start setup again.')
    } catch (e) {
      setPhase('review')
      setBusyId('')
      setBusyLabel('')
      setBanner('')
      setErr(String((e as Error).message || e))
    }
  }

  const missing = items.filter((i) => !i.present)
  const warns = missing.filter((i) => i.warn)
  const cliMissing = missing.some((i) => i.id === 'grok' || i.id === 'claude' || i.id === 'cursor' || i.id === 'gpt')
  const running = phase === 'run'

  return (
    <>
      <p className="kicker">This computer</p>
      <h1>{running ? 'Setting up this computer.' : 'One setup, then Chat.'}</h1>
      <p>
        We install what’s missing with the official installers. Nothing here spends money. Grok, Claude, Cursor, and ChatGPT
        still bill your own accounts when you sign in.
      </p>
      {banner ? <p className="note">{banner}</p> : null}
      {running ? <WorkPulse label={busyLabel ? `Installing ${busyLabel}` : 'Setting up'} seconds={waitSec} /> : null}
      {!running && loaded && (warns.length > 0 || cliMissing) ? (
        <div className="warn-box">
          <h3>Before we start: you will need to allow access</h3>
          {warns.length > 0 ? (
            <>
              <p>macOS, Windows, or the installer will ask. Accept those so setup can finish. We pause at each one.</p>
              <ol>
                {warns.map((i) => (
                  <li key={i.id}>
                    <strong>{i.label}.</strong> {i.warn}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {cliMissing ? (
            <p>
              The first time you chat, that AI may open a browser so you can sign in with your own account. Accept that
              sign-in if it appears.
            </p>
          ) : null}
        </div>
      ) : null}
      {!running && loaded && missing.length === 0 && !watching && !brainPath ? (
        <div className="warn-box">
          <h3>The shared folder is not on this computer yet</h3>
          <p>Finish GitHub (Only select repositories), then Recheck. This app copies the folder and keeps it in sync.</p>
        </div>
      ) : null}
      <ul className="setup-list">
        {items.map((n) => (
          <li key={n.id} className={n.present ? 'got' : busyId === n.id ? 'now' : ''}>
            <span>{n.present ? '✓' : busyId === n.id ? '·' : '○'}</span>
            <span>
              <strong>
                {n.label}
                {n.present ? ' · ready' : busyId === n.id ? ' · now' : ''}
              </strong>
              <span className="muted"> {n.line}</span>
            </span>
          </li>
        ))}
      </ul>
      {note ? <p className="tiny">{note}</p> : null}
      {err ? <p className="note">{err}</p> : null}
      <div className="actions">
        <button className="primary" type="button" disabled={running || !loaded} onClick={() => void start()}>
          {running ? (busyLabel ? `Installing ${busyLabel}…` : 'Setting up…') : 'Start setup'}
        </button>
        <button
          className="ghost"
          type="button"
          onClick={async () => {
            if (running) {
              skipWait.current = true
              return
            }
            const st = await refresh()
            const ai = pickAi(st.items)
            if (st.ready) onReady(asReady(st, { ready: true, watching: true }))
            else if (st.watching && ai) onReady(asReady(st, { ready: false, watching: true }))
            else setErr('Still missing a required piece. Finish the open installer, then Recheck.')
          }}
        >
          {running ? 'I finished that window' : 'Recheck'}
        </button>
        {running ? (
          <button
            className="linkish"
            type="button"
            onClick={() => {
              stop.current = true
              setPhase('review')
              setBusyId('')
              setBusyLabel('')
              setBanner('')
              setNote('Setup paused. Start setup again when you are ready.')
            }}
          >
            Pause
          </button>
        ) : null}
      </div>
    </>
  )
}
