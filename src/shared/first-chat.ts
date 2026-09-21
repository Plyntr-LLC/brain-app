/** True when context/ still has the unfilled TEMPLATE- files a new brain ships with. */
export function contextNamesLookNew(relPaths: string[]): boolean {
  return relPaths.some((p) => /(^|\/)TEMPLATE-[^/]+$/.test(p.replace(/\\/g, '/')))
}

/** First chat only. Shown once, and only while those TEMPLATE- files are still there. */
export function firstChatWelcome(place: string): string {
  const name = place.trim() || 'this brain'
  return [
    `Welcome. ${name} is on this computer, and the notes are still blank.`,
    'Tell me about the business in the box below. What it does, who it is for, and what you sell. I will save that into the brain.',
    'One message is enough to start.'
  ].join('\n\n')
}
