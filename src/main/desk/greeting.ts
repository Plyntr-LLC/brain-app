import { CONDUCTOR, type DeskBot } from '../../shared/desk.ts'

/** The first sentence, or the whole line when it has no sentence end. */
export function firstSentence(text: string): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.match(/^.*?[.!?](?=\s|$)/)?.[0] || flat
}

function listNames(names: string[]): string {
  if (names.length < 3) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * Team thread: the conductor greeting. Any other thread: that bot, and the first sentence of what they do.
 * No model call.
 */
export function threadGreeting(greetingName: string | null, bots: DeskBot[], threadId: string): string {
  const hi = greetingName ? `Hi ${greetingName}.` : 'Hi.'
  if (threadId && threadId !== CONDUCTOR) {
    const bot = bots.find((b) => b.id === threadId)
    const name = bot?.name || threadId
    const about = firstSentence(bot?.description || '')
    return [hi, `I'm ${name}.`, about].filter(Boolean).join(' ')
  }
  const lead = bots.find((b) => b.id === CONDUCTOR)?.name || 'Conductor'
  const team = listNames(bots.filter((b) => b.id !== CONDUCTOR).map((b) => b.name))
  return [
    hi,
    `I'm ${lead}.`,
    team ? `You talk to me, and I hand the work to ${team}.` : 'You talk to me.',
    team ? 'They work in the background, so you can keep talking to me while they do.' : '',
    'An email or a text shows up as the message itself, and you send it from there.',
    'Try one of these:'
  ]
    .filter(Boolean)
    .join(' ')
}
