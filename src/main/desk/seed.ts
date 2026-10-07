import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FALLBACK_ORDER } from '../../shared/desk.ts'
import type { DeskBot, DeskCli } from '../../shared/desk.ts'
import { DESK_DIR, botsDir } from './paths.ts'
import { createDeskStore, writeBrainFile } from './store.ts'
import type { Role } from './store.ts'

/**
 * First Desk open in a brain: write the five seed bots and their empty memory files when desk/bots/ is
 * missing, and keep desk/ out of git through .git/info/exclude. `detect` is passed in; this file does not
 * import ai-cli.ts.
 */

export const SEED_TEXT: Record<string, { name: string; description: string }> = {
  conductor: {
    name: 'Conductor',
    description:
      "I'm the one you talk to. I know who is on the team and what each of them is good at. When you ask for something, I look through the brain for the files that matter, brief the right teammate, and tell you who is on it. I answer 'where are we' from what the team has actually reported, not from guesses. I don't write the finished piece myself, and I never send anything, spend money, or change an ads account."
  },
  researcher: {
    name: 'Researcher',
    description:
      "I find what the brain already knows and quote it with the file path, so nobody has to guess. I look in client folders, context notes, past emails and reports saved in the brain, and plans. If the files don't say it, I say so plainly instead of filling the gap. When the work needs a draft, I hand my findings to Writer. I don't write client copy."
  },
  writer: {
    name: 'Writer',
    description:
      "I draft emails, reports, and posts from the briefing and the files I was pointed at, in the house voice: plain, short, honest, no hype. I don't invent facts, numbers, or promises that aren't in those files. When a draft is done I pass it to Checker. I only draft. A person sends."
  },
  checker: {
    name: 'Checker',
    description:
      "I read a draft against the files it came from and the house voice rules. I check names, numbers, dates, promises, and tone. I either pass it as ready with one line on why, or send it back to Writer once with specific fixes. I don't rewrite the whole thing, and I don't send it anywhere."
  },
  drafts: {
    name: 'Drafts',
    description:
      "I put an email or a text into the chat as the exact message that would go out: who it's to, the subject, and the body. I don't send it. The person sends from that tile, or doesn't. A reply stays in the same email thread. I don't invent facts that aren't in the files I was given."
  }
}

const LEAD_PREF: DeskCli[] = ['grok', 'claude', 'cursor', 'gpt']
const DRAFT_PREF: DeskCli[] = ['claude', 'grok', 'gpt', 'cursor']
export const SEED_MODEL_CLAUDE = 'claude-opus-5-5'

function pick(pref: DeskCli[], installed: DeskCli[]): DeskCli {
  return pref.find((c) => installed.includes(c)) || pref[0]
}

/** The five seed bots for this Mac's installed CLIs. No CLI at all: each bot's first preference. */
export function seedBots(installed: DeskCli[]): Omit<DeskBot, 'file'>[] {
  const lead = pick(LEAD_PREF, installed)
  const writer = pick(DRAFT_PREF, installed)
  const checker = installed.length ? FALLBACK_ORDER.find((c) => installed.includes(c) && c !== writer) || writer : 'claude'
  const cli: Record<string, DeskCli> = { conductor: lead, researcher: lead, writer, checker, drafts: writer }
  const effort: Record<string, string> = { conductor: 'high', researcher: 'high', writer: 'low', checker: 'low', drafts: 'low' }
  return Object.keys(SEED_TEXT).map((id) => ({
    id,
    name: SEED_TEXT[id].name,
    cli: cli[id],
    model: cli[id] === 'claude' ? SEED_MODEL_CLAUDE : 'default',
    effort: effort[id],
    description: SEED_TEXT[id].description
  }))
}

/** True when a .gitignore line ignores the whole desk/ folder. desk/mail/ alone does not. */
export function ignoresDesk(gitignore: string): boolean {
  const whole = new Set([DESK_DIR, `${DESK_DIR}/`, `${DESK_DIR}/*`, `${DESK_DIR}/**`])
  return gitignore.split(/\r?\n/).some((raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) return false
    return whole.has(line.replace(/^\//, ''))
  })
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Adds `desk/` to .git/info/exclude when the brain is a clone and neither file already ignores it. */
export function excludeDesk(brain: string, role: Role): { added: boolean; error: string | null } {
  if (!isDir(join(brain, '.git'))) return { added: false, error: null }
  if (ignoresDesk(readText(join(brain, '.gitignore')))) return { added: false, error: null }
  const exclude = join(brain, '.git', 'info', 'exclude')
  const current = readText(exclude)
  if (ignoresDesk(current)) return { added: false, error: null }
  const lead = current && !current.endsWith('\n') ? '\n' : ''
  const error = writeBrainFile(role, brain, exclude, `${lead}${DESK_DIR}/\n`, { append: true })
  return { added: !error, error }
}

export type SeedResult = { seeded: boolean; excluded: boolean; error: string | null }

export function seedDesk(opts: { brain: string; role: Role; detect: () => Record<DeskCli, boolean> }): SeedResult {
  const { brain, role } = opts
  const ex = excludeDesk(brain, role)
  if (ex.error) return { seeded: false, excluded: false, error: ex.error }
  if (existsSync(botsDir(brain))) return { seeded: false, excluded: ex.added, error: null }
  const found = opts.detect()
  const installed = FALLBACK_ORDER.filter((c) => found[c])
  const store = createDeskStore({ brain, role })
  for (const bot of seedBots(installed)) {
    const error = store.saveBot(bot) || store.createMemory(bot.id)
    if (error) return { seeded: false, excluded: ex.added, error }
  }
  return { seeded: true, excluded: ex.added, error: null }
}
