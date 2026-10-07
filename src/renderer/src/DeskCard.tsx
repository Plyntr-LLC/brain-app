import type { JSX, ReactNode } from 'react'
import { CLI_LABEL, ME, type DeskMessage } from '@shared/desk'

/**
 * One Desk message as one card, from the Cards table. The store folds tiles and groups browse steps
 * before this sees the list. Sentences come from `msg.text`; the card does not build them.
 */

const SHORT = 80

/** "9:14": local time, hour without a leading zero. Empty when the stamp does not parse. */
function clock(iso?: string): string {
  const t = Date.parse(String(iso || ''))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function stamp(word: string, iso?: string): string {
  const t = clock(iso)
  return t ? `${word} · ${t}` : word
}

function oneLine(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function firstSentence(text: string): string {
  const flat = oneLine(text)
  return flat.match(/^.*?[.!?](?=\s|$)/)?.[0] || flat
}

/** A refusal is stored as its own sentence ("Couldn't find Pricing.") and shows as is. */
function sentence(detail: string): boolean {
  return detail.includes('.') || detail.startsWith("Couldn't")
}

function stepLine(step: { action: string; detail: string; url: string }): string {
  const detail = String(step.detail || '').trim()
  switch (step.action) {
    case 'url':
      return `Opened ${step.url || detail}`
    case 'click':
      return sentence(detail) ? detail : `Clicked ${detail}`
    case 'type':
      return !detail.includes(' | ') && sentence(detail) ? detail : `Typed into ${detail.split(' | ')[0]}`
    case 'scroll':
      return 'Scrolled'
    case 'press':
      return sentence(detail) ? detail : 'Pressed Enter'
    default:
      return detail
  }
}

const EDGE = /^([("'`[<]*)(.*?)([)"'`\]>.,;:!?]*)$/

/** Text with each path token (has a slash, not a URL) as a button that opens it. */
function withPaths(text: string, open: (path: string) => void): ReactNode[] {
  return String(text || '').split(/(\s+)/).map((part, i) => {
    const m = part.match(EDGE)
    const core = m?.[2] || ''
    if (!m || !core.includes('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(core)) return part
    return (
      <span key={i}>
        {m[1]}
        <button type="button" className="linkish" onClick={() => open(core)}>{core}</button>
        {m[3]}
      </span>
    )
  })
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </>
  )
}

function Card(props: { tone?: 'ok' | 'fail' | 'info'; title?: string; body?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`fcard ${props.tone || 'info'}`}>
      {props.title ? <div className="fcard-title">{props.title}</div> : null}
      {props.body != null ? <div className="fcard-body">{props.body}</div> : null}
      {props.actions ? (
        <div className="fcard-body">
          <div className="actions tight">{props.actions}</div>
        </div>
      ) : null}
    </div>
  )
}

/** Send and Not now on an email or a text. Sent wins; Not sent keeps Send while it can still go. */
function tileActions(t: { actedAt?: string; sent?: 'yes' | 'no'; canSend: boolean; onAnswer: (sent: 'yes' | 'no') => void }): ReactNode {
  if (t.actedAt) return <span className="tiny">{stamp('Sent', t.actedAt)}</span>
  const send = (
    <button type="button" className="primary" disabled={!t.canSend} onClick={() => t.onAnswer('yes')}>
      Send
    </button>
  )
  if (t.sent === 'no') {
    return (
      <>
        {send}
        <span className="tiny">Not sent</span>
      </>
    )
  }
  return (
    <>
      {send}
      <button type="button" className="ghost" onClick={() => t.onAnswer('no')}>
        Not now
      </button>
    </>
  )
}

export function DeskCard(props: {
  msg: DeskMessage
  names: Record<string, string>
  onOpenFile: (path: string) => void
  onHoldAnswer: (msgId: string, answer: 'yes' | 'no') => void
  onSend: (msgId: string, sent: 'yes' | 'no') => void
  onRetry: (msgId: string) => void
  onKeepWaiting: (botId: string) => void
  onStop: (botId: string) => void
  onContinueJob: (job: string) => void
  onStopJob: (job: string) => void
  onTalk: (botId: string) => void
  onOpenLog: () => void
  onOpenMemory: (botId: string) => void
  onOpenBrowser: (opts?: { signIn?: boolean }) => void
  onRemoveHire: (msgId: string) => void
  busy: boolean
}): JSX.Element {
  const { msg } = props
  const name = (id: string) => props.names[id] || (id === ME ? 'You' : 'Someone')
  const from = name(msg.from)
  const to = name(msg.to)
  const retry = Array.isArray(msg.inputs) && msg.inputs.length > 0

  switch (msg.kind) {
    case 'task':
      return <Card title={from} body={msg.text} />

    case 'reply':
      return <Card title={from} body={msg.text} />

    case 'pack': {
      const files = msg.pack?.files || []
      const dropped = msg.pack?.dropped || []
      return (
        <Card
          title={`${from} → ${to} · Briefing`}
          body={
            <>
              <div>{firstSentence(msg.text)}</div>
              {msg.pack?.why ? <div>Why: {msg.pack.why}</div> : null}
              {files.length ? <div>{`Reading ${files.length} ${files.length === 1 ? 'file' : 'files'}`}</div> : null}
              {files.map((f) => (
                <div key={f.path}>
                  <button type="button" className="linkish" onClick={() => props.onOpenFile(f.path)}>{f.path}</button>
                </div>
              ))}
              {dropped.length ? <div className="tiny">Couldn't find: {dropped.join(', ')}</div> : null}
            </>
          }
        />
      )
    }

    case 'send': {
      const flat = oneLine(msg.text)
      const short = flat.length > SHORT ? `${flat.slice(0, SHORT)}…` : flat
      return (
        <details className="fcard info">
          <summary className="fcard-title">{`${from} → ${to}: ${short}`}</summary>
          <div className="fcard-body">{withPaths(msg.text, props.onOpenFile)}</div>
        </details>
      )
    }

    case 'hold': {
      const answer = msg.hold?.answer
      const actions =
        answer === 'no' ? (
          <span className="tiny">Not approved</span>
        ) : msg.actedAt ? (
          <span className="tiny">{stamp('Approved', msg.actedAt)}</span>
        ) : (
          <>
            <button type="button" className="primary" onClick={() => props.onHoldAnswer(msg.id, 'yes')}>Approve</button>
            <button type="button" className="ghost" onClick={() => props.onHoldAnswer(msg.id, 'no')}>Not now</button>
          </>
        )
      return <Card title={from} body={msg.text} actions={actions} />
    }

    case 'email': {
      const e = msg.email
      if (!e) return <Card title={from} body={msg.text} />
      return (
        <Card
          title={from}
          body={
            <>
              {e.replyTo ? <div className="tiny">Reply</div> : null}
              <div>From: {e.from}</div>
              <div>To: {e.to}</div>
              {String(e.cc || '').trim() ? <div>Cc: {e.cc}</div> : null}
              <div>Subject: {e.subject}</div>
              <div>{e.body}</div>
              {e.note ? <div className="tiny">{e.note}</div> : null}
            </>
          }
          actions={tileActions({ actedAt: msg.actedAt, sent: e.sent, canSend: e.sendable, onAnswer: (sent) => props.onSend(msg.id, sent) })}
        />
      )
    }

    case 'text': {
      const t = msg.textMsg
      if (!t) return <Card title={from} body={msg.text} />
      return (
        <Card
          title={from}
          body={
            <>
              <div>To: {t.chatLabel || t.to}</div>
              <div>Via: {t.via}</div>
              <div>{t.body}</div>
              {t.note ? <div className="tiny">{t.note}</div> : null}
            </>
          }
          actions={tileActions({
            actedAt: msg.actedAt,
            sent: t.sent,
            canSend: t.sendable && t.via !== 'WhatsApp',
            onAnswer: (sent) => props.onSend(msg.id, sent)
          })}
        />
      )
    }

    case 'report': {
      const minutes = Math.max(0, Math.round((msg.report?.seconds || 0) / 60))
      return (
        <Card
          tone="ok"
          title={`${from} · Done · ${minutes}m`}
          body={msg.text}
          actions={
            <>
              <button type="button" className="ghost" onClick={() => props.onOpenLog()}>Open the log</button>
              <button type="button" className="ghost" onClick={() => props.onTalk(msg.from)}>Talk to {from}</button>
            </>
          }
        />
      )
    }

    case 'note':
      return (
        <Card
          title={`${from} saved a note`}
          body={msg.noteLines?.length ? <Lines lines={msg.noteLines} /> : msg.text}
          actions={<button type="button" className="ghost" onClick={() => props.onOpenMemory(msg.from)}>Open memory</button>}
        />
      )

    case 'hire': {
      const h = msg.hire
      return (
        <Card
          title={`${from} added ${h?.name || 'Someone'}`}
          body={
            h ? (
              <>
                <div>{h.description}</div>
                <div>App: {CLI_LABEL[h.cli] || h.cli}</div>
                <div>Model: {h.model === 'default' ? 'Default' : h.model}</div>
              </>
            ) : (
              msg.text
            )
          }
          actions={
            <button type="button" className="ghost" disabled={props.busy} onClick={() => props.onRemoveHire(msg.id)}>
              Remove
            </button>
          }
        />
      )
    }

    case 'browse': {
      const b = msg.browse
      const only = !b || b.signIn || b.noChrome
      return (
        <Card
          title={`${from} in the desk browser`}
          body={
            only ? (
              msg.text
            ) : (
              <>
                <Lines lines={b.steps.map(stepLine)} />
                {b.title ? <div className="tiny">{b.title}</div> : null}
              </>
            )
          }
          actions={b?.windowOpen ? <button type="button" className="ghost" onClick={() => props.onOpenBrowser(b.signIn ? { signIn: true } : undefined)}>Open browser</button> : null}
        />
      )
    }

    case 'status':
      return <Card title="Where things stand" body={<Lines lines={String(msg.text || '').split('\n').filter((l) => l.trim())} />} />

    case 'error':
      return (
        <Card
          tone="fail"
          title={`${from} couldn't finish`}
          body={
            <>
              <div>{msg.text}</div>
              {msg.detail ? (
                <details>
                  <summary className="tiny">Details</summary>
                  <div className="tiny">{msg.detail}</div>
                </details>
              ) : null}
            </>
          }
          actions={retry ? <button type="button" className="ghost" onClick={() => props.onRetry(msg.id)}>Try again</button> : null}
        />
      )

    case 'stopped':
      return (
        <Card
          title={`${from} stopped`}
          body={msg.text}
          actions={retry ? <button type="button" className="ghost" onClick={() => props.onRetry(msg.id)}>Run again</button> : null}
        />
      )

    case 'system': {
      const job = msg.job
      const actions =
        msg.system === 'slow' ? (
          <>
            <button type="button" className="ghost" onClick={() => props.onKeepWaiting(msg.from)}>Keep waiting</button>
            <button type="button" className="ghost" onClick={() => props.onStop(msg.from)}>Stop</button>
          </>
        ) : msg.system === 'loop' && job ? (
          <>
            <button type="button" className="ghost" onClick={() => props.onContinueJob(job)}>Let them continue</button>
            <button type="button" className="ghost" onClick={() => props.onStopJob(job)}>Stop them</button>
          </>
        ) : null
      return <Card body={msg.text} actions={actions} />
    }

    default:
      return <Card title={from} body={msg.text} />
  }
}
