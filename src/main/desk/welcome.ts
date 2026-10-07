import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_LABEL, CONDUCTOR, FALLBACK_ORDER } from '../../shared/desk.ts'
import type { DeskBot, DeskCli, DeskWelcome } from '../../shared/desk.ts'
import type { HelloAccount, PlyntrOwner } from '../login-identity.ts'

/**
 * The welcome card and the readiness lines under the composer. Written by the app, never a model call.
 * `detect` is passed in; this file does not import ai-cli.ts and spawns nothing.
 */

export const NO_CLI_PLACEHOLDER = 'No model app is installed on this Mac.'

export const GENERIC_STARTERS = ["What's in this brain?", 'Draft a short update for the team', 'What can the team do?']

/** Follows helloName's order, then keeps the first word. null where helloName would fall back to an email local part. */
export function deskGreeting(acct: HelloAccount | null | undefined, plyntr: PlyntrOwner | null): string | null {
  const first = (s: string) => s.split(/\s+/)[0] || null
  const appEmail = String(acct?.appEmail || acct?.email || '')
    .trim()
    .toLowerCase()
  const storedApp = String(acct?.appName || '').trim()
  const plyntrEmail = String(plyntr?.email || '')
    .trim()
    .toLowerCase()
  const plyntrName = String(plyntr?.name || '').trim()
  if (plyntrEmail && appEmail === plyntrEmail) {
    if (plyntrName) return first(plyntrName)
    if (storedApp) return first(storedApp)
    return null
  }
  if (storedApp) return first(storedApp)
  const name = String(acct?.name || '').trim()
  const email = String(acct?.email || '')
    .trim()
    .toLowerCase()
  if (name && appEmail && email === appEmail) return first(name)
  return null
}

/** "gutter-iq" is "Gutter Iq". Hyphens, underscores, and spaces break words. */
export function titleCase(folder: string): string {
  return folder
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** The most recently changed folder under clients/, or null. Skips `.` and `_` folders like `_mcc`, which are not clients. */
export function latestClient(brain: string): string | null {
  const dir = join(brain, 'clients')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  let best: { name: string; at: number } | null = null
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    try {
      const st = statSync(join(dir, name))
      if (st.isDirectory() && (!best || st.mtimeMs > best.at)) best = { name, at: st.mtimeMs }
    } catch {
      // gone between readdir and stat
    }
  }
  return best ? best.name : null
}

export function starters(brain: string): DeskWelcome['starters'] {
  const folder = latestClient(brain)
  const client = folder ? titleCase(folder) : ''
  const lines = client ? [`Catch me up on ${client}`, `Draft a reply to ${client}'s last note`, 'What can the team do?'] : GENERIC_STARTERS
  return lines.map((s) => ({ label: s, fill: s }))
}

/** The readiness button. DeskWelcome has no label field, so the renderer builds it from the entry's cli and the bot's name. */
export function readinessButton(cli: DeskCli, botName: string): string {
  return `Use ${CLI_LABEL[cli]} for ${botName}`
}

function listNames(names: string[]): string {
  if (names.length < 3) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

function greetingText(greetingName: string | null, bots: DeskBot[]): string {
  const lead = bots.find((b) => b.id === CONDUCTOR)?.name || 'Conductor'
  const team = listNames(bots.filter((b) => b.id !== CONDUCTOR).map((b) => b.name))
  return [
    greetingName ? `Hi ${greetingName}.` : 'Hi.',
    `I'm ${lead}.`,
    team ? `You talk to me, and I hand the work to ${team}.` : 'You talk to me.',
    team ? 'They work in the background, so you can keep talking to me while they do.' : '',
    'An email or a text shows up as the message itself, and you send it from there.',
    'Try one of these:'
  ]
    .filter(Boolean)
    .join(' ')
}

/** `thread` is the open bot's id; null or missing is the team thread, which talks to the conductor. */
export function buildWelcome(opts: {
  brain: string
  bots: DeskBot[]
  detect: () => Record<DeskCli, boolean>
  greetingName: string | null
  thread?: string | null
}): DeskWelcome {
  const { bots, greetingName } = opts
  const found = opts.detect()
  const installed = FALLBACK_ORDER.filter((c) => found[c])
  const composerDisabled = installed.length === 0
  const threadId = opts.thread || CONDUCTOR
  const threadName = bots.find((b) => b.id === threadId)?.name || (threadId === CONDUCTOR ? 'Conductor' : threadId)

  const readiness: DeskWelcome['readiness'] = []
  for (const bot of bots) {
    if (installed.includes(bot.cli)) continue
    const cli = installed.find((c) => c !== bot.cli)
    if (!cli) continue
    readiness.push({ botId: bot.id, text: `${bot.name} uses ${CLI_LABEL[bot.cli]}, which isn't on this Mac yet.`, cli, model: 'default' })
  }

  const only = installed.length === 1 ? installed[0] : null
  const everyoneLine =
    only && bots.length && bots.every((b) => b.cli === only)
      ? `Everyone is on ${CLI_LABEL[only]} for now. You can give anyone a different model on the right.`
      : null

  return {
    greetingName,
    greeting: greetingText(greetingName, bots),
    starters: starters(opts.brain),
    readiness,
    composerDisabled,
    composerPlaceholder: composerDisabled ? NO_CLI_PLACEHOLDER : `Message ${threadName}`,
    everyoneLine
  }
}
