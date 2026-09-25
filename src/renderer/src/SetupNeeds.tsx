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
  kind?: 'status' | 'install'
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
  extra: { ready?: boolean; watching?: boolean },
  wanted?: Record<string, boolean>
): { ready: boolean; watching: boolean; ai?: AiKind; brainPath?: string } {
  return {
    ready: extra.ready ?? st.ready,
    watching: extra.watching ?? st.watching,
    ai: pickAi(st.items, wanted),
    brainPath: st.brainPath || undefined
  }
}

const CLI_IDS = ['grok', 'claude', 'cursor', 'gpt']

function pickAi(items: ToolNeed[], wanted?: Record<string, boolean>): AiKind | undefined {
  const has = (id: string) => items.some((i) => i.id === id && i.present)
  const ok = (id: string) => has(id) && (wanted ? wanted[id] !== false : true)
  if (ok('grok')) return 'grok'
  if (ok('claude')) return 'claude'
  if (ok('cursor')) return 'cursor'
  if (ok('gpt')) return 'gpt'
  return undefined
}

export function SetupNeeds({
  onReady,
  onNeedFolder,
  onPick,
  picked,
  hideAgency
}: {
  onReady: (info: { ready: boolean; watching: boolean; ai?: AiKind; brainPath?: string }) => void | Promise<boolean | void>
  onNeedFolder?: () => void
  onPick?: (ai: AiKind) => void
  picked?: AiKind
  hideAgency?: boolean
}) {
  const [items, setItems] = useState<ToolNeed[]>([])
  const [wantCli, setWantCli] = useState<Record<string, boolean>>(() =>
    picked
      ? { grok: picked === 'grok', claude: picked === 'claude', cursor: picked === 'cursor', gpt: picked === 'gpt' }
      : { grok: false, claude: false, cursor: false, gpt: false }
  )
  const [watching, setWatching] = useState(false)
  const [brainPath, setBrainPath] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [phase, setPhase] = useState<'review' | 'run'>('review')
  const [busyId, setBusyId] = useState('')
  const [busyLabel, setBusyLabel] = useState('')
  const [banner, setBanner] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [said, setSaid] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const stop = useRef(false)
  const skipWait = useRef(false)

  const choice = CLI_IDS.find((id) => wantCli[id]) as AiKind | undefined
  const explainGen = useRef(0)

  useEffect(() => {
    setWantCli(
      picked
        ? { grok: picked === 'grok', claude: picked === 'claude', cursor: picked === 'cursor', gpt: picked === 'gpt' }
        : { grok: false, claude: false, cursor: false, gpt: false }
    )
  }, [picked])

  useEffect(() => {
    stop.current = false
    return () => {
      stop.current = true
    }
  }, [])

  useEffect(() => {
    void refresh(choice)
  }, [choice])

  useEffect(() => {
    const token = ++explainGen.current
    setSaid('')
    if (phase === 'run' || !choice) return
    let live = true
    void window.brain.ai.signedIn(choice).then((row) => {
      if (!live || token !== explainGen.current || !row.signedIn) return
      void window.brain.setup.explain({ heading: 'This computer', kinds: [choice], strip: false, token })
    })
    return () => {
      live = false
    }
  }, [choice, phase])
  useEffect(
    () =>
      window.brain.setup.onExplain((bit, token) => {
        setSaid((prev) => (token === explainGen.current ? prev + bit : prev))
      }),
    []
  )

  useEffect(() => {
    if (phase !== 'run') {
      setWaitSec(0)
      return
    }
    const t0 = Date.now()
    const t = setInterval(() => setWaitSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [phase])

  async function refresh(which: AiKind | undefined = choice): Promise<Status> {
    const st = await window.brain.setup.status(which)
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
    if (item.kind === 'status') {
      setBusyId(item.id)
      setBusyLabel(item.label)
      setNote(`Waiting on ${item.label}.`)
      const ok = await pollUntil((st) => Boolean(st.items.find((i) => i.id === item.id)?.present), `Waiting on ${item.label}.`)
      if (!ok) throw new Error(`${item.label} is not ready yet.`)
      return
    }
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
      const chosen = CLI_IDS.find((id) => wantCli[id]) as AiKind | undefined
      if (!chosen) {
        setErr('Pick Grok, Claude, Cursor, or ChatGPT.')
        return
      }
      const first = await refresh(chosen)
      const allow = new Set(['brew', 'git', 'cloudflared', chosen])
      const visible = hideAgency ? first.items.filter((item) => item.id !== 'ab') : first.items
      const gitReady = visible.some((item) => item.id === 'git' && item.present)
      const tunnelReady = visible.some((item) => item.id === 'cloudflared' && item.present)
      const chosenPresent = first.items.some((item) => item.id === chosen && item.present)
      const brewMissing = visible.some((item) => item.id === 'brew' && !item.present)
      if (first.ready && gitReady && tunnelReady && chosenPresent && !brewMissing) {
        const opened = await onReady(asReady(first, { ready: true, watching: Boolean(first.brainPath || first.watching) }, wantCli))
        if (opened === false) setPhase('review')
        return
      }
      const missing = visible.filter((item) => !item.present && allow.has(item.id))
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
      const st = await refresh(chosen)
      setBusyId('')
      setBusyLabel('')
      setBanner('')
      const ai = pickAi(st.items, wantCli)
      if (!ai) {
        setPhase('review')
        setErr('Install Grok, Claude, Cursor, or ChatGPT. Chat needs one of them. Then Start setup again.')
        return
      }
      const opened = await onReady(asReady(st, { ready: st.ready, watching: Boolean(st.brainPath || st.watching) }, wantCli))
      if (opened === false) setPhase('review')
      return
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setPhase('review')
      setBusyId('')
      setBusyLabel('')
      setBanner('')
    }
  }

  const missing = items.filter((i) => !i.present)
  const warns = missing.filter((i) => i.warn)
  const cliMissing = missing.some((i) => i.id === 'grok' || i.id === 'claude' || i.id === 'cursor' || i.id === 'gpt')
  const running = phase === 'run'

  const shown = hideAgency ? items.filter((item) => item.id !== 'ab') : items

  return (
    <div data-setup-screen="needs">
      <p className="kicker">This computer</p>
      <h1>{running ? 'Setting up this computer.' : 'One setup, then Chat.'}</h1>
      <p>
        We install what’s missing with the official installers. Nothing here spends money. Grok, Claude, Cursor, and ChatGPT
        still bill your own accounts when you sign in.
      </p>
      {said ? <p className="note">{said}</p> : null}
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
          {onNeedFolder ? (
            <p>
              <button type="button" className="linkish" onClick={() => onNeedFolder()}>
                Back to GitHub copy
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      {!running && loaded ? (
        <div className="warn-box">
          <h3>One AI for this setup</h3>
          <p>Pick one. Start setup installs that one, plus Git and Cloudflare Tunnel if they are missing.</p>
          {CLI_IDS.map((id) => {
            const row = items.find((i) => i.id === id)
            return (
              <label key={id} className="need-row">
                <input
                  type="radio"
                  name="setup-cli"
                  checked={wantCli[id] === true}
                  onChange={() => {
                    setWantCli({ grok: id === 'grok', claude: id === 'claude', cursor: id === 'cursor', gpt: id === 'gpt' })
                    onPick?.(id as AiKind)
                  }}
                />
                <span>
                  {row?.label || id}
                  {row?.present ? ' · already on this computer' : ''}
                </span>
              </label>
            )
          })}
        </div>
      ) : null}
      <ul className="setup-list">
        {shown.map((n) => (
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
            const ai = pickAi(st.items, wantCli)
            const abMissing = st.items.some((i) => i.id === 'ab' && !i.present)
            if (st.ready && !abMissing) onReady(asReady(st, { ready: true, watching: true }, wantCli))
            else if (st.watching && ai && st.brainPath) onReady(asReady(st, { ready: false, watching: true }, wantCli))
            else if (!st.brainPath && onNeedFolder) {
              setErr('The shared folder is not here yet. Use Back to GitHub copy, or finish GitHub in the browser.')
            } else setErr('Still missing a required piece. Finish the open installer, then Recheck.')
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
    </div>
  )
}
