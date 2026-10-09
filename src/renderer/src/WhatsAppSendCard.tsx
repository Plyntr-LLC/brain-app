import type { ReactNode } from 'react'
import type { WhatsAppSendAsk } from '@shared/desk'

export type SendCardState = WhatsAppSendAsk & { at: number; state: 'waiting' | 'sending' | 'sent' | 'not-sent'; note?: string; chat?: string }

/** A WhatsApp message an agent drafted. Nothing goes until the person presses Send here. */
export function WhatsAppSendCard(props: { card: SendCardState; onAnswer: (yes: boolean) => void }): ReactNode {
  const c = props.card
  const outcome =
    c.state === 'sending' ? 'Sending…' : c.state === 'sent' ? `Sent to ${c.chat || c.to}.` : c.state === 'not-sent' ? (c.note ? `Not sent: ${c.note}` : 'Not sent.') : ''
  return (
    <div className="skin-perm wa-send-card">
      <p className="skin-perm-title">
        WhatsApp ({c.account}) to {c.to}
      </p>
      <pre className="skin-perm-detail wa-send-text">{c.text}</pre>
      {c.state === 'waiting' ? (
        <div className="skin-perm-actions">
          <button type="button" className="primary" onClick={() => props.onAnswer(true)}>
            Send
          </button>
          <button type="button" className="ghost" onClick={() => props.onAnswer(false)}>
            Don't send
          </button>
        </div>
      ) : (
        <p className="tiny wa-send-outcome">{outcome}</p>
      )}
    </div>
  )
}
