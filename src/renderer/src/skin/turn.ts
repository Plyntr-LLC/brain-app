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
