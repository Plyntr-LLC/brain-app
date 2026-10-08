/**
 * Desk types and the small pure helpers every Desk slice shares. No node imports: the renderer
 * typechecks this file too. Later slices import from here and do not edit it.
 */
import type { Paste } from './saved-msg'

export type DeskCli = 'grok' | 'claude' | 'gpt' | 'cursor'

export const CLI_LABEL: Record<DeskCli, string> = { grok: 'Grok', claude: 'Claude', gpt: 'ChatGPT', cursor: 'Cursor' }

export const FALLBACK_ORDER: DeskCli[] = ['grok', 'claude', 'cursor', 'gpt']

export type DeskBot = {
  id: string
  name: string
  cli: DeskCli
  model: string
  effort: string
  description: string
  file: string
}

export type ContextFile = { path: string; excerpt: string }
export type ContextPack = { why: string; files: ContextFile[]; dropped: string[] }

export type DeskKind =
  | 'task' | 'reply' | 'pack' | 'send' | 'hold' | 'report'
  | 'note' | 'hire' | 'browse' | 'email' | 'text'
  | 'status' | 'system' | 'error' | 'stopped'

export type DeskFailure = 'not-installed' | 'not-signed-in' | 'exited' | 'empty'

export type DeskSystem =
  | 'slow' | 'loop' | 'unknown-bot' | 'worker-assign' | 'worker-hire'
  | 'bad-hold' | 'extra-tile' | 'fallback' | 'parse-failed' | 'no-page' | 'browse-limit' | 'conductor-tile'
  | 'removed' | 'page-changed' | 'no-submit' | 'late' | 'already-sent' | 'revision-kind'

export type DeskMessage = {
  id: string
  ts: string
  from: string // bot id, or 'me'
  to: string
  kind: DeskKind
  text: string // prose only; never contains a fence
  summary?: string // one or two sentences for the other chats; the author's chat keeps text
  pastes?: Paste[] // a long paste folded to a token in text; the model reads the full paste
  job?: string
  replaces?: string // append-only edit of an earlier message id; set by the controller, never read from a block
  actedAt?: string // Send or Approve time; Not now never sets it
  browseId?: string // steps that belong on one card
  pack?: ContextPack
  hold?: { need: 'spend' | 'ads'; answer?: 'yes' | 'no'; browseClick?: string; pageUrl?: string; browseId?: string }
  email?: { replyTo: string; to: string; cc: string; subject: string; body: string; from: string; sent?: 'yes' | 'no'; sendable: boolean; note?: string }
  textMsg?: { to: string; via: 'iMessage' | 'WhatsApp'; body: string; sent?: 'yes' | 'no'; sendable: boolean; note?: string; chatGuid?: string; chatLabel?: string }
  hire?: { id: string; name: string; cli: DeskCli; model: string; description: string; hasWorked: boolean }
  browse?: { steps: { action: string; detail: string; url: string }[]; title?: string; signIn?: boolean; noChrome?: boolean; windowOpen?: boolean }
  noteLines?: string[]
  report?: { seconds: number }
  inputs?: string[] // message ids Run again and Try again rerun
  used?: { cli: DeskCli; model: string } // set on the reply or report that carries the turn's prose, when a later try returned the text
  lastTry?: { cli: DeskCli; model: string } // set on an error when the chain stopped
  system?: DeskSystem
  name?: string // on a 'removed' system line: the removed bot's display name, for the names map
  failure?: DeskFailure
  detail?: string
}

export type BotState =
  | { id: string; state: 'idle' }
  | { id: string; state: 'working'; since: string; task: string; model: string; nextModel?: string; trying?: boolean; queued?: number }
  | { id: string; state: 'waiting-bot'; on: string }
  | { id: string; state: 'waiting-you' }
  | { id: string; state: 'not-set-up'; cli: DeskCli } // only when no CLI is installed on this Mac

export const ME = 'me'
export const PACK_MAX_FILES = 8
export const PACK_MAX_EXCERPT = 1500
export const DESCRIPTION_MAX = 800
export const ASSIGN_MAX_PER_TURN = 3
export const SEND_MAX_PER_TURN = 3
export const SEND_CAP_PER_JOB = 10
export const SLOW_TURN_MS = 10 * 60_000
export const CONDUCTOR_HISTORY = 20
export const MEMORY_PROMPT_CHARS = 2000
export const MEMORY_STANDING_CHARS = 1200
export const MEMORY_WEEK_CHARS = 800
export const BROWSE_TEXT_CHARS = 8000
export const BROWSE_MAX_STEPS = 8
export const BROWSE_MAX_CONTROLS = 40
export const FALLBACK_ATTEMPTS = 4
/** Whole words. "Pay now" matches. "payment" does not. */
/** Approve, then one click. */
export const PAY_HOLD = ['pay', 'buy', 'purchase', 'subscribe', 'order', 'checkout', 'confirm', 'save', 'apply', 'pause', 'enable', 'delete', 'remove', 'update'] as const
/** Do not click. Tell the person to use a tile. */
export const PAY_REFUSE = ['send', 'reply', 'post', 'publish', 'submit'] as const

export const DESK_CLIS: DeskCli[] = ['grok', 'claude', 'gpt', 'cursor']
export const CONDUCTOR = 'conductor'
/** Roster order: the seed team first, then hires in the order they joined. */
export const SEED_IDS = ['conductor', 'researcher', 'writer', 'checker', 'drafts']

/**
 * One chat's lines. A bot sees what they sent or received.
 * The team chat is the conductor. A line you typed to another bot, and that bot's
 * answer on the same job, stay in that bot's chat. A line to or from the conductor still shows.
 */
export function forThread(botId: string | null, messages: DeskMessage[]): DeskMessage[] {
  if (botId) return messages.filter((m) => m.from === botId || m.to === botId)
  const direct = new Set<string>()
  for (const m of messages) {
    if (m.job && m.from === ME && m.to !== CONDUCTOR && m.to !== ME) direct.add(m.job)
  }
  return messages.filter((m) => {
    if (m.from === CONDUCTOR || m.to === CONDUCTOR) return true
    if (m.from === ME && (m.to === CONDUCTOR || m.to === ME)) return true
    if (m.job && direct.has(m.job)) return false
    if (m.to === ME) return true
    return m.from !== ME && m.to !== ME
  })
}

/** Other chats show at most this many characters of a summary. */
export const SUMMARY_MAX = 320

/** One paragraph, capped. Empty when there is nothing to show. */
export function cleanSummary(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t.length <= SUMMARY_MAX) return t
  const cut = t.slice(0, SUMMARY_MAX - 1)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  const kept = (stop >= 40 ? cut.slice(0, stop + 1) : cut).trimEnd()
  return `${kept}…`
}

/** What another chat shows when the bot did not write a summary. A short answer stands. A longer one keeps its first line. */
export function briefReturn(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const flat = lines.join(' ')
  if (flat.length <= 240 && lines.length <= 2) return flat
  return cleanSummary(lines[0] || flat)
}

/** The line under “Message from {Name}.” The bot’s summary when they wrote one. */
export function returnText(msg: { summary?: string; text?: string }): string {
  return cleanSummary(msg.summary) || briefReturn(msg.text || '')
}

export function isDeskCli(v: unknown): v is DeskCli {
  return typeof v === 'string' && (DESK_CLIS as string[]).includes(v)
}

/** The form's inline sentence for a description that is too long, or null. */
export function descriptionError(description: string): string | null {
  const n = String(description || '').trim().length
  return n > DESCRIPTION_MAX ? `Keep it under ${DESCRIPTION_MAX} characters (now ${n}).` : null
}

/** Lowercase; each run of non-letters/non-digits becomes one hyphen; trim hyphens. */
export function botSlug(name: string): string {
  return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
}

export function resolveBot(bots: DeskBot[], nameOrId: string): DeskBot | null {
  const key = String(nameOrId || '').trim().toLowerCase()
  if (!key) return null
  return bots.find((b) => b.id === key) || bots.find((b) => b.name.trim().toLowerCase() === key) || null
}

/** The id and display name a hire gets. The display name ends in the same number as the id. */
export function botHire(name: string, taken: { ids: string[]; names: string[] }): { id: string; name: string } {
  const base = String(name || '').trim()
  const slug = botSlug(base) || 'bot'
  const ids = new Set(taken.ids.map((id) => id.toLowerCase()))
  const names = new Set(taken.names.map((n) => n.trim().toLowerCase()))
  const nameSlugs = new Set(taken.names.map(botSlug))
  const clash = (id: string, display: string) => ids.has(id) || nameSlugs.has(id) || names.has(display.toLowerCase())
  if (!clash(slug, base)) return { id: slug, name: base }
  for (let n = 2; ; n++) {
    const id = `${slug}-${n}`
    const display = `${base} ${n}`
    if (!clash(id, display)) return { id, name: display }
  }
}

/** Lowercase; each run of non-letters/non-digits becomes one hyphen; trim hyphens. "Ad Checker" and "Ad-Checker" are both `ad-checker`.
 * `taken.ids` is live ids plus every id with a `removed` line. `taken.names` is live display names plus those removed names.
 * A match on either (names case-insensitive) tries `-2` with display name "<name> 2", then `-3` with "<name> 3", and keeps going
 * until neither that id nor that display name is taken. Never returns a removed bot's id. */
export function botIdFromName(name: string, taken: { ids: string[]; names: string[] }): string {
  return botHire(name, taken).id
}

/** At most FALLBACK_ATTEMPTS pairs. Try 1 is always the bot's CLI. Later steps skip a CLI not in `installed`. Omits step 2 when model is already `default` or that CLI is missing. */
export function fallbackChain(bot: DeskBot, installed: DeskCli[]): { cli: DeskCli; model: string }[] {
  const chain: { cli: DeskCli; model: string }[] = []
  const add = (cli: DeskCli, model: string) => {
    if (chain.length >= FALLBACK_ATTEMPTS) return
    if (chain.some((p) => p.cli === cli && p.model === model)) return
    chain.push({ cli, model })
  }
  const model = String(bot.model || '').trim() || 'default'
  add(bot.cli, model)
  if (model !== 'default' && installed.includes(bot.cli)) add(bot.cli, 'default')
  for (const cli of FALLBACK_ORDER) {
    if (cli !== bot.cli && installed.includes(cli)) add(cli, 'default')
  }
  return chain
}

/** Local calendar date as YYYY-MM-DD. Memory headings use this. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ISO 8601 week of the local calendar date, like "2026-W41". */
export function isoWeek(d: Date): string {
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dow = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - dow)
  const year = day.getUTCFullYear()
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Whole word. `pay` inside "Pay now" is `hold`. `submit` is `refuse`. `payment` is null. `hold` wins over `refuse`. */
export function payCheck(name: string): 'hold' | 'refuse' | null {
  const words = String(name || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  if (words.some((w) => (PAY_HOLD as readonly string[]).includes(w))) return 'hold'
  if (words.some((w) => (PAY_REFUSE as readonly string[]).includes(w))) return 'refuse'
  return null
}

export type PageSnapshot = { url: string; title: string; text: string; controls: string[]; hasPassword: boolean }
export type BrowseStepResult =
  | { ok: true; url: string; title: string; text: string; controls: string[] }
  | { hold: 'spend'; name: string; url: string }
  | { refused: 'page-changed'; url: string }
  | { refused: 'pay' | 'missing' | 'ambiguous' | 'no-submit'; name?: string; url: string }
  | { signIn: true; url: string; title: string }
  | { noChrome: true }
/** The launch `createDeskBrowser` takes. The app's is `makeInAppLaunch` (desk/inapp.ts): pages inside Brain, keyed by window through `.windows`. */
export type DeskLaunch = (opts: { chromePath: string; profileDir: string }) => Promise<PageAdapter | { noChrome: true }>
export type PageAdapter = {
  goto: (url: string) => Promise<void>
  snapshot: () => Promise<PageSnapshot>
  click: (i: number) => Promise<void>
  type: (i: number, text: string) => Promise<void>
  submit: (i: number) => Promise<void>
  /** The submit control in the form of field `i` (last snapshot's numbering). null when that form has none. */
  submitFor: (i: number) => Promise<{ index: number; name: string } | null>
  /** What Enter or Space would press: the focused control's own name, and its form's default submit button's name. */
  activeNames?: () => Promise<{ own: string; submit: string }>
  scroll: (dir: 'down' | 'up') => Promise<void>
}
export type DeskBrowser = {
  open: (browseId: string, owner?: string) => Promise<void | { noChrome: true }>
  cancel: (browseId: string) => void
  release: (browseId: string) => void
  focus: () => void // raises the corner picture. It does not launch Chrome or bring that window forward.
  showWindow: () => void // asks the adapter. The live window stays minimized. Does not launch Chrome.
  picture: (owner?: string) => Promise<string | null> // jpeg base64 of that place's page, or null when it is closed
  windowOpen: () => boolean // true while a desk Chrome window is open, with or without a browse session
  clickApproved: (name: string, pageUrl: string, owner?: string) => Promise<BrowseStepResult>
  runStep: (browseId: string, step: { action: string; detail?: string; url?: string }) => Promise<BrowseStepResult>
  /** Open this address on that place's window. Does not start a browse session. */
  goTo?: (url: string, owner?: string) => Promise<void>
  clickAt?: (x: number, y: number, owner?: string) => Promise<void>
  typeText?: (text: string, owner?: string) => Promise<void>
  pressKey?: (key: string, owner?: string) => Promise<void>
  wheel?: (deltaY: number, owner?: string) => Promise<void>
  /** Whether that place's page is asking the person to sign in. */
  look?: (owner?: string) => Promise<{ signIn: boolean } | null>
  /** Close that place's own site window. Never closes the shared WhatsApp window. */
  closeOwner?: (owner: string) => Promise<void>
}

/** Built by slice-9, returned by slice-6, rendered by slice-7 as is. */
export type DeskWelcome = {
  greetingName: string | null
  greeting: string
  starters: { label: string; fill: string }[]
  readiness: { botId: string; text: string; cli: DeskCli; model: 'default' }[]
  composerDisabled: boolean
  composerPlaceholder: string // "No model app is installed on this Mac." when composerDisabled, else "Message Conductor" or "Message Writer"
  everyoneLine: string | null // only when every bot's CLI is the same and that is the only installed CLI
}

/** What senders.ts returns. Senders never append mail. The controller copies `note` and `sendable` onto the replacement. */
export type DeskSendResult = { ok: boolean; dryRun?: boolean; killed?: boolean; sendable?: boolean; note?: string }
