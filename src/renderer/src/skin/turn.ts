const LETTER: Record<string, string> = { grok: 'G', claude: 'C', cursor: 'C', gpt: 'O' }

/** The avatar letter for the CLI answering in this tab. */
export function cliLetter(kind: string): string {
  return LETTER[kind] || (kind[0] || '?').toUpperCase()
}

/** "Thought for N s" once a thought has a first and last chunk and the turn is over; "Thinking" before. */
export function thoughtLabel(t: { at?: number; end?: number; live?: boolean; open?: boolean }): string {
  const head = !t.live && t.at && t.end ? `Thought for ${Math.max(1, Math.round((t.end - t.at) / 1000))} s` : 'Thinking'
  return t.open ? head : `${head} · show`
}

export type ActivityPart = { kind: 'thought' | 'file'; at?: number; end?: number; live?: boolean }

/** Thinking and file chips are one run. A reply, a question, or a plan starts a new row. */
export function isActivityComponent(component: string): boolean {
  return component === 'Thought' || component === 'ToolCard'
}

/** One closed line for a run of thoughts and file chips. The count is steps, not unique paths. */
export function activityLabel(parts: ActivityPart[], open: boolean): string {
  const thoughts = parts.filter((p) => p.kind === 'thought')
  const files = parts.reduce((n, p) => n + (p.kind === 'file' ? 1 : 0), 0)
  const live = thoughts.some((t) => t.live)
  let at: number | undefined
  let end: number | undefined
  for (const t of thoughts) {
    if (t.at != null && (at == null || t.at < at)) at = t.at
    if (t.end != null && (end == null || t.end > end)) end = t.end
  }
  const head = thoughts.length ? thoughtLabel({ at, end, live, open: true }) : ''
  const fileBit = files === 1 ? '1 file' : files > 1 ? `${files} files` : ''
  const core = [head, fileBit].filter(Boolean).join(' · ')
  return open ? core : `${core} · show`
}
