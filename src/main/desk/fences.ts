import { ASSIGN_MAX_PER_TURN, CONDUCTOR, DESCRIPTION_MAX, SEND_MAX_PER_TURN, cleanSummary, isDeskCli, resolveBot } from '../../shared/desk.ts'
import type { DeskBot, DeskCli, DeskSystem } from '../../shared/desk.ts'

/**
 * The one parser for the blocks a turn may end with. Prose outside the known fences is the reply.
 * A fence tagged anything else (including `text`) stays in the prose as written. Raw block text never
 * comes back: a block that does not parse turns the whole turn into prose plus one parse-failed flag,
 * so nothing is sent and no file is written.
 */

export type AssignBlock = { bot: string; task: string; why: string; files: string[] }
export type SendBlock = { to: string; files: string[]; text: string }
export type HoldBlock = { need: 'spend' | 'ads'; text: string }
export type EmailBlock = { replyTo: string; to: string; cc: string; subject: string; body: string }
export type SmsBlock = { to: string; via: 'iMessage' | 'WhatsApp'; body: string }
export type HireBlock = { name: string; cli: DeskCli; model: string; effort: string; description: string }
export type BrowseBlock =
  | { action: 'url'; detail: string; url: string }
  | { action: 'click'; detail: string }
  | { action: 'type'; detail: string; field: string; text: string }
  | { action: 'press'; detail: 'Enter' }
  | { action: 'scroll'; detail: 'down' | 'up' }

export type FenceFlag = { system: DeskSystem; text: string }

export type ParsedTurn = {
  prose: string
  assigns: AssignBlock[]
  sends: SendBlock[]
  hold: HoldBlock | null
  email: EmailBlock | null
  sms: SmsBlock | null
  remember: string[]
  hire: HireBlock | null
  browse: BrowseBlock | null
  /** One or two sentences for the other chats. Empty when the bot did not write one. */
  summary: string
  flags: FenceFlag[]
}

export const FENCE_TAGS = ['assign', 'send', 'hold', 'email', 'sms', 'remember', 'hire', 'browse', 'summary'] as const
type Tag = (typeof FENCE_TAGS)[number]

export const REMEMBER_MAX_LINES = 20

export const SENTENCE = {
  parseFailed: (name: string) => `${name}'s note didn't come through, so nothing was sent.`,
  unknownBot: (name: string) => `There's no one called ${name} on the team.`,
  workerAssign: 'Only the conductor can hand work to someone else.',
  workerHire: 'Only the conductor can add a teammate.',
  conductorTile: 'Only a teammate puts that on a tile.',
  badHold: 'Put the email or the text on a tile.',
  extraTile: 'One tile per turn. The rest was left out.',
  extraSend: 'Three handoffs per turn. The rest was left out.',
  extraBrowse: 'One browser step per turn.',
  extraHire: 'One new teammate per turn. The rest was left out.'
} as const

type RawBlock = { tag: Tag; body: string; closed: boolean }

function isTag(s: string): s is Tag {
  return (FENCE_TAGS as readonly string[]).includes(s)
}

/** Splits prose from the known fences. Other fenced code stays in the prose, fences and all. */
function scan(text: string): { prose: string; blocks: RawBlock[] } {
  const lines = String(text || '').split(/\r?\n/)
  const prose: string[] = []
  const blocks: RawBlock[] = []
  let i = 0
  while (i < lines.length) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/.exec(lines[i])
    if (!open) {
      prose.push(lines[i++])
      continue
    }
    const mark = open[1]
    const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) j++
    const closed = j < lines.length
    const tag = open[2].toLowerCase()
    if (isTag(tag)) blocks.push({ tag, body: lines.slice(i + 1, j).join('\n'), closed })
    else prose.push(...lines.slice(i, closed ? j + 1 : lines.length))
    i = closed ? j + 1 : lines.length
  }
  return { prose: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(), blocks }
}

/** Header lines, then a blank line, then the body. null when there is no blank line or no body. */
function splitBody(body: string): { head: string[]; rest: string } | null {
  const lines = body.split('\n')
  let s = 0
  while (s < lines.length && !lines[s].trim()) s++
  let blank = -1
  for (let i = s; i < lines.length; i++) {
    if (!lines[i].trim()) {
      blank = i
      break
    }
  }
  if (blank < 0) return null
  const rest = lines.slice(blank + 1).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  return rest.trim() ? { head: lines.slice(s, blank), rest } : null
}

/** `key: value` lines for the given keys. `listKey` collects the `- item` lines under it. Unknown keys are ignored. */
function header(lines: string[], keys: string[], listKey?: string): { map: Record<string, string>; list: string[] } {
  const map: Record<string, string> = {}
  const list: string[] = []
  let cur: string | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    const kv = /^\s*([A-Za-z][A-Za-z_-]*)\s*:\s?(.*)$/.exec(line)
    if (kv) {
      const key = kv[1].toLowerCase()
      cur = keys.includes(key) ? key : null
      if (cur) map[cur] = kv[2].trim()
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item && listKey && cur === listKey) {
      const p = item[1].trim().replace(/^`(.*)`$/, '$1')
      if (p) list.push(p)
      continue
    }
    if (cur && cur !== listKey) map[cur] = `${map[cur]} ${line.trim()}`.trim()
  }
  return { map, list }
}

type Parsed =
  | { tag: 'assign'; v: AssignBlock }
  | { tag: 'send'; v: SendBlock }
  | { tag: 'hold'; v: HoldBlock | { need: string; text: string } }
  | { tag: 'email'; v: EmailBlock }
  | { tag: 'sms'; v: SmsBlock }
  | { tag: 'remember'; v: string[] }
  | { tag: 'hire'; v: HireBlock }
  | { tag: 'browse'; v: BrowseBlock }
  | { tag: 'summary'; v: string }

function parseBlock(b: RawBlock): Parsed | null {
  if (!b.closed) return null
  switch (b.tag) {
    case 'summary':
      return { tag: 'summary', v: cleanSummary(b.body) }
    case 'assign': {
      const { map, list } = header(b.body.split('\n'), ['bot', 'task', 'why', 'files'], 'files')
      if (!map.bot || !map.task) return null
      return { tag: 'assign', v: { bot: map.bot, task: map.task, why: map.why || '', files: list } }
    }
    case 'send': {
      const sp = splitBody(b.body)
      if (!sp) return null
      const { map, list } = header(sp.head, ['to', 'files'], 'files')
      if (!map.to) return null
      return { tag: 'send', v: { to: map.to, files: list, text: sp.rest } }
    }
    case 'hold': {
      const sp = splitBody(b.body)
      if (!sp) return null
      const { map } = header(sp.head, ['need'])
      return { tag: 'hold', v: { need: String(map.need || '').toLowerCase(), text: sp.rest } }
    }
    case 'email': {
      const sp = splitBody(b.body)
      if (!sp) return null
      const { map } = header(sp.head, ['reply', 'to', 'cc', 'subject'])
      if (!map.to) return null
      return { tag: 'email', v: { replyTo: map.reply || '', to: map.to, cc: map.cc || '', subject: map.subject || '', body: sp.rest } }
    }
    case 'sms': {
      const sp = splitBody(b.body)
      if (!sp) return null
      const { map } = header(sp.head, ['to', 'via'])
      const via = String(map.via || 'iMessage').toLowerCase()
      if (!map.to || (via !== 'imessage' && via !== 'whatsapp')) return null
      return { tag: 'sms', v: { to: map.to, via: via === 'whatsapp' ? 'WhatsApp' : 'iMessage', body: sp.rest } }
    }
    case 'remember': {
      const lines = b.body
        .split('\n')
        .map((l) => l.trim().replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
      return lines.length ? { tag: 'remember', v: lines } : null
    }
    case 'hire': {
      const sp = splitBody(b.body)
      if (!sp) return null
      const { map } = header(sp.head, ['name', 'cli', 'model', 'effort'])
      const cli = String(map.cli || '').toLowerCase()
      if (!map.name || !isDeskCli(cli) || sp.rest.trim().length > DESCRIPTION_MAX) return null
      return { tag: 'hire', v: { name: map.name, cli, model: map.model || 'default', effort: map.effort || 'default', description: sp.rest.trim() } }
    }
    case 'browse': {
      const steps = b.body.split('\n').filter((l) => l.trim())
      if (steps.length !== 1) return null
      const kv = /^\s*(url|click|type|press|scroll)\s*:\s*(.*)$/i.exec(steps[0])
      if (!kv) return null
      const action = kv[1].toLowerCase()
      const detail = kv[2].trim()
      if (!detail) return null
      if (action === 'url') {
        try {
          const u = new URL(detail)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
        } catch {
          return null
        }
        return { tag: 'browse', v: { action: 'url', detail, url: detail } }
      }
      if (action === 'click') return { tag: 'browse', v: { action: 'click', detail } }
      if (action === 'type') {
        const bar = detail.indexOf('|')
        const field = bar < 0 ? '' : detail.slice(0, bar).trim()
        if (!field) return null
        return { tag: 'browse', v: { action: 'type', detail, field, text: detail.slice(bar + 1).trim() } }
      }
      if (action === 'press') return detail.toLowerCase() === 'enter' ? { tag: 'browse', v: { action: 'press', detail: 'Enter' } } : null
      const dir = detail.toLowerCase()
      return dir === 'down' || dir === 'up' ? { tag: 'browse', v: { action: 'scroll', detail: dir } } : null
    }
  }
}

/**
 * `from` is the speaking bot's id. `bots` is the live roster, used to resolve `bot:` and `to:` by name or id
 * and to name the speaker in the parse-failed sentence. Caps and role rules are applied here; tile state
 * across turns (an unanswered tile, a revision) is the controller's.
 */
export function parseFences(text: string, opts: { from: string; bots: DeskBot[] }): ParsedTurn {
  const { prose, blocks } = scan(text)
  const isConductor = opts.from === CONDUCTOR
  const speaker = resolveBot(opts.bots, opts.from)?.name || opts.from
  const out: ParsedTurn = { prose, assigns: [], sends: [], hold: null, email: null, sms: null, remember: [], hire: null, browse: null, summary: '', flags: [] }
  const flags: FenceFlag[] = []
  const flag = (system: DeskSystem, text: string) => {
    if (!flags.some((f) => f.system === system && f.text === text)) flags.push({ system, text })
  }

  const parsed: Parsed[] = []
  const summaries: string[] = []
  for (const b of blocks) {
    if (b.tag === 'summary' && isConductor) {
      const back = b.body.trim()
      if (back) out.prose = [out.prose, back].filter(Boolean).join('\n\n')
      continue
    }
    if (b.tag === 'summary' && !b.closed) continue
    if (!isConductor && b.tag === 'assign') {
      flag('worker-assign', SENTENCE.workerAssign)
      continue
    }
    if (!isConductor && b.tag === 'hire') {
      flag('worker-hire', SENTENCE.workerHire)
      continue
    }
    if (isConductor && (b.tag === 'email' || b.tag === 'sms' || b.tag === 'hold' || b.tag === 'browse')) {
      flag('conductor-tile', SENTENCE.conductorTile)
      continue
    }
    const p = parseBlock(b)
    if (!p) return { ...out, flags: [{ system: 'parse-failed', text: SENTENCE.parseFailed(speaker) }] }
    parsed.push(p)
  }

  const tiles: Parsed[] = []
  const browses: BrowseBlock[] = []
  const hires: HireBlock[] = []
  for (const p of parsed) {
    if (p.tag === 'assign') {
      const bot = resolveBot(opts.bots, p.v.bot)
      if (!bot) flag('unknown-bot', SENTENCE.unknownBot(p.v.bot))
      else if (out.assigns.length >= ASSIGN_MAX_PER_TURN) flag('extra-tile', SENTENCE.extraSend)
      else out.assigns.push({ ...p.v, bot: bot.id })
    } else if (p.tag === 'send') {
      const bot = resolveBot(opts.bots, p.v.to)
      if (!bot) flag('unknown-bot', SENTENCE.unknownBot(p.v.to))
      else if (out.sends.length >= SEND_MAX_PER_TURN) flag('extra-tile', SENTENCE.extraSend)
      else out.sends.push({ ...p.v, to: bot.id })
    } else if (p.tag === 'hold') {
      if (p.v.need === 'spend' || p.v.need === 'ads') tiles.push(p)
      else flag('bad-hold', SENTENCE.badHold)
    } else if (p.tag === 'email' || p.tag === 'sms') tiles.push(p)
    else if (p.tag === 'remember') out.remember.push(...p.v)
    else if (p.tag === 'hire') hires.push(p.v)
    else if (p.tag === 'browse') browses.push(p.v)
    else if (p.tag === 'summary' && p.v) summaries.push(p.v)
  }

  out.remember = out.remember.slice(0, REMEMBER_MAX_LINES)
  if (hires.length) out.hire = hires[0]
  if (hires.length > 1) flag('extra-tile', SENTENCE.extraHire)
  if (browses.length) out.browse = browses[0]
  if (browses.length > 1) flag('extra-tile', SENTENCE.extraBrowse)
  const keep = out.browse ? null : tiles[0]
  if (keep?.tag === 'hold') out.hold = keep.v as HoldBlock
  if (keep?.tag === 'email') out.email = keep.v
  if (keep?.tag === 'sms') out.sms = keep.v
  if (tiles.length > (keep ? 1 : 0)) flag('extra-tile', SENTENCE.extraTile)
  out.summary = summaries.length ? summaries[summaries.length - 1] : ''
  out.flags = flags
  return out
}
