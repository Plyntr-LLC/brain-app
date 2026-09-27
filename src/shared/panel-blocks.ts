/**
 * Turns the plain-text body of a `/usage`, `/status` or `/permissions` popup into blocks the
 * renderer can lay out: a heading, `Key: value` rows (a percent row gets a meter), and plain lines.
 */
export type PanelRow =
  | { kind: 'row'; key: string; value: string; percent?: number; href?: string }
  | { kind: 'line'; text: string }

export type PanelBlock = { heading?: string; rows: PanelRow[] }

const ROW = /^([A-Z][A-Za-z0-9 .’'()/-]{0,38}):\s+(.+)$/

const CMD = /^(\/\S+)\s{2,}(.*)$/

function toRow(line: string): PanelRow {
  const cmd = CMD.exec(line)
  if (cmd) return { kind: 'row', key: cmd[1], value: cmd[2].trim() || ' ' }
  const m = ROW.exec(line)
  if (!m) return { kind: 'line', text: line }
  const key = m[1].trim()
  const value = m[2].trim()
  const href = /^https?:\/\/\S+$/.test(value) ? value : undefined
  const pct = /^(\d{1,3})%$/.exec(value)
  const percent = pct && /\bused\b/i.test(key) ? Math.min(100, Number(pct[1])) : undefined
  return { kind: 'row', key, value, ...(percent != null ? { percent } : {}), ...(href ? { href } : {}) }
}

export function panelBlocks(body: string): PanelBlock[] {
  const out: PanelBlock[] = []
  for (const chunk of String(body || '').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
    if (!lines.length) continue
    const first = lines[0].trim()
    const heading = lines.length > 1 && !ROW.test(first) && !CMD.test(first) && first.length <= 48 && !/[.!?]$/.test(first) ? first : undefined
    out.push({ heading, rows: (heading ? lines.slice(1) : lines).map((l) => toRow(l.trim())) })
  }
  return out
}
