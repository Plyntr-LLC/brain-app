import { expandPastes as expandStored, type Paste } from '../../shared/saved-msg'

/** A text paste past either limit folds into a token, the way the terminal CLIs do it. */
export const PASTE_CHARS = 1000
export const PASTE_LINES = 15

export function pasteLines(text: string): number {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length
}

export function isBigPaste(text: string): boolean {
  return text.length > PASTE_CHARS || pasteLines(text) > PASTE_LINES
}

export function pasteToken(n: number, lines: number): string {
  return `[Pasted text #${n} +${lines} ${lines === 1 ? 'line' : 'lines'}]`
}

/** UTF-8 size, rounded to whole KB, at least 1KB. */
export function pasteSize(text: string): string {
  return `${Math.max(1, Math.round(new TextEncoder().encode(text).length / 1024))}KB`
}

/** One past the highest number this message has used, so a token you undo back in never collides. */
export function nextPasteNumber(pastes: Paste[]): number {
  return pastes.reduce((n, p) => Math.max(n, Number(/#(\d+)/.exec(p.token)?.[1] || 0)), 0) + 1
}

/** The pastes whose token is still whole in the text. An edited token is just text. */
export function livePastes(text: string, pastes: Paste[]): Paste[] {
  return pastes.filter((p) => text.includes(p.token))
}

function tokenPattern(pastes: Paste[]): RegExp {
  return new RegExp(pastes.map((p) => p.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
}

/** The text with each whole token swapped for its paste, in one pass (a paste that holds a token stays as pasted). */
export function expandPastes(text: string, pastes: Paste[]): string {
  return expandStored(text, livePastes(text, pastes))
}

/** The text cut into plain runs and pastes, for the thread's folded view. */
export function pasteParts(text: string, pastes: Paste[]): ({ text: string } | { paste: Paste })[] {
  const live = livePastes(text, pastes)
  if (!live.length) return [{ text }]
  const out: ({ text: string } | { paste: Paste })[] = []
  let at = 0
  for (const m of text.matchAll(tokenPattern(live))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ paste: live.find((p) => p.token === m[0])! })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}
