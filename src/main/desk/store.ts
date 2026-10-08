import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { brainWriteBlock } from '../write-guard.ts'
import {
  ME,
  forThread,
  MEMORY_PROMPT_CHARS,
  MEMORY_STANDING_CHARS,
  MEMORY_WEEK_CHARS,
  SEED_IDS,
  botSlug,
  cleanSummary,
  descriptionError,
  isDeskCli,
  localDay
} from '../../shared/desk.ts'
import type { DeskBot, DeskKind, DeskMessage } from '../../shared/desk.ts'
import { archiveFile, botFile, botsDir, mailFile, memoryFile, weekFile } from './paths.ts'

/**
 * The only reader and writer of desk/ files: the roster, the mail file, and bot memory.
 * Every write calls brainWriteBlock first and returns its sentence instead of writing.
 */

export type Role = string | null | undefined

/** Write (or append) a file under the brain after the write guard. The guard's sentence, or null. */
export function writeBrainFile(role: Role, brain: string, target: string, body: string, opts: { append?: boolean } = {}): string | null {
  const abs = isAbsolute(target) ? target : join(brain, target)
  const block = brainWriteBlock(role, brain, abs)
  if (block) return block
  mkdirSync(dirname(abs), { recursive: true })
  if (opts.append) appendFileSync(abs, body)
  else writeFileSync(abs, body)
  return null
}

function removeBrainFile(role: Role, brain: string, abs: string): string | null {
  const block = brainWriteBlock(role, brain, abs)
  if (block) return block
  rmSync(abs, { force: true })
  return null
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// ---------- bot files ----------

export function renderBotFile(bot: Omit<DeskBot, 'file'>): string {
  const one = (s: string) => String(s || '').replace(/\s+/g, ' ').trim()
  return [
    '---',
    `id: ${bot.id}`,
    `name: ${one(bot.name)}`,
    `cli: ${bot.cli}`,
    `model: ${one(bot.model) || 'default'}`,
    `effort: ${one(bot.effort) || 'default'}`,
    '---',
    String(bot.description || '').trim(),
    ''
  ].join('\n')
}

/** null when the file has no front matter or its cli is not one of the four. The id is the file name. */
export function parseBotFile(text: string, file: string, id: string): DeskBot | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  if (!isDeskCli(meta.cli)) return null
  return {
    id,
    name: meta.name || id,
    cli: meta.cli,
    model: meta.model || 'default',
    effort: meta.effort || 'default',
    description: String(m[2] || '').trim(),
    file
  }
}

// ---------- mail ----------

const MACHINE = '<!-- desk '
const MACHINE_LINE = /^<!-- desk .*$/gm
const TOKEN_KEYS = ['id', 'kind', 'from', 'to', 'job', 'ts', 'replaces', 'actedAt', 'browseId', 'system'] as const
const DATA_KEYS = ['pack', 'hold', 'email', 'textMsg', 'hire', 'browse', 'noteLines', 'report', 'used', 'lastTry', 'name', 'failure', 'detail', 'inputs', 'pastes', 'summary'] as const
const WORKED_KINDS: DeskKind[] = ['report', 'send', 'email', 'text', 'reply', 'hold', 'browse']

const KIND_LABEL: Partial<Record<DeskKind, string>> = {
  pack: 'Briefing',
  hold: 'Needs your OK',
  report: 'Done',
  email: 'Email',
  text: 'Text',
  note: 'Note',
  hire: 'New teammate',
  browse: 'Desk browser',
  status: 'Where things stand',
  error: "Couldn't finish",
  stopped: 'Stopped'
}

/** A body line can never start a new message: each `<!-…- desk ` gains one backslash on write and loses it on read. */
export function escapeBody(s: string): string {
  return s.replace(/<!-(\\*)- desk /g, '<!-\\$1- desk ')
}

export function unescapeBody(s: string): string {
  return s.replace(/<!-\\(\\*)- desk /g, '<!-$1- desk ')
}

const tokenValue = (v: string) => v.replace(/[%\s>]/g, encodeURIComponent)

function hhmm(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function heading(m: DeskMessage, names: Record<string, string>): string {
  const who = (id: string) => (id === ME ? 'You' : names[id] || id)
  const parts = [hhmm(m.ts), m.to && m.to !== ME ? `${who(m.from)} → ${who(m.to)}` : who(m.from)].filter(Boolean)
  const label = KIND_LABEL[m.kind]
  if (label) parts.push(label)
  return `## ${parts.join(' · ')}`
}

/** One machine line, one readable heading, then the text. `names` maps ids to screen names for the heading only. */
export function serializeMessage(m: DeskMessage, names: Record<string, string> = {}): string {
  const rec = m as unknown as Record<string, unknown>
  const tokens: string[] = []
  for (const k of TOKEN_KEYS) {
    const v = rec[k]
    if (v != null && v !== '') tokens.push(`${k}=${tokenValue(String(v))}`)
  }
  const data: Record<string, unknown> = {}
  for (const k of DATA_KEYS) if (rec[k] !== undefined) data[k] = rec[k]
  if (m.hire) {
    const { hasWorked: _worked, ...hire } = m.hire
    data.hire = hire
  }
  if (m.browse) {
    const { windowOpen: _open, ...browse } = m.browse
    data.browse = browse
  }
  if (Object.keys(data).length) tokens.push(`data=${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}`)
  return `${MACHINE}${tokens.join(' ')} -->\n${heading(m, names)}\n${escapeBody(m.text)}\n\n`
}

function cleanPastes(v: unknown): { token: string; text: string }[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.flatMap((p) => {
    if (!p || typeof p !== 'object') return []
    const token = (p as { token?: unknown }).token
    const text = (p as { text?: unknown }).text
    return typeof token === 'string' && token && typeof text === 'string' ? [{ token, text }] : []
  })
  return out.length ? out : undefined
}

function parseMachine(line: string): Record<string, string> {
  const inner = line.slice(MACHINE.length).replace(/\s*-->\s*$/, '')
  const out: Record<string, string> = {}
  for (const tok of inner.split(' ')) {
    const at = tok.indexOf('=')
    if (at <= 0) continue
    try {
      out[tok.slice(0, at)] = decodeURIComponent(tok.slice(at + 1))
    } catch {
      out[tok.slice(0, at)] = tok.slice(at + 1)
    }
  }
  return out
}

/** Every message in the file, in order. `hire.hasWorked` is rebuilt from later messages. */
export function parseMail(text: string): DeskMessage[] {
  const heads = [...text.matchAll(MACHINE_LINE)]
  const out: DeskMessage[] = []
  heads.forEach((h, i) => {
    const start = (h.index ?? 0) + h[0].length + 1
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    const chunk = start <= end ? text.slice(start, end) : ''
    const nl = chunk.indexOf('\n')
    let body = nl < 0 ? '' : chunk.slice(nl + 1)
    if (body.endsWith('\n\n')) body = body.slice(0, -2)
    else if (body.endsWith('\n')) body = body.slice(0, -1)
    const t = parseMachine(h[0])
    if (!t.id || !t.kind) return
    const msg: Record<string, unknown> = { id: t.id, ts: t.ts || '', from: t.from || '', to: t.to || '', kind: t.kind, text: unescapeBody(body) }
    for (const k of TOKEN_KEYS) if (!(k in msg) && t[k] != null) msg[k] = t[k]
    if (t.data) {
      try {
        const data = JSON.parse(Buffer.from(t.data, 'base64').toString('utf8')) as Record<string, unknown>
        for (const k of DATA_KEYS) if (data[k] !== undefined) msg[k] = data[k]
      } catch {
        // A damaged data token loses the structured fields, not the message.
      }
    }
    const pastes = cleanPastes(msg.pastes)
    if (pastes) msg.pastes = pastes
    else delete msg.pastes
    const summary = cleanSummary(msg.summary)
    if (summary) msg.summary = summary
    else delete msg.summary
    out.push(msg as unknown as DeskMessage)
  })
  out.forEach((m, i) => {
    if (!m.hire) return
    const id = m.hire.id
    const later = out.slice(i + 1)
    const hasWorked = later.some((x) => (x.from === id && WORKED_KINDS.includes(x.kind)) || (x.kind === 'pack' && x.to === id))
    m.hire = { ...m.hire, hasWorked }
  })
  return out
}

/**
 * Walks the whole file before any view filter. A message whose `replaces` names an earlier id hides that id
 * and takes its from, to, and job. When two messages replace the same id, the one with `actedAt` is the
 * visible copy; otherwise the latest is.
 */
export function foldMessages(msgs: DeskMessage[]): DeskMessage[] {
  const byId = new Map<string, DeskMessage>()
  const winner = new Map<string, string>()
  const hidden = new Set<string>()
  const order: string[] = []
  for (const m of msgs) {
    let out = m
    const target = m.replaces ? byId.get(m.replaces) : undefined
    if (target && m.replaces) {
      out = { ...m, from: target.from, to: target.to }
      if (target.job !== undefined) out.job = target.job
      else delete out.job
      const prev = winner.get(m.replaces)
      const prevMsg = prev ? byId.get(prev) : undefined
      if (prevMsg?.actedAt && !out.actedAt) hidden.add(out.id)
      else {
        if (prev) hidden.add(prev)
        winner.set(m.replaces, out.id)
      }
      hidden.add(m.replaces)
    }
    byId.set(out.id, out)
    order.push(out.id)
  }
  return order.filter((id) => !hidden.has(id)).map((id) => byId.get(id) as DeskMessage)
}

/** Merges browse messages that share a browseId into one card at the first step's place, steps in order. */
export function groupBrowse(msgs: DeskMessage[]): DeskMessage[] {
  const out: DeskMessage[] = []
  const at = new Map<string, number>()
  for (const m of msgs) {
    if (m.kind !== 'browse' || !m.browseId) {
      out.push(m)
      continue
    }
    const i = at.get(m.browseId)
    if (i == null) {
      at.set(m.browseId, out.length)
      out.push({ ...m, browse: { ...m.browse, steps: [...(m.browse?.steps || [])] } })
      continue
    }
    const g = out[i]
    const steps = [...(g.browse?.steps || []), ...(m.browse?.steps || [])]
    out[i] = { ...g, text: m.text || g.text, browse: { ...g.browse, ...m.browse, steps } }
  }
  return out
}

export type NewDeskMessage = Omit<DeskMessage, 'id' | 'ts'> & { id?: string; ts?: string }

// ---------- memory ----------

type Range = { start: number; end: number }

function isSectionHead(line: string): boolean {
  return /^#{1,2}\s/.test(line)
}

function section(lines: string[], title: string): Range | null {
  const want = title.toLowerCase()
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.slice(2).trim().toLowerCase() === want)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !isSectionHead(lines[end])) end++
  return { start, end }
}

const DATE_HEAD = /^###\s+(\d{4}-\d{2}-\d{2})\s*$/

type WeekLine = { date: string | null; index: number; line: string }

function weekLines(lines: string[], r: Range | null): WeekLine[] {
  if (!r) return []
  const out: WeekLine[] = []
  let date: string | null = null
  for (let i = r.start + 1; i < r.end; i++) {
    const l = lines[i]
    const dm = DATE_HEAD.exec(l)
    if (dm) date = dm[1]
    else if (/^###\s/.test(l)) date = null
    else if (l.trim()) out.push({ date, index: i, line: l })
  }
  return out
}

function bulletKey(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '').trim().toLowerCase()
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** Drops lines by index, then any `###` heading in This week left with no lines under it. */
function dropLines(lines: string[], drop: Set<number>): string[] {
  const kept = lines.map((l, i) => (drop.has(i) ? null : l))
  const week = section(lines, 'This week')
  if (week) {
    for (let i = week.start + 1; i < week.end; i++) {
      if (kept[i] == null || !/^###\s/.test(kept[i] as string)) continue
      let j = i + 1
      let empty = true
      while (j < week.end && !(kept[j] != null && /^###\s/.test(kept[j] as string))) {
        if (kept[j] != null && (kept[j] as string).trim()) empty = false
        j++
      }
      if (empty) kept[i] = null
    }
  }
  return kept.filter((l): l is string => l != null)
}

function archiveBlock(groups: { date: string | null; line: string }[]): string {
  let out = ''
  let last: string | null | undefined
  for (const g of groups) {
    if (g.date !== last) {
      out += `${out ? '\n' : ''}### ${g.date || 'undated'}\n`
      last = g.date
    }
    out += `${g.line}\n`
  }
  return out ? `${out}\n` : ''
}

function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return nl < 0 ? '' : cut.slice(0, nl)
}

/** A compact result is a bullet list at or under 1,200 characters; anything else is null and Standing stays. */
export function mergeStanding(result: string): string[] | null {
  const lines = String(result || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^##\s+standing\s*$/i.test(l.trim()))
  if (!lines.length) return null
  if (!lines.every((l) => /^\s*[-*]\s+\S/.test(l))) return null
  const list = lines.map((l) => `- ${l.replace(/^\s*[-*]\s+/, '')}`)
  return list.join('\n').length <= MEMORY_STANDING_CHARS ? list : null
}

// ---------- the store ----------

export type DeskStore = ReturnType<typeof createDeskStore>

export function createDeskStore(opts: { brain: string; role: Role }) {
  const { brain, role } = opts
  const counters = new Map<string, number>()
  let countersReady = false

  const write = (target: string, body: string) => writeBrainFile(role, brain, target, body)
  const append = (target: string, body: string) => writeBrainFile(role, brain, target, body, { append: true })

  function readBots(): DeskBot[] {
    const dir = botsDir(brain)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      return []
    }
    const rows: { bot: DeskBot; born: number }[] = []
    for (const f of files) {
      const file = join(dir, f)
      const bot = parseBotFile(readText(file), file, f.slice(0, -3))
      if (!bot) continue
      let born = 0
      try {
        born = statSync(file).birthtimeMs
      } catch {
        // keep 0
      }
      rows.push({ bot, born })
    }
    const seed = (id: string) => {
      const i = SEED_IDS.indexOf(id)
      return i < 0 ? SEED_IDS.length : i
    }
    rows.sort((a, b) => seed(a.bot.id) - seed(b.bot.id) || a.born - b.born || a.bot.id.localeCompare(b.bot.id))
    return rows.map((r) => r.bot)
  }

  function readBot(id: string): DeskBot | null {
    const file = botFile(brain, id)
    return existsSync(file) ? parseBotFile(readText(file), file, id) : null
  }

  function names(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const b of readBots()) out[b.id] = b.name
    return out
  }

  /** The form's sentence, or the write guard's, or null when written. */
  function saveBot(bot: Omit<DeskBot, 'file'>): string | null {
    if (!String(bot.name || '').trim() || !bot.id || botSlug(bot.id) !== bot.id) return 'Give them a name.'
    const tooLong = descriptionError(bot.description)
    if (tooLong) return tooLong
    return write(botFile(brain, bot.id), renderBotFile(bot))
  }

  /** Bot file, memory, archive, and week marker. */
  function removeBotFiles(id: string): string | null {
    for (const f of [botFile(brain, id), memoryFile(brain, id), archiveFile(brain, id), weekFile(brain, id)]) {
      const err = removeBrainFile(role, brain, f)
      if (err) return err
    }
    return null
  }

  function readMail(): DeskMessage[] {
    return parseMail(readText(mailFile(brain)))
  }

  /** Next `m_N`, `j_N`, or `b_N` for message, job, or browse ids. Numbers, so j_10 follows j_9. */
  function newId(prefix: 'm' | 'j' | 'b'): string {
    if (!countersReady) {
      countersReady = true
      const bump = (p: string, v?: string) => {
        const m = v ? new RegExp(`^${p}_(\\d+)$`).exec(v) : null
        if (m) counters.set(p, Math.max(counters.get(p) || 0, Number(m[1])))
      }
      for (const m of readMail()) {
        bump('m', m.id)
        bump('j', m.job)
        bump('b', m.browseId)
      }
    }
    const n = (counters.get(prefix) || 0) + 1
    counters.set(prefix, n)
    return `${prefix}_${n}`
  }

  function appendMail(input: NewDeskMessage): { msg: DeskMessage; error: string | null } {
    const msg = { ...input, id: input.id || newId('m'), ts: input.ts || new Date().toISOString() } as DeskMessage
    const error = append(mailFile(brain), serializeMessage(msg, names()))
    return { msg, error }
  }

  /** Bot view (from or to that bot), after the fold. */
  function messagesFor(botId: string): DeskMessage[] {
    return foldMessages(readMail()).filter((m) => m.from === botId || m.to === botId)
  }

  /** What the renderer shows: fold, filter to the team or one bot, group browse steps, last `limit`. */
  function view(botId: string | null, limit = 200): DeskMessage[] {
    return groupBrowse(forThread(botId, foldMessages(readMail()))).slice(-limit)
  }

  function memoryLines(id: string): string[] {
    return readText(memoryFile(brain, id)).split('\n')
  }

  function createMemory(id: string): string | null {
    return write(memoryFile(brain, id), '')
  }

  /** Adds `remember` lines under today's `###` heading in This week. A line already in Standing is dropped. */
  function appendMemory(id: string, input: string[], now = new Date()): { added: string[]; error: string | null } {
    const file = memoryFile(brain, id)
    let text = readText(file)
    if (!text.trim()) text = `# ${readBot(id)?.name || id}\n\n## Standing\n\n## This week\n`
    let lines = text.split('\n')
    const standing = section(lines, 'Standing')
    const have = new Set(standing ? lines.slice(standing.start + 1, standing.end).map(bulletKey).filter(Boolean) : [])
    const added: string[] = []
    for (const raw of input.slice(0, 20)) {
      const line = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '').trim()
      const key = bulletKey(line)
      if (!line || have.has(key)) continue
      have.add(key)
      added.push(line)
    }
    if (!added.length) return { added, error: null }
    if (!section(lines, 'This week')) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
      lines.push('', '## This week', '')
    }
    const week = section(lines, 'This week') as Range
    const today = localDay(now)
    const head = lines.findIndex((l, i) => i > week.start && i < week.end && DATE_HEAD.exec(l)?.[1] === today)
    const bullets = added.map((l) => `- ${l}`)
    if (head >= 0) {
      let j = head + 1
      while (j < week.end && !/^###\s/.test(lines[j])) j++
      let at = j
      while (at > head + 1 && !lines[at - 1].trim()) at--
      lines.splice(at, 0, ...bullets)
    } else {
      let at = week.end
      while (at > week.start + 1 && !lines[at - 1].trim()) at--
      lines.splice(at, 0, `### ${today}`, ...bullets)
    }
    lines = lines.join('\n').replace(/\n*$/, '\n').split('\n')
    return { added, error: write(file, lines.join('\n')) }
  }

  /** Moves This-week lines dated more than 14 days ago to the archive. No model call. */
  function ageOut(id: string, now: Date): string | null {
    const lines = memoryLines(id)
    const today = dayNumber(localDay(now))
    const old = weekLines(lines, section(lines, 'This week')).filter((w) => w.date && today - dayNumber(w.date) > 14)
    if (!old.length) return null
    const err = append(archiveFile(brain, id), archiveBlock(old))
    if (err) return err
    return write(memoryFile(brain, id), dropLines(lines, new Set(old.map((w) => w.index))).join('\n'))
  }

  /** The prompt excerpt: Standing (1,200 max), then the newest This-week lines (800 max), 2,000 in all. Never the archive. */
  function readMemory(id: string, now = new Date()): string {
    ageOut(id, now)
    const lines = memoryLines(id)
    const st = section(lines, 'Standing')
    const body = st ? lines.slice(st.start + 1, st.end) : []
    while (body.length && !body[body.length - 1].trim()) body.pop()
    while (body.length && !body[0].trim()) body.shift()
    const standing = body.length ? cutAtLine(['## Standing', ...body].join('\n'), MEMORY_STANDING_CHARS) : ''
    const budget = Math.min(MEMORY_WEEK_CHARS, MEMORY_PROMPT_CHARS - (standing ? standing.length + 2 : 0))
    const all = weekLines(lines, section(lines, 'This week'))
    const head = '## This week'
    let size = head.length
    const keep: WeekLine[] = []
    const dates = new Set<string | null>()
    for (let i = all.length - 1; i >= 0; i--) {
      const w = all[i]
      const cost = 1 + w.line.length + (w.date && !dates.has(w.date) ? 5 + w.date.length : 0)
      if (size + cost > budget) break
      size += cost
      if (w.date) dates.add(w.date)
      keep.unshift(w)
    }
    let week = ''
    if (keep.length) {
      const out = [head]
      let last: string | null = null
      for (const w of keep) {
        if (w.date && w.date !== last) out.push(`### ${w.date}`)
        last = w.date
        out.push(w.line)
      }
      week = out.join('\n')
    }
    return [standing, week].filter(Boolean).join('\n\n')
  }

  /** This-week lines with their dates, oldest first, for the controller's tidy. */
  function memoryWeek(id: string): { date: string; line: string }[] {
    const lines = memoryLines(id)
    return weekLines(lines, section(lines, 'This week'))
      .filter((w): w is WeekLine & { date: string } => Boolean(w.date))
      .map((w) => ({ date: w.date, line: w.line }))
  }

  /** Tidy result: folded lines leave This week for the archive. Standing is replaced only when `standing` is a list. */
  function foldMemory(id: string, folded: { date: string; line: string }[], standing: string[] | null): string | null {
    let lines = memoryLines(id)
    const week = weekLines(lines, section(lines, 'This week'))
    const drop = new Set<number>()
    const moved: WeekLine[] = []
    for (const f of folded) {
      const hit = week.find((w) => !drop.has(w.index) && w.date === f.date && w.line === f.line)
      if (!hit) continue
      drop.add(hit.index)
      moved.push(hit)
    }
    if (moved.length) {
      const err = append(archiveFile(brain, id), archiveBlock(moved))
      if (err) return err
      lines = dropLines(lines, drop)
    }
    if (standing) {
      const st = section(lines, 'Standing')
      if (st) {
        lines.splice(st.start + 1, st.end - st.start - 1, ...standing, '')
      } else {
        const title = lines.findIndex((l) => /^#\s/.test(l))
        lines.splice(title + 1, 0, '', '## Standing', ...standing, '')
      }
    }
    if (!moved.length && !standing) return null
    return write(memoryFile(brain, id), lines.join('\n'))
  }

  function readWeekMarker(id: string): string {
    return readText(weekFile(brain, id)).trim()
  }

  function writeWeekMarker(id: string, week: string): string | null {
    return write(weekFile(brain, id), `${week}\n`)
  }

  return {
    brain,
    role,
    write,
    readBots,
    readBot,
    names,
    saveBot,
    removeBotFiles,
    readMail,
    newId,
    appendMail,
    messagesFor,
    view,
    createMemory,
    appendMemory,
    readMemory,
    memoryWeek,
    foldMemory,
    readWeekMarker,
    writeWeekMarker
  }
}
