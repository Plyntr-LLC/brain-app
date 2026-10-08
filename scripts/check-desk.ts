import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Desk slice-8 check. Three parts, nothing else:
// 1. A scripted controller fixture: the real controller, store, bus, seed and welcome in a temp brain, with a
//    fake runner, a fake browser and dry-run senders. No model call, no send.
// 2. CLI probes in fresh temp folders with argvFor from runner.ts. The write probe spawns that array
//    (stdin ignore, 110s). The MCP probe is unchanged: production argv must not create marker.txt, and
//    its control is still a hand edit of that array. stdin 'ignore', MCP killed at 60 s.
// 3. One gmailFrom read. It never sends and never opens a browser.
// It does not launch the Desk UI and does not grade the click-through.
// node --experimental-strip-types scripts/check-desk.ts

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}
const AGENCY_BRAIN = join(homedir(), 'Projects', 'agency-brain')
const work = mkdtempSync(join(tmpdir(), 'brain-check-desk-'))
;(globalThis as { __userData?: string }).__userData = join(work, 'userData')
mkdirSync(join(work, 'userData'), { recursive: true })

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getVersion: () => '0.0.0', getPath: () => globalThis.__userData, getAppPath: () => '', isPackaged: false, on() {} }
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
export const clipboard = {}, dialog = {}, ipcMain = { handle() {}, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', p)).href
const shared = (await import(src('shared/desk.ts'))) as typeof import('../src/shared/desk.ts')
const seed = (await import(src('main/desk/seed.ts'))) as typeof import('../src/main/desk/seed.ts')
const ctl = (await import(src('main/desk/controller.ts'))) as typeof import('../src/main/desk/controller.ts')
const storeMod = (await import(src('main/desk/store.ts'))) as typeof import('../src/main/desk/store.ts')
const paths = (await import(src('main/desk/paths.ts'))) as typeof import('../src/main/desk/paths.ts')
const runnerMod = (await import(src('main/desk/runner.ts'))) as typeof import('../src/main/desk/runner.ts')
const sendersMod = (await import(src('main/desk/senders.ts'))) as typeof import('../src/main/desk/senders.ts')
const welcomeMod = (await import(src('main/desk/welcome.ts'))) as typeof import('../src/main/desk/welcome.ts')
const aicli = (await import(src('main/ai-cli.ts'))) as typeof import('../src/main/ai-cli.ts')
const opus = (await import(src('main/factory/opus.ts'))) as typeof import('../src/main/factory/opus.ts')

type DeskCli = import('../src/shared/desk.ts').DeskCli
type DeskMessage = import('../src/shared/desk.ts').DeskMessage
type RunResult = import('../src/main/desk/runner.ts').RunResult
type RunOptions = import('../src/main/desk/runner.ts').RunOptions

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: ok ? '' : detail.slice(0, 400) })
const info: string[] = []

// ---------- 1. scripted controller fixture ----------

const NOW = new Date(2026, 9, 7, 9, 14, 0)
const GROK_ONLY = () => ({ grok: true, claude: false, gpt: false, cursor: false })
const NOTE = 'clients/summit/notes/2026-10-01.md'
const NOTE_TEXT = '# Summit, October 1\n\nLeads are up 12 percent.\nCost per lead is down.\nThe budget question is still open.\n'
const CLICK_TASK =
  'Find the newest note under clients/summit/ and have Writer draft three bullets from it, then have Checker look it over. Writer should remember that Joe wants bullets.'
const PACK_TASK = 'Find the newest Summit note and pull out the three main points. Hand them to Writer when you have them.'
const WHY = 'Joe wants three bullets from the newest Summit note.'
const EVERYONE = 'Everyone is on Grok for now. You can give anyone a different model on the right.'
const READY_LINE = "Writer uses Claude, which isn't on this Mac yet."
const SPEND_LINE = 'Approving records your yes. It does not spend money or change the ads account.'
const DRY = 'Dry run. Nothing left this Mac.'

const fence = (tag: string, lines: string[]) => ['```' + tag, ...lines, '```'].join('\n')
const assignBlock = (bot: string, task: string, why: string, files: string[]) => fence('assign', [`bot: ${bot}`, `task: ${task}`, `why: ${why}`, 'files:', ...files.map((f) => `- ${f}`)])
const sendBlock = (to: string, text: string, files: string[] = []) => fence('send', [`to: ${to}`, ...(files.length ? ['files:', ...files.map((f) => `- ${f}`)] : []), '', text])
const emailBlock = (to: string, subject: string, body: string) => fence('email', ['reply: ', `to: ${to}`, 'cc:', `subject: ${subject}`, '', body])
const holdBlock = (need: string, text: string) => fence('hold', [`need: ${need}`, '', text])
const rememberBlock = (line: string) => fence('remember', [`- ${line}`])
const hireBlock = (name: string, description: string) => fence('hire', [`name: ${name}`, 'cli: grok', 'model: default', 'effort: low', '', description])

type Step = { text?: string; fail?: 'not-installed' | 'not-signed-in' | 'exited' | 'empty'; detail?: string }

function fakeRunner() {
  const queues = new Map<string, Step[]>()
  const prompts: { id: string; prompt: string }[] = []
  return {
    prompts,
    queue(id: string, ...steps: Step[]) {
      queues.set(id, [...(queues.get(id) || []), ...steps])
    },
    last(id: string): string {
      return [...prompts].reverse().find((p) => p.id === id)?.prompt || ''
    },
    count(id: string): number {
      return prompts.filter((p) => p.id === id).length
    },
    run(o: RunOptions): Promise<RunResult> {
      prompts.push({ id: o.bot.id, prompt: o.prompt })
      const step = queues.get(o.bot.id)?.shift()
      if (!step) info.push(`unscripted turn for ${o.bot.id} answered "Noted."`)
      const pair = { cli: o.bot.cli, model: o.bot.model }
      if (step?.fail) return Promise.resolve({ status: 'failed', failure: step.fail, ...(step.detail ? { detail: step.detail } : {}), lastTry: pair, tries: [pair] })
      return Promise.resolve({ status: 'ok', text: step?.text ?? 'Noted.', lastTry: pair, tries: [pair] })
    },
    stop: () => false,
    stopAll: () => [] as string[],
    keepWaiting: () => false
  }
}

const fakeBrowser = {
  open: async () => undefined,
  cancel: () => undefined,
  release: () => undefined,
  focus: () => undefined,
  windowOpen: () => false,
  clickApproved: async (_name: string, url: string) => ({ refused: 'page-changed' as const, url }),
  runStep: async () => ({ noChrome: true as const })
}

async function until(ok: () => boolean, label: string): Promise<boolean> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!ok()) info.push(`timed out waiting: ${label}`)
  return ok()
}

async function fixture() {
  const brain = mkdtempSync(join(work, 'brain-'))
  mkdirSync(join(brain, 'clients', 'summit', 'notes'), { recursive: true })
  writeFileSync(join(brain, NOTE), NOTE_TEXT)
  writeFileSync(join(brain, 'clients', 'summit', 'context.md'), 'Summit sells steel buildings.\n')

  // Seed and the welcome payload.
  seed.seedDesk({ brain, role: 'owner', detect: GROK_ONLY })
  const runner = fakeRunner()
  // Dry-run senders with no spawn: sendEmail returns the dry-run result, check and lookup never spawn.
  const real = sendersMod.createSenders({ dryRun: true })
  const senders = {
    ...real,
    gmailFrom: async () => 'joe@example.com',
    lookupText: async () => ({ sendable: true, guid: 'chat-guid-brent', label: 'Brent' })
  }
  const desk = ctl.createDeskController({ brain, role: 'owner', runner, browser: fakeBrowser, senders, detect: GROK_ONLY, now: () => NOW, tokenReady: () => true })
  const mail = () => desk.store.readMail()
  const folded = () => storeMod.foldMessages(mail())
  const state = (id: string) => desk.states().find((s) => s.id === id)?.state

  const bots = desk.list().bots
  check('F seed writes the five bots in order', JSON.stringify(bots.map((b) => b.name)) === JSON.stringify(['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts']), JSON.stringify(bots.map((b) => b.name)))
  check('F seed puts every bot on Grok when only Grok is on this Mac', bots.every((b) => b.cli === 'grok'), JSON.stringify(bots.map((b) => b.cli)))
  check('F seed writes an empty memory file per bot', bots.every((b) => existsSync(paths.memoryFile(brain, b.id))))

  let w = welcomeMod.buildWelcome({ brain, bots, detect: GROK_ONLY, greetingName: 'Joe' })
  check('F welcome greets Joe and names the team', w.greeting.startsWith("Hi Joe. I'm Conductor. You talk to me, and I hand the work to Researcher, Writer, Checker, and Drafts."), w.greeting)
  check(
    'F starters name the newest client',
    JSON.stringify(w.starters.map((s) => s.label)) === JSON.stringify(['Catch me up on Summit', "Draft a reply to Summit's last note", 'What can the team do?']),
    JSON.stringify(w.starters)
  )
  check('F everyone on Grok with Grok only: the everyone line, no readiness', w.everyoneLine === EVERYONE && w.readiness.length === 0, JSON.stringify(w))
  check('F composer talks to Conductor', w.composerPlaceholder === 'Message Conductor' && !w.composerDisabled, w.composerPlaceholder)

  const writer = bots.find((b) => b.id === 'writer')!
  check('F Writer file can say Claude', desk.saveBot({ id: 'writer', name: 'Writer', cli: 'claude', model: 'claude-opus-5-5', effort: 'low', description: writer.description }) === null)
  w = welcomeMod.buildWelcome({ brain, bots: desk.list().bots, detect: GROK_ONLY, greetingName: 'Joe' })
  check(
    'F readiness: Writer on Claude, Grok only, one line that offers Grok',
    JSON.stringify(w.readiness) === JSON.stringify([{ botId: 'writer', text: READY_LINE, cli: 'grok', model: 'default' }]) && w.everyoneLine === null,
    JSON.stringify(w)
  )
  check('F the readiness button reads Use Grok for Writer', welcomeMod.readinessButton(w.readiness[0]?.cli || 'grok', 'Writer') === 'Use Grok for Writer')
  const entry = w.readiness[0]
  desk.saveBot({ id: 'writer', name: 'Writer', cli: entry.cli, model: entry.model, effort: 'low', description: writer.description })
  w = welcomeMod.buildWelcome({ brain, bots: desk.list().bots, detect: GROK_ONLY, greetingName: 'Joe' })
  check('F the readiness pick sticks: Writer on grok, model default, the line is gone', w.readiness.length === 0 && desk.list().bots.find((b) => b.id === 'writer')?.model === 'default', JSON.stringify(w.readiness))

  // The click-through's first message, scripted: a briefing, two handoffs, a memory line, a report.
  runner.queue('conductor', { text: `Researcher is on it.\n\n${assignBlock('researcher', PACK_TASK, WHY, [NOTE, 'clients/summit/missing.md', '../outside.md'])}` })
  runner.queue('researcher', { text: `Found the note.\n\n${sendBlock('writer', `Three points from ${NOTE}: leads up, cost down, budget still open.`, [NOTE])}` })
  runner.queue('writer', { text: `Draft is with Checker.\n\n${rememberBlock('Joe wants bullets, not a long email.')}\n\n${sendBlock('checker', 'Draft:\n- Leads up 12%\n- Cost per lead down\n- Budget question still open')}` })
  runner.queue('checker', { text: 'Ready. Names and numbers match the note.' })
  await desk.say(CLICK_TASK)
  await until(() => mail().some((m) => m.kind === 'report' && m.from === 'checker'), 'checker report')

  const task = mail().find((m) => m.kind === 'task')
  check('F the task is from You to Conductor', task?.from === 'me' && task?.to === 'conductor' && task?.text === CLICK_TASK, JSON.stringify(task))
  const pack = mail().find((m) => m.kind === 'pack')
  check('F a Briefing goes from Conductor to Researcher before the worker starts', pack?.from === 'conductor' && pack?.to === 'researcher' && pack?.text === PACK_TASK, JSON.stringify(pack))
  check('F the Briefing keeps the why and the real path', pack?.pack?.why === WHY && JSON.stringify(pack?.pack?.files.map((f) => f.path)) === JSON.stringify([NOTE]), JSON.stringify(pack?.pack))
  check('F missing and outside paths are dropped', (pack?.pack?.dropped || []).includes('clients/summit/missing.md') && (pack?.pack?.dropped || []).includes('../outside.md'), JSON.stringify(pack?.pack?.dropped))
  check('F the excerpt is the start of the file', (pack?.pack?.files[0]?.excerpt || '').includes('Leads are up 12 percent.'))
  const first = runner.prompts.findIndex((p) => p.id === 'researcher')
  check('F Researcher reads the Briefing with its excerpt', first >= 0 && runner.prompts[first].prompt.includes(PACK_TASK) && runner.prompts[first].prompt.includes('Leads are up 12 percent.'))
  const sends = mail().filter((m) => m.kind === 'send')
  check(
    'F two handoffs: Researcher to Writer, Writer to Checker',
    JSON.stringify(sends.map((s) => `${s.from}>${s.to}`)) === JSON.stringify(['researcher>writer', 'writer>checker']),
    JSON.stringify(sends.map((s) => `${s.from}>${s.to}`))
  )
  check('F the handoffs carry the Briefing line of work', !!pack?.job && sends.every((s) => s.job === pack.job), JSON.stringify([pack?.job, ...sends.map((s) => s.job)]))
  check("F Writer's prompt has the named file's excerpt", runner.last('writer').includes('Leads are up 12 percent.'))
  const note = mail().find((m) => m.kind === 'note')
  check('F Writer saves a note', note?.from === 'writer' && JSON.stringify(note?.noteLines) === JSON.stringify(['Joe wants bullets, not a long email.']), JSON.stringify(note))
  const memory = readFileSync(paths.memoryFile(brain, 'writer'), 'utf8')
  check('F the memory line sits under a ### date', new RegExp(`### ${shared.localDay(NOW)}\\n- Joe wants bullets, not a long email\\.`).test(memory), memory)
  const report = mail().find((m) => m.kind === 'report')
  check('F Checker reports Done into the thread', report?.from === 'checker' && report?.text === 'Ready. Names and numbers match the note.' && typeof report?.report?.seconds === 'number', JSON.stringify(report))
  check('F a turn with handoffs is a reply, not a report', ['researcher', 'writer'].every((id) => mail().some((m) => m.kind === 'reply' && m.from === id) && !mail().some((m) => m.kind === 'report' && m.from === id)))
  check('F the conductor did not wake for the report', runner.count('conductor') === 1, `conductor turns=${runner.count('conductor')}`)
  const folderLine = 'Your working folder is the open brain. You may write files there and run commands there. You do not send mail, send a text, spend, or change an ads account.'
  const conductorPromptText = runner.last('conductor')
  const writerPromptText = runner.last('writer')
  check(
    'F both prompts may write and run commands, and do not say to end on a tile',
    conductorPromptText.includes(folderLine) &&
      writerPromptText.includes(folderLine) &&
      !conductorPromptText.includes('End with email, sms, or hold') &&
      !writerPromptText.includes('End with email, sms, or hold') &&
      !conductorPromptText.includes('You cannot write files') &&
      !writerPromptText.includes('You cannot write files') &&
      conductorPromptText.includes(runnerMod.CONDUCTOR_ENDS) &&
      writerPromptText.includes(runnerMod.WORKER_ENDS),
    'folder line or endings'
  )

  // The background line's status card.
  const status = desk.status()
  const statusMsg = mail().find((m) => m.kind === 'status')
  const statusLines = (statusMsg?.text || '').split('\n')
  check('F status is one line per bot, by name', statusLines.length === 5 && statusLines.every((l, i) => l.startsWith(['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts'][i] + ' · ')), JSON.stringify({ status, statusLines }))

  // Email tile: Not now, then Send, in dry run.
  runner.queue('drafts', { text: `Here is the note for Brent.\n\n${emailBlock('Brent <brent@example.com>', 'September numbers', 'September numbers are in the note.')}` })
  await desk.say('Draft a short note to Brent that the September numbers are in.', 'drafts')
  await until(() => folded().some((m) => m.kind === 'email'), 'email tile')
  let email = folded().filter((m) => m.kind === 'email')
  check('F the email tile shows From, To, Subject, body, and can send', email.length === 1 && email[0].email?.from === 'joe@example.com' && email[0].email?.to === 'Brent <brent@example.com>' && email[0].email?.subject === 'September numbers' && email[0].email?.sendable === true && !email[0].actedAt, JSON.stringify(email))
  check('F Drafts waits on you', state('drafts') === 'waiting-you', String(state('drafts')))
  runner.queue('drafts', { text: 'Okay. It stays here until you send it.' })
  const draftsTurns = runner.count('drafts')
  await desk.answerEmail(email[0].id, 'no')
  await until(() => runner.count('drafts') > draftsTurns, 'drafts wake after Not now')
  email = folded().filter((m) => m.kind === 'email')
  check('F Not now folds to one tile marked not sent, no time', email.length === 1 && email[0].email?.sent === 'no' && !email[0].actedAt && !!email[0].replaces, JSON.stringify(email))
  check('F Not now wakes Drafts with the exact sentence', runner.last('drafts').includes(runnerMod.SAID_NO), runner.last('drafts').slice(-400))
  check('F Drafts is back to waiting on you after Not now', state('drafts') === 'waiting-you', String(state('drafts')))
  runner.queue('drafts', { text: 'Sent.' })
  await desk.answerEmail(email[0].id, 'yes')
  await until(() => folded().some((m) => m.kind === 'email' && !!m.actedAt), 'email sent')
  email = folded().filter((m) => m.kind === 'email')
  check('F Send folds to one tile: sent, stamped, dry-run note', email.length === 1 && email[0].email?.sent === 'yes' && email[0].actedAt === NOW.toISOString() && email[0].email?.note === DRY, JSON.stringify(email))
  const before = mail().length
  await desk.answerEmail(email[0].id, 'yes')
  check('F a second Send does nothing', mail().length === before, `mail ${before} -> ${mail().length}`)

  // A spend hold: Approve records the yes.
  runner.queue('researcher', { text: `Needs your OK first.\n\n${holdBlock('spend', 'Raise the Summit daily budget to $40.')}` }, { text: 'Recorded.' })
  await desk.say('Can we raise the Summit budget to $40 a day?', 'researcher')
  await until(() => folded().some((m) => m.kind === 'hold'), 'hold')
  let hold = folded().filter((m) => m.kind === 'hold')
  check('F the spend hold stores its sentence and the account line', hold.length === 1 && hold[0].text === `Raise the Summit daily budget to $40. ${SPEND_LINE}`, JSON.stringify(hold))
  check('F Researcher waits on you for the hold', state('researcher') === 'waiting-you', String(state('researcher')))
  await desk.answerHold(hold[0].id, 'yes')
  await until(() => folded().some((m) => m.kind === 'hold' && m.hold?.answer === 'yes'), 'hold approved')
  hold = folded().filter((m) => m.kind === 'hold')
  check('F Approve folds to one hold: yes, stamped', hold.length === 1 && hold[0].hold?.answer === 'yes' && hold[0].actedAt === NOW.toISOString(), JSON.stringify(hold))

  // An error card, then Try again.
  runner.queue('writer', { fail: 'exited', detail: 'something broke' })
  await desk.say('Tighten the second bullet.', 'writer')
  await until(() => mail().some((m) => m.kind === 'error'), 'error')
  const err = mail().find((m) => m.kind === 'error')
  check('F the error card is the plain sentence, detail kept apart', err?.text === 'Writer stopped with an error.' && err?.detail === 'something broke' && err?.lastTry?.cli === 'grok', JSON.stringify(err))
  check('F the error can be tried again', (err?.inputs || []).length > 0, JSON.stringify(err?.inputs))
  runner.queue('writer', { text: 'Tightened.' })
  const writerTurns = runner.count('writer')
  await desk.retry(err!.id)
  await until(() => runner.count('writer') > writerTurns, 'retry turn')
  check('F Try again reruns the same words', runner.last('writer').includes('Tighten the second bullet.'))

  // A hire, the form's 800 error, a taken name, a remove, and the next hire of that name.
  runner.queue('conductor', { text: `Designer is on the team.\n\n${hireBlock('Designer', 'Writes headlines only. Does not send anything.')}` })
  await desk.say('Add a teammate named Designer who only writes headlines.')
  await until(() => mail().some((m) => m.kind === 'hire'), 'hire')
  const hired = mail().find((m) => m.kind === 'hire')
  check('F the conductor adds Designer without the form', hired?.hire?.id === 'designer' && hired?.hire?.name === 'Designer' && existsSync(paths.botFile(brain, 'designer')), JSON.stringify(hired))
  check('F the roster shows Designer', desk.list().bots.some((b) => b.name === 'Designer'))
  const long = 'Writes headlines and nothing else. Never sends anything. '.repeat(20).slice(0, 911) + '.'
  const tooLong = desk.saveBot({ id: 'ad-checker', name: 'Ad Checker', cli: 'grok', model: 'default', effort: 'low', description: long })
  check('F the form refuses 912 characters', tooLong === 'Keep it under 800 characters (now 912).' && !existsSync(paths.botFile(brain, 'ad-checker')), String(tooLong))
  const takenName = desk.saveBot({ id: 'designer-x', name: 'designer', cli: 'grok', model: 'default', effort: 'low', description: 'Headlines.' })
  check('F a taken name is refused', takenName === 'That name is taken.', String(takenName))
  check('F Designer can be removed while idle', desk.removeBot('designer') === null && !existsSync(paths.botFile(brain, 'designer')))
  check('F the removed line names Designer', mail().some((m) => m.kind === 'system' && m.system === 'removed' && m.text === 'Designer was removed.') && desk.list().removedNames.designer === 'Designer')
  runner.queue('conductor', { text: `Added again.\n\n${hireBlock('Designer', 'Writes headlines only.')}` })
  await desk.say('Add Designer back.')
  await until(() => mail().filter((m) => m.kind === 'hire').length === 2, 'second hire')
  const again = mail().filter((m) => m.kind === 'hire')[1]
  check('F a removed id is never reused: Designer 2', again?.hire?.id === 'designer-2' && again?.hire?.name === 'Designer 2', JSON.stringify(again?.hire))

  // Nothing raw reaches the thread.
  check('F no stored text holds a fence', !mail().some((m: DeskMessage) => m.text.includes('```')))
  check('F the mail file is markdown in the brain', existsSync(paths.mailFile(brain)) && readFileSync(paths.mailFile(brain), 'utf8').includes('<!-- desk '))
}

try {
  await fixture()
} catch (e) {
  check('F fixture ran', false, String((e as Error)?.stack || e))
}

// ---------- 2. CLI probes in temp folders ----------

const PROBE_MS = 60_000
const WRITE_MS = 110_000
const WRITE_PROMPT = 'Create probe.txt in the working folder containing exactly desk-probe. Run a command that creates ran.txt containing exactly ran. Reply done.'
const NEVER_FLAGS = ['--always-approve', '--bare', '--dangerously-skip-permissions', '--fallback-model', '--tools', '--dangerously-bypass-approvals-and-sandbox', '--force', '--yolo', '--approve-mcps']
const GROK_RULES = [
  'MCPTool(*)',
  'mcp__*',
  'Bash(sudo *)',
  'Bash(su *)',
  'Bash(rm -rf /*)',
  'Bash(rm -r /*)',
  'Bash(curl *|*bash*)',
  'Bash(curl *|*sh*)',
  'Bash(wget *|*bash*)',
  'Bash(wget *|*sh*)',
  'Bash(mkfs*)',
  'Bash(dd if=/dev/*)',
  'Bash(shutdown*)',
  'Bash(reboot*)',
  'Bash(halt*)',
  'Bash(poweroff*)',
  'Write(~/.ssh/authorized_keys)',
  'Edit(~/.ssh/authorized_keys)',
  'Write(/etc/**)',
  'Edit(/etc/**)',
  'Write(/usr/**)',
  'Write(/boot/**)',
  'Edit(/usr/**)',
  'Edit(/boot/**)'
]
const MCP_PROMPT = 'Call the probe tool. If you cannot, reply none.'
const SIGNED_OUT = /log(?:ged)?\s*-?\s*in|sign(?:ed)?\s*-?\s*in|auth|\b401\b/i

const PROBE_SERVER = `'use strict'
// Desk check MCP probe. Writes marker.txt only when a tool handler runs, never on startup.
const fs = require('node:fs')
const path = require('node:path')
let buf = ''
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined || msg.id === null) continue
    if (msg.method === 'initialize') reply(msg.id, { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } })
    else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'probe', description: 'The probe tool. Call it when asked to call the probe tool.', inputSchema: { type: 'object', properties: {} } }] })
    else if (msg.method === 'tools/call') {
      fs.writeFileSync(path.join(__dirname, 'marker.txt'), 'probe ran\\n')
      reply(msg.id, { content: [{ type: 'text', text: 'probe ran' }] })
    } else if (msg.method === 'ping') reply(msg.id, {})
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }) + '\\n')
  }
})
`

type Run = { code: number | null; killed: boolean; ms: number; stdout: string; stderr: string; wrote: boolean; argv: string[] }
type Verdict = 'pass' | 'fail' | 'not proven' | 'skipped'
type Block = { cli: DeskCli; block: 'write' | 'mcp'; verdict: Verdict; why: string; blocked?: Run; control?: Run }

function freshDir(cli: DeskCli, block: string, role: string): string {
  const dir = mkdtempSync(join(tmpdir(), `desk-probe-${cli}-${block}-${role}-`))
  const real = realpathSync(dir)
  if (existsSync(AGENCY_BRAIN) && (real === realpathSync(AGENCY_BRAIN) || real.startsWith(realpathSync(AGENCY_BRAIN) + '/'))) {
    throw new Error(`refusing to probe inside the agency brain: ${real}`)
  }
  return real
}

function mcpFiles(dir: string) {
  const server = join(dir, 'probe-mcp.cjs')
  writeFileSync(server, PROBE_SERVER)
  const entry = { mcpServers: { probe: { command: process.execPath, args: [server] } } }
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(entry, null, 2))
  mkdirSync(join(dir, '.cursor'), { recursive: true })
  writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify(entry, null, 2))
  mkdirSync(join(dir, '.grok'), { recursive: true })
  writeFileSync(join(dir, '.grok', 'config.toml'), `[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\n`)
}

function killGroup(child: ChildProcess) {
  try {
    if (typeof child.pid !== 'number') throw new Error('no pid')
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
}

function probe(cli: DeskCli, argv: string[], dir: string, file: string, ms = PROBE_MS): Promise<Run> {
  const bin = aicli.resolveBin(cli) as string
  const env = cli === 'claude' ? opus.opusEnv(aicli.binEnv()) : aicli.binEnv()
  const started = Date.now()
  const done = (r: Omit<Run, 'ms' | 'wrote' | 'argv'>): Run => ({ ...r, ms: Date.now() - started, wrote: existsSync(join(dir, file)), argv })
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(bin, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (e) {
      resolve(done({ code: null, killed: false, stdout: '', stderr: String((e as Error)?.message || e) }))
      return
    }
    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hard)
      killGroup(child)
      resolve(done({ code, killed, stdout, stderr }))
    }
    const timer = setTimeout(() => {
      killed = true
      killGroup(child)
    }, ms)
    const hard = setTimeout(() => finish(null), ms + 10_000)
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 20_000) stdout += String(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 20_000) stderr += String(d)
    })
    child.on('error', (e) => {
      stderr += String(e.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

const dropPair = (args: string[], flag: string, value: string) => args.filter((a, i) => !(a === flag && args[i + 1] === value) && !(a === value && args[i - 1] === flag))
const beforePrompt = (args: string[], ...items: string[]) => [...args.slice(0, -1), ...items, args[args.length - 1]]
const pairIs = (argv: string[], flag: string, value: string) => argv.some((a, i) => a === flag && argv[i + 1] === value)
const denyAt = (argv: string[], rule: string) => argv.findIndex((a, i) => a === '--deny' && argv[i + 1] === rule)

function flagWhy(cli: DeskCli, argv: string[]): string {
  for (const flag of NEVER_FLAGS) if (argv.includes(flag)) return `never-list flag ${flag}`
  if (cli === 'grok') {
    if (!pairIs(argv, '--permission-mode', 'bypassPermissions')) return 'missing bypassPermissions'
    if (pairIs(argv, '--permission-mode', 'plan')) return 'still plan mode'
    if (!argv.includes('--no-subagents') || !argv.includes('--disable-web-search')) return 'missing grok limits'
    let prev = -1
    for (const rule of GROK_RULES) {
      const at = denyAt(argv, rule)
      if (at < 0 || at <= prev) return `deny ${rule} missing or out of order`
      prev = at
    }
    for (const rule of ['Bash(*)', 'Write(**)', 'Edit(**)']) if (denyAt(argv, rule) >= 0) return `still denies ${rule}`
    return ''
  }
  if (cli === 'claude') {
    if (!pairIs(argv, '--permission-mode', 'bypassPermissions')) return 'missing bypassPermissions'
    if (pairIs(argv, '--permission-mode', 'plan') || argv.includes('--restricted')) return 'still read-only'
    if (!pairIs(argv, '--permission-prompts', 'none')) return 'missing permission-prompts none'
    if (!argv.includes('--strict-mcp-config')) return 'missing strict-mcp-config'
    return ''
  }
  if (cli === 'gpt') {
    if (!pairIs(argv, '--sandbox', 'workspace-write')) return 'sandbox is not workspace-write'
    if (pairIs(argv, '--sandbox', 'read-only') || pairIs(argv, '--sandbox', 'danger-full-access')) return 'wrong sandbox'
    return ''
  }
  if (argv.includes('--mode=ask')) return 'still ask mode'
  if (!pairIs(argv, '--sandbox', 'enabled')) return 'missing sandbox enabled'
  if (!argv.includes('--trust')) return 'missing trust'
  return ''
}

function fileText(dir: string, name: string): string {
  const p = join(dir, name)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''
}

/** The MCP block removed: the control may call the probe server. */
function mcpControl(cli: DeskCli, args: string[], dir: string): string[] {
  switch (cli) {
    case 'grok':
      return dropPair(dropPair(args, '--deny', 'MCPTool(*)'), '--deny', 'mcp__*')
    case 'claude':
      return [...args, '--mcp-config', join(dir, '.mcp.json')]
    case 'cursor':
      return beforePrompt(args, '--approve-mcps')
    case 'gpt':
      return args
  }
}

function judge(blocked: Run, control: Run): { verdict: Verdict; why: string } {
  if (blocked.wrote) return { verdict: 'fail', why: 'the blocked run wrote its file' }
  if (control.wrote) return { verdict: 'pass', why: 'the control wrote its file and the blocked run did not' }
  return { verdict: 'not proven', why: 'the control did not write its file either' }
}

const signedOut = (r: Run) => !r.killed && r.code !== 0 && SIGNED_OUT.test(`${r.stderr}\n${r.stdout}`)
const BOT = { model: 'default', effort: 'default' }

async function probeCli(cli: DeskCli): Promise<Block[]> {
  const out: Block[] = []
  const wDir = freshDir(cli, 'write', 'seat')
  const wArgs = runnerMod.argvFor({ cli, ...BOT }, WRITE_PROMPT, wDir)
  const absentBefore = !existsSync(join(wDir, 'probe.txt')) && !existsSync(join(wDir, 'ran.txt'))
  const wRun = await probe(cli, wArgs, wDir, 'probe.txt', WRITE_MS)
  if (signedOut(wRun)) {
    const why = `not signed in: ${(wRun.stderr || wRun.stdout).trim().split('\n')[0]}`
    return [
      { cli, block: 'write', verdict: 'skipped', why, blocked: wRun },
      { cli, block: 'mcp', verdict: 'skipped', why }
    ]
  }
  const flags = flagWhy(cli, wRun.argv)
  const probeBody = fileText(wDir, 'probe.txt')
  const ranBody = fileText(wDir, 'ran.txt')
  const bodiesOk = probeBody === 'desk-probe' && ranBody === 'ran'
  const writeVerdict: Verdict = !absentBefore ? 'fail' : flags || !bodiesOk ? 'fail' : 'pass'
  const writeWhy = !absentBefore
    ? 'probe.txt or ran.txt existed before the run'
    : flags
      ? flags
      : bodiesOk
        ? 'probe.txt is desk-probe and ran.txt is ran'
        : `bodies probe=${JSON.stringify(probeBody)} ran=${JSON.stringify(ranBody)}`
  out.push({ cli, block: 'write', verdict: writeVerdict, why: writeWhy, blocked: wRun })

  if (cli === 'gpt') {
    out.push({ cli, block: 'mcp', verdict: 'skipped', why: 'Codex does not read .mcp.json, and dropping --ignore-user-config would load the real MCP config. The gpt MCP block is not proven by this check.' })
    return out
  }
  const mDir = freshDir(cli, 'mcp', 'blocked')
  mcpFiles(mDir)
  const mBlocked = await probe(cli, runnerMod.argvFor({ cli, ...BOT }, MCP_PROMPT, mDir), mDir, 'marker.txt')
  if (cli === 'grok') {
    // Grok merges ~/.grok/config.toml with the Claude, Cursor and .mcp.json servers, plus plugins. Without the two
    // MCP denies, this Mac's real servers (iMessage, Gmail, Chrome, Stripe, ads) would be in reach of the turn.
    out.push({
      cli,
      block: 'mcp',
      verdict: mBlocked.wrote ? 'fail' : 'not proven',
      why: mBlocked.wrote
        ? 'the blocked run wrote its file'
        : "control not run: without the MCP denies grok loads this Mac's real MCP servers (its own config plus the merged Claude and Cursor ones), the same reason the gpt MCP control is skipped. The blocked run did not write marker.txt.",
      blocked: mBlocked
    })
    return out
  }
  const mcDir = freshDir(cli, 'mcp', 'control')
  mcpFiles(mcDir)
  const mControl = await probe(cli, mcpControl(cli, runnerMod.argvFor({ cli, ...BOT }, MCP_PROMPT, mcDir), mcDir), mcDir, 'marker.txt')
  out.push({ cli, block: 'mcp', ...judge(mBlocked, mControl), blocked: mBlocked, control: mControl })
  return out
}

// `--fixture-only` runs part 1 alone: no CLI spawn, no Gmail read.
const fixtureOnly = process.argv.includes('--fixture-only')
const found = fixtureOnly ? { grok: false, claude: false, gpt: false, cursor: false } : aicli.detect()
const installed = shared.DESK_CLIS.filter((c) => found[c])
const missing = shared.DESK_CLIS.filter((c) => !found[c])
const blocks: Block[] = (await Promise.all(installed.map((cli) => probeCli(cli).catch((e) => [{ cli, block: 'write' as const, verdict: 'fail' as const, why: String((e as Error)?.message || e) }])))).flat()
const skipWhy = fixtureOnly ? 'not run (--fixture-only)' : 'not installed on this Mac'
for (const cli of missing) blocks.push({ cli, block: 'write', verdict: 'skipped', why: skipWhy }, { cli, block: 'mcp', verdict: 'skipped', why: skipWhy })

// ---------- 3. one gmailFrom ----------

const gmailBrain = process.env.DESK_CHECK_GMAIL_BRAIN || (existsSync(AGENCY_BRAIN) ? AGENCY_BRAIN : work)
const gmail = sendersMod.createSenders({ spawn: spawn as unknown as import('../src/main/desk/senders.ts').DeskSpawn, dryRun: true })
let fromLine = 'not run (--fixture-only)'
if (!fixtureOnly) {
  try {
    fromLine = (await gmail.gmailFrom(gmailBrain)) || "Gmail isn't signed in on this Mac."
  } catch (e) {
    fromLine = `gmailFrom threw: ${String((e as Error)?.message || e)}`
  }
}

// ---------- write-up ----------

const artifact = join(work, 'probes.json')
writeFileSync(
  artifact,
  JSON.stringify(
    blocks.map((b) => ({
      ...b,
      blocked: b.blocked && { ...b.blocked, stdout: b.blocked.stdout.slice(0, 4000), stderr: b.blocked.stderr.slice(0, 2000) },
      control: b.control && { ...b.control, stdout: b.control.stdout.slice(0, 4000), stderr: b.control.stderr.slice(0, 2000) }
    })),
    null,
    2
  )
)

const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `  ${r.detail}` : ''}`)
for (const line of info) console.log(`INFO ${line}`)
console.log('')
for (const b of blocks) {
  console.log(`PROBE ${b.cli} ${b.block}: ${b.verdict.toUpperCase()} (${b.why})`)
  for (const [role, run] of [['blocked', b.blocked], ['control', b.control]] as const) {
    if (!run) continue
    console.log(`  ${role}: exit ${run.code}${run.killed ? ' killed' : ''} in ${Math.round(run.ms / 1000)}s, file ${run.wrote ? 'written' : 'absent'}; stdout: ${short(run.stdout) || '(none)'}`)
  }
}
console.log(`GMAIL from (${gmailBrain === AGENCY_BRAIN ? 'the brain path as an argument, not a working folder' : 'a temp folder'}): ${fromLine}`)

const fixtureOk = results.length > 0 && results.every((r) => r.ok)
const probeFail = blocks.some((b) => b.verdict === 'fail')
const tally = (v: Verdict) => blocks.filter((b) => b.verdict === v).length
console.log(
  `\n${fixtureOk && !probeFail ? 'CHECK_DESK_PASS' : 'CHECK_DESK_FAIL'} fixture ${results.filter((r) => r.ok).length}/${results.length}; probes pass ${tally('pass')}, not proven ${tally('not proven')}, skipped ${tally('skipped')}, fail ${tally('fail')}\nprobe log: ${artifact}`
)
rmSync(join(work, 'userData'), { recursive: true, force: true })
process.exit(fixtureOk && !probeFail ? 0 : 1)
