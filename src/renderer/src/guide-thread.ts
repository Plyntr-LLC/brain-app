export type Outgoing = { text: string; ack: string; sent: true; at: number; raw?: string }

export function showOutgoing(text: string): Outgoing {
  return { text, ack: '', sent: true, at: 0 }
}

/** The pending line is in the thread until the saved note with the same text arrives. Then it is one bubble. */
export function visibleGuide<T extends { text: string }>(saved: T[], pending: Outgoing | null): (T | Outgoing)[] {
  if (!pending) return saved
  if (saved.some((g) => g.text === pending.text)) return saved
  return [...saved, pending]
}

const TELL_LINE = 'FACTORY_TELL:'

/** Drop a finished FACTORY_TELL line, and hold a trailing fragment that could still be one. */
export function hideTell(raw: string): string {
  const lines = raw.split('\n')
  const tail = lines.pop() ?? ''
  const done = lines.filter((line) => !line.startsWith(TELL_LINE))
  const hold = tail.startsWith(TELL_LINE) || (tail.length > 0 && TELL_LINE.startsWith(tail))
  return [...done, ...(hold ? [] : [tail])].join('\n').trim()
}

export function applyFactoryText(
  state: { activity: string; guideAck: string; raw?: string },
  kind: 'stream' | 'guide',
  data: string
): { activity: string; guideAck: string; raw?: string } {
  // guideAck is what the bubble shows. It drops a partial FACTORY_TELL line, so the next chunk joins raw.
  if (kind === 'guide') {
    const raw = (state.raw ?? state.guideAck) + data
    return { activity: state.activity, raw, guideAck: hideTell(raw) }
  }
  return { activity: state.activity + data, guideAck: state.guideAck, raw: state.raw }
}
