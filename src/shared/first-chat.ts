import { asSeat } from './contracts.ts'

/** True when context/ still has the unfilled TEMPLATE- files a new brain ships with. */
export function contextNamesLookNew(relPaths: string[]): boolean {
  return relPaths.some((p) => /(^|\/)TEMPLATE-[^/]+$/.test(p.replace(/\\/g, '/')))
}

/** Exact Path B seed from worker seedFiles / resources/fixtures/plyntr-brain/AGENTS.md */
export const SEED_AGENTS_MD = [
  '# This brain',
  '',
  'Owner and scout may edit skills/.',
  'Agency team may read skills/ and may write anywhere in this repo except skills/ and .team-config/.',
  'Project-only people never receive this folder.',
  ''
].join('\n')

const OTHER_SEED_AGENTS = ['agency copy']

function normAgents(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim()
}

/** True when AGENTS.md is no longer one of the blank seeds a new brain ships with. */
export function agentsMdLooksFilled(text: string): boolean {
  const t = normAgents(text)
  if (!t) return false
  if (t === normAgents(SEED_AGENTS_MD)) return false
  return !OTHER_SEED_AGENTS.some((s) => t === normAgents(s))
}

export const FIRST_CHAT_MARKER = '.team-config/first-chat-done'

/** First chat only for the person who is filling a blank brain, on any Mac. */
export function shouldOfferFirstChat(opts: {
  relPaths: string[]
  agentsMd: string
  markerPresent: boolean
  role?: string
}): boolean {
  const role = String(opts.role || '').trim()
  if (role) {
    const seat = asSeat(role)
    if (seat === 'team' || seat === 'project') return false
  }
  if (opts.markerPresent) return false
  if (agentsMdLooksFilled(opts.agentsMd)) return false
  return contextNamesLookNew(opts.relPaths)
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
