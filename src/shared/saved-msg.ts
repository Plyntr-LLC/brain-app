/** A big paste folded into the message as a token; the body is what the CLI gets. */
export type Paste = { token: string; text: string }

export type SavedMsg = { who: 'me' | 'brain' | 'think' | 'sys'; text: string; pastes?: Paste[] }

/** What a chat tab saves of its thread: your messages, answers and notes (last 200), with your pastes. */
export function toSavedMsgs(list: { who: string; text: string; pastes?: Paste[] }[]): SavedMsg[] {
  return (list || [])
    .filter((m) => m.who === 'me' || m.who === 'brain' || m.who === 'sys')
    .slice(-200)
    .map((m) => {
      const who = m.who as SavedMsg['who']
      if (who === 'me' && m.pastes?.length) return { who, text: m.text, pastes: m.pastes.map(({ token, text }) => ({ token, text })) }
      return { who, text: m.text }
    })
}
