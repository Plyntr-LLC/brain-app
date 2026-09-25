import { isHiddenStreamKind, isProtocolNoise } from './skin/hidden-kinds.ts'

export type ThreadMsg = {
  who: string
  text?: string
  steps?: unknown[]
  rawKind?: string
  skinLabel?: string | null
}

/** A real thread row. Hidden protocol between thoughts does not count. */
export function splitsThinking(m: ThreadMsg): boolean {
  if (m.who === 'me' || m.who === 'err') return true
  if (m.who === 'plan' && Array.isArray(m.steps) && m.steps.length > 0) return true
  if (m.who === 'sys' && String(m.text || '').trim()) return true
  if (m.who === 'brain') {
    const text = String(m.text || '')
    return Boolean(text.trim()) && !isProtocolNoise(text)
  }
  if (m.who === 'raw') {
    const text = String(m.text || '')
    if (!text.trim() || m.skinLabel === 'ignore') return false
    if (isHiddenStreamKind(m.rawKind || '') || isProtocolNoise(text)) return false
    return true
  }
  return false
}

export function appendThought<T extends ThreadMsg>(messages: T[], bit: string): T[] {
  const next = messages.slice()
  for (let i = next.length - 1; i >= 0; i--) {
    const row = next[i]
    if (row.who === 'think') {
      next[i] = { ...row, text: String(row.text || '') + bit }
      return next
    }
    if (splitsThinking(row)) break
  }
  next.push({ who: 'think', text: bit } as T)
  return next
}

/** Join think rows that sit next to each other, including across hidden rows. */
export function collapseAdjacentThinks<T extends ThreadMsg>(messages: T[]): T[] {
  const out: T[] = []
  for (const row of messages) {
    if (row.who !== 'think') {
      out.push(row)
      continue
    }
    let prevAt = -1
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].who === 'think') {
        prevAt = i
        break
      }
      if (splitsThinking(out[i])) break
    }
    if (prevAt < 0) {
      out.push(row)
      continue
    }
    const prev = out[prevAt]
    const prior = String(prev.text || '')
    const extra = String(row.text || '')
    const text = !prior ? extra : !extra ? prior : prior.endsWith('\n') || extra.startsWith('\n') ? prior + extra : prior + '\n\n' + extra
    out[prevAt] = { ...prev, text }
  }
  return out
}
