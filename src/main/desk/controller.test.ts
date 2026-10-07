import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ME, SLOW_TURN_MS, isoWeek } from '../../shared/desk.ts'
import type { DeskCli, DeskFailure, DeskMessage } from '../../shared/desk.ts'
import type { BrowseStepResult } from '../../shared/desk.ts'
import { jobIsOpen } from './bus.ts'
import type { JobView } from './bus.ts'
import { createDeskController } from './controller.ts'
import type { DeskController, DeskSenders } from './controller.ts'
import { archiveFile, memoryFile, weekFile } from './paths.ts'
import { PAGE_SENTENCE } from './runner.ts'
import type { DeskPair, RunResult } from './runner.ts'
import { seedDesk } from './seed.ts'
import type { EmailTile, TextLookup } from './senders.ts'

type Step = {
  text?: string
  fail?: DeskFailure
  detail?: string
  used?: DeskPair
  cli?: DeskCli
  hang?: boolean
}

const NOW = new Date(2026, 9, 7, 12, 0, 0)

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayOffset(n: number): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

function assign(bot: string, task: string, why: string, files: string[]): string {
  return ['```assign', `bot: ${bot}`, `task: ${task}`, `why: ${why}`, 'files:', ...files.map((f) => `- ${f}`), '```'].join('\n')
}

function send(to: string, text: string, files: string[] = []): string {
  const lines = ['```send', `to: ${to}`]
  if (files.length) lines.push('files:', ...files.map((f) => `- ${f}`))
  lines.push('', text, '```')
  return lines.join('\n')
}

function hire(name: string, description: string, cli = 'grok'): string {
  return ['```hire', `name: ${name}`, `cli: ${cli}`, 'model: default', 'effort: low', '', description, '```'].join('\n')
}

function email(o: { reply?: string; to: string; subject: string; body: string }): string {
  return ['```email', `reply: ${o.reply || ''}`, `to: ${o.to}`, 'cc:', `subject: ${o.subject}`, '', o.body, '```'].join('\n')
}

function sms(to: string, body: string, via = 'iMessage'): string {
  return ['```sms', `to: ${to}`, `via: ${via}`, '', body, '```'].join('\n')
}

function hold(need: string, text: string): string {
  return ['```hold', `need: ${need}`, '', text, '```'].join('\n')
}

function browse(line: string): string {
  return ['```browse', line, '```'].join('\n')
}

function remember(line: string): string {
  return ['```remember', `- ${line}`, '```'].join('\n')
}

function page(url: string, text = 'PAGE-BODY', controls = ['Pricing', 'Home']): BrowseStepResult {
  return { ok: true, url, title: 'Example', text, controls }
}

function createRunner() {
  const queues = new Map<string, Step[]>()
  const prompts: { id: string; effort: string; prompt: string }[] = []
  const pending = new Map<string, Array<(r: RunResult) => void>>()
  let live = 0
  let maxLive = 0
  let stopAllCount = 0
  const stopped: string[] = []

  function finish(id: string, cli: DeskCli, model: string, step: Step): RunResult {
    const pair = { cli: step.cli || cli, model }
    if (step.fail) {
      return { status: 'failed', failure: step.fail, ...(step.detail ? { detail: step.detail } : {}), lastTry: pair, tries: [pair] }
    }
    return {
      status: 'ok',
      text: step.text ?? 'Noted.',
      ...(step.used ? { used: step.used } : {}),
      lastTry: pair,
      tries: [pair]
    }
  }

  return {
    prompts,
    pending,
    stopped,
    stopAllCount: () => stopAllCount,
    maxLive: () => maxLive,
    queue(id: string, ...steps: Array<Step | Step[]>) {
      const flat: Step[] = []
      for (const step of steps) {
        if (Array.isArray(step)) flat.push(...step)
        else flat.push(step)
      }
      queues.set(id, [...(queues.get(id) || []), ...flat])
    },
    release(id: string, step: Step, cli: DeskCli = 'grok') {
      const list = pending.get(id) || []
      const resolve = list.shift()
      pending.set(id, list)
      assert.ok(resolve, `${id} was not waiting`)
      resolve(finish(id, cli, 'default', step))
    },
    run(opts: { bot: { id: string; cli: DeskCli; model: string; effort: string }; prompt: string }): Promise<RunResult> {
      const bot = opts.bot
      prompts.push({ id: bot.id, effort: bot.effort, prompt: opts.prompt })
      live++
      maxLive = Math.max(maxLive, live)
      const queued = queues.get(bot.id) || []
      const step = queued.shift() || { text: 'Noted.' }
      if (step.hang) {
        return new Promise((resolve) => {
          const list = pending.get(bot.id) || []
          list.push((r) => {
            live--
            resolve(r)
          })
          pending.set(bot.id, list)
        })
      }
      live--
      return Promise.resolve(finish(bot.id, bot.cli, bot.model, step))
    },
    stop(id: string) {
      stopped.push(id)
      const list = pending.get(id) || []
      pending.set(id, [])
      for (const resolve of list) {
        resolve({ status: 'stopped', lastTry: { cli: 'grok', model: 'default' }, tries: [] })
      }
      return list.length > 0
    },
    stopAll() {
      stopAllCount++
      const ids = [...pending.keys()]
      for (const id of ids) this.stop(id)
      return ids
    },
    keepWaiting() {
      return false
    }
  }
}

function createBrowser() {
  let window = false
  let holder: string | null = null
  const waiters: { id: string; go: (cancelled: boolean) => void }[] = []
  const opens: string[] = []
  const got: string[] = []
  const steps: { id: string; action: string; detail?: string; url?: string }[] = []
  const clicks: { name: string; url: string }[] = []
  let focuses = 0
  const stepResults: BrowseStepResult[] = []
  const clickResults: BrowseStepResult[] = []

  function hand(cancelledFor?: string) {
    holder = null
    const next = waiters.shift()
    if (!next) return
    if (cancelledFor && next.id === cancelledFor) {
      next.go(true)
      return
    }
    holder = next.id
    next.go(false)
  }

  return {
    opens,
    got,
    steps,
    clicks,
    focuses: () => focuses,
    holder: () => holder,
    windowOpen: () => window,
    setWindow(v: boolean) {
      window = v
    },
    pushStep(...rs: BrowseStepResult[]) {
      stepResults.push(...rs)
    },
    pushClick(...rs: BrowseStepResult[]) {
      clickResults.push(...rs)
    },
    async open(id: string) {
      opens.push(id)
      if (holder && holder !== id) {
        const cancelled = await new Promise<boolean>((go) => waiters.push({ id, go }))
        if (cancelled || holder !== id) return
      } else if (!holder) holder = id
      got.push(id)
      window = true
    },
    cancel(id: string) {
      const i = waiters.findIndex((w) => w.id === id)
      if (i >= 0) {
        waiters.splice(i, 1)[0].go(true)
        return
      }
      if (holder === id) hand()
    },
    release(id: string) {
      if (holder === id) hand()
      else {
        const i = waiters.findIndex((w) => w.id === id)
        if (i >= 0) waiters.splice(i, 1)[0].go(true)
      }
    },
    focus() {
      focuses++
    },
    async clickApproved(name: string, url: string): Promise<BrowseStepResult> {
      clicks.push({ name, url })
      window = true
      return clickResults.shift() || page(url, 'AFTER-CLICK', ['Pricing', 'Home'])
    },
    async runStep(id: string, step: { action: string; detail?: string; url?: string }): Promise<BrowseStepResult> {
      steps.push({ id, action: step.action, detail: step.detail, url: step.url })
      const queued = stepResults.shift()
      if (queued) return queued
      const url = step.url || 'https://example.com/landed'
      const text = step.action === 'click' ? 'PRICE-PAGE' : 'PAGE-BODY'
      return page(url, text)
    }
  }
}

type Browser = ReturnType<typeof createBrowser>
type Runner = ReturnType<typeof createRunner>

function createSenderBox() {
  const emails: EmailTile[] = []
  const texts: { guid: string; body: string }[] = []
  const checks: string[] = []
  const box = {
    emails,
    texts,
    checks,
    from: 'joe@plyntr.com' as string | null,
    checkResult: 'ok' as 'ok' | 'missing' | 'no-token',
    lookup: { sendable: true, guid: 'guid-brent', label: 'Brent · home' } as TextLookup,
    emailResult: { ok: true, note: 'sent' } as { ok: boolean; dryRun?: boolean; killed?: boolean; sendable?: boolean; note?: string; error?: string },
    textResult: { ok: true } as { ok: boolean; sendable?: boolean; note?: string; error?: string },
    whatsapp: 0
  }
  const senders: DeskSenders = {
    gmailFrom: async () => box.from,
    check: async (_brain, id) => {
      checks.push(id)
      return box.checkResult
    },
    sendEmail: async (_brain, tile) => {
      emails.push(tile)
      return box.emailResult
    },
    lookupText: async () => box.lookup,
    sendText: async (_brain, guid, body) => {
      texts.push({ guid, body })
      return box.textResult
    },
    sendWhatsApp: () => {
      box.whatsapp++
      return { ok: false, sendable: false }
    }
  }
  return { box, senders }
}

const DETECT_GROK = () => ({ grok: true, claude: false, gpt: false, cursor: false })

function writeMemory(brain: string, id: string, name: string, standing: string[], weeks: { date: string; lines: string[] }[]) {
  const lines = [`# ${name}`, '', '## Standing', ...standing.map((l) => `- ${l}`), '', '## This week']
  for (const w of weeks) lines.push(`### ${w.date}`, ...w.lines.map((l) => `- ${l}`))
  lines.push('')
  writeFileSync(memoryFile(brain, id), lines.join('\n'))
}

async function until(check: () => boolean, label = 'condition never became true'): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(check(), label)
}

function boot(opts: { detect?: () => Record<DeskCli, boolean>; tokenReady?: () => boolean; isOpen?: typeof jobIsOpen } = {}) {
  const brain = mkdtempSync(join(tmpdir(), 'desk-ctl-'))
  const detect = opts.detect || DETECT_GROK
  seedDesk({ brain, role: 'owner', detect })
  const runner = createRunner()
  const browser = createBrowser()
  const { box, senders } = createSenderBox()
  const desk = createDeskController({
    brain,
    role: 'owner',
    runner,
    browser,
    senders,
    detect,
    now: () => NOW,
    tokenReady: opts.tokenReady || (() => true),
    ...(opts.isOpen ? { isOpen: opts.isOpen } : {})
  })
  return { brain, runner, browser, box, desk, cleanup: () => rmSync(brain, { recursive: true, force: true }) }
}

function mail(desk: DeskController): DeskMessage[] {
  return desk.store.readMail()
}

function ofKind(desk: DeskController, kind: string): DeskMessage[] {
  return mail(desk).filter((m) => m.kind === kind)
}

function stateOf(desk: DeskController, id: string) {
  const s = desk.states().find((x) => x.id === id)
  assert.ok(s, id)
  return s
}

test('a scripted assign reaches Researcher, Writer, and Checker, then a late send wakes nobody', async () => {
  const { brain, runner, desk, cleanup } = boot()
  try {
    mkdirSync(join(brain, 'clients/summit'), { recursive: true })
    writeFileSync(join(brain, 'clients/summit/notes.md'), 'SUMMIT-NOTE-EXCERPT\n')
    for (let n = 2; n <= 9; n++) writeFileSync(join(brain, 'clients/summit', `extra-${n}.md`), `EXCERPT-${n}\n`)
    const nine = Array.from({ length: 9 }, (_, i) => `clients/summit/${i === 0 ? 'notes.md' : `extra-${i + 1}.md`}`)
    runner.queue('conductor', [{ text: `On it.\n\n${assign('Researcher', 'Find the newest note.', 'Joe asked.', ['clients/summit/notes.md', 'clients/summit/missing.md'])}` }])
    runner.queue('researcher', [{ text: send('Writer', 'Notes are in the file.', nine) }])
    runner.queue('writer', [{ hang: true }])
    runner.queue('checker', [{ text: 'Ready for Joe.' }])
    const first = desk.say('Find the newest note.')
    await until(() => runner.prompts.some((p) => p.id === 'writer'), 'writer never started')
    const writerPrompt = runner.prompts.filter((p) => p.id === 'writer').at(-1)?.prompt || ''
    assert.ok(writerPrompt.includes('SUMMIT-NOTE-EXCERPT'))
    assert.ok(!writerPrompt.includes('EXCERPT-9'))
    const researcher = stateOf(desk, 'researcher')
    assert.equal(researcher.state, 'waiting-bot')
    if (researcher.state === 'waiting-bot') assert.equal(researcher.on, 'writer')
    const weather = desk.say('What is the weather?')
    await until(() => runner.prompts.filter((p) => p.id === 'conductor').length >= 2, 'conductor did not take the second sentence')
    const second = runner.prompts.filter((p) => p.id === 'conductor').at(-1)?.prompt || ''
    assert.ok(second.includes('What is the weather?'))
    assert.ok(!runner.prompts.filter((p) => p.id === 'writer').some((p) => p.prompt.includes('What is the weather?')))
    const writerCount = runner.prompts.filter((p) => p.id === 'writer').length
    runner.release('writer', { text: send('Checker', 'Three bullets.') })
    await first
    await weather
    assert.equal(runner.prompts.filter((p) => p.id === 'writer').length, writerCount)
    const texts = mail(desk)
    const pack = texts.find((m) => m.kind === 'pack')
    assert.ok(pack?.pack)
    assert.equal(pack.pack.files.length, 1)
    assert.deepEqual(pack.pack.dropped, ['clients/summit/missing.md'])
    assert.equal(texts.filter((m) => m.kind === 'send').length, 2)
    assert.equal(texts.filter((m) => m.kind === 'report').length, 1)
    assert.equal(texts.find((m) => m.from === 'conductor' && m.kind === 'reply')?.text.includes('On it.'), true)
    for (const m of texts.filter((x) => x.kind === 'task' || x.kind === 'pack' || x.kind === 'send' || x.kind === 'report')) {
      assert.ok(!m.text.includes('```'), m.kind)
    }
    assert.equal(stateOf(desk, 'researcher').state, 'idle')
    assert.equal(stateOf(desk, 'writer').state, 'idle')
    assert.deepEqual(desk.bus.queued('researcher'), [])
    assert.deepEqual(desk.bus.queued('writer'), [])
    const job = texts.find((m) => m.kind === 'report')?.job
    assert.ok(job)
    assert.equal(desk.bus.isClosed(job), true)
    const late = desk.bus.post({ from: 'researcher', to: 'writer', kind: 'send', text: 'after close', job })
    assert.equal(late.status, 'late')
    assert.equal(runner.prompts.filter((p) => p.id === 'writer').length, writerCount)
  } finally {
    cleanup()
  }
})

test('two sentences sent while the conductor is busy arrive together, with only the oldest worker send', async () => {
  const { runner, desk, cleanup } = boot()
  try {
    runner.queue('conductor', [{ hang: true }, { text: 'Noted second.' }])
    const first = desk.say('Start.')
    await until(() => (runner.pending.get('conductor') || []).length === 1)
    const a = desk.say('SENTENCE-A')
    const b = desk.say('SENTENCE-B')
    desk.bus.post({ from: 'researcher', to: 'conductor', kind: 'send', text: 'OLD-SEND' })
    desk.bus.post({ from: 'writer', to: 'conductor', kind: 'send', text: 'NEW-SEND' })
    runner.release('conductor', { text: `${hire('Designer', 'Writes headlines.')}\n\nOn it.` })
    await until(() => runner.prompts.filter((p) => p.id === 'conductor').length >= 2)
    const prompt = runner.prompts.filter((p) => p.id === 'conductor')[1].prompt
    assert.ok(prompt.includes('SENTENCE-A'))
    assert.ok(prompt.includes('SENTENCE-B'))
    assert.ok(prompt.includes('OLD-SEND'))
    assert.ok(!prompt.includes('NEW-SEND'))
    assert.ok(prompt.includes('Designer'))
    assert.equal(desk.resolveBot('Designer')?.id, 'designer')
    await first
    await a
    await b
  } finally {
    cleanup()
  }
})

test('hire, a second hire, a removed name, and a rename follow the id rules', async () => {
  const { brain, runner, desk, cleanup } = boot()
  try {
    runner.queue('conductor', [
      { text: hire('Designer', 'Writes headlines.') },
      { text: hire('Designer', 'Also headlines.') },
      { text: hire('Designer', 'After removal.') },
      { text: hire('Scribe', 'A second scribe.') }
    ])
    await desk.say('Add Designer.')
    assert.equal(existsSync(join(brain, 'desk/bots/designer.md')), true)
    assert.equal(readFileSync(memoryFile(brain, 'designer'), 'utf8'), '')
    const hired = ofKind(desk, 'hire')[0]
    assert.equal(hired.hire?.id, 'designer')
    assert.equal(hired.hire?.name, 'Designer')
    assert.ok(runner.prompts.filter((p) => p.id === 'conductor').at(-1)?.prompt.includes('Designer'))
    await desk.say('Add Designer again.')
    assert.equal(desk.resolveBot('Designer')?.id, 'designer')
    assert.equal(desk.resolveBot('Designer 2')?.id, 'designer-2')
    assert.equal(existsSync(join(brain, 'desk/bots/designer-2.md')), true)
    assert.equal(desk.removeBot('designer'), null)
    assert.equal(desk.list().removedNames.designer, 'Designer')
    await desk.say('Add Designer once more.')
    assert.equal(desk.resolveBot('Designer 2')?.id, 'designer-2')
    const writer = desk.store.readBot('writer')
    assert.ok(writer)
    assert.equal(desk.saveBot({ ...writer, name: 'Scribe' }), null)
    assert.equal(desk.store.readBot('writer')?.name, 'Scribe')
    await desk.say('Add Scribe.')
    assert.equal(desk.resolveBot('Scribe 2')?.id, 'scribe-2')
    const checker = desk.store.readBot('checker')
    assert.ok(checker)
    assert.equal(desk.saveBot({ ...checker, id: 'ad-checker', name: 'Ad Checker' }), null)
    assert.equal(desk.saveBot({ id: 'other', name: 'Ad-Checker', cli: 'grok', model: 'default', effort: 'low', description: 'No.' }), 'That name is taken.')
    assert.equal(existsSync(join(brain, 'desk/bots/other.md')), false)
    assert.equal(desk.saveBot({ id: 'designer', name: 'Designer', cli: 'grok', model: 'default', effort: 'low', description: 'Back.' }), 'That name is taken.')
  } finally {
    cleanup()
  }
})

test('a worker cannot hire or assign, a bad fence sends nothing, and a click with no page does not run', async () => {
  const { brain, runner, browser, desk, cleanup } = boot()
  try {
    runner.queue('writer', [
      { text: hire('Designer', 'Nope.') },
      { text: assign('Checker', 'Look.', 'Because.', []) },
      { text: '```email\nto: Brent <brent@example.com>\nsubject: Hi\nNo blank line, so this does not parse.\n```' },
      { text: browse('click: Pricing') }
    ])
    await desk.say('Hire someone.', 'writer')
    assert.equal(existsSync(join(brain, 'desk/bots/designer.md')), false)
    assert.equal(mail(desk).some((m) => m.system === 'worker-hire' && m.text === 'Only the conductor can add a teammate.'), true)
    await desk.say('Hand it on.', 'writer')
    assert.equal(ofKind(desk, 'send').length, 0)
    assert.equal(ofKind(desk, 'pack').length, 0)
    assert.equal(mail(desk).some((m) => m.system === 'worker-assign' && m.text === 'Only the conductor can hand work to someone else.'), true)
    await desk.say('Bad fence.', 'writer')
    const failed = mail(desk).filter((m) => m.system === 'parse-failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].text, "Writer's note didn't come through, so nothing was sent.")
    await desk.say('Click.', 'writer')
    assert.equal(browser.steps.length, 0)
    assert.equal(mail(desk).some((m) => m.system === 'no-page' && m.text === 'Open a page first.'), true)
  } finally {
    cleanup()
  }
})

test('a message to Writer stays out of the conductor prompt, and a remember shows up next time', async () => {
  const { runner, desk, cleanup } = boot()
  try {
    runner.queue('writer', [{ text: `Draft ready.\n\n${remember('Joe wants bullets.')}` }, { text: 'Second draft.' }])
    runner.queue('conductor', [{ text: 'On the team thread.' }])
    await desk.say('Draft three bullets.', 'writer')
    const remembered = readFileSync(memoryFile(desk.store.brain, 'writer'), 'utf8')
    assert.ok(remembered.includes('### 2026-10-07'))
    assert.ok(remembered.includes('Joe wants bullets.'))
    await desk.say('Where are we?')
    const conductor = runner.prompts.filter((p) => p.id === 'conductor').at(-1)?.prompt || ''
    assert.ok(!conductor.includes('Draft three bullets.'))
    const task = mail(desk).find((m) => m.text === 'Draft three bullets.')
    assert.ok(task?.job)
    await desk.say('Tighten it.', 'writer')
    const next = runner.prompts.filter((p) => p.id === 'writer').at(-1)?.prompt || ''
    assert.ok(next.includes('Joe wants bullets.'))
    assert.ok(next.includes('Tighten it.'))
  } finally {
    cleanup()
  }
})

test('weekly tidy is sequential, a failed compact still archives, and overflow is a later low-effort pass', async (t) => {
  const { brain, runner, desk, cleanup } = boot()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    writeMemory(brain, 'writer', 'Writer', ['Keep the voice plain.'], [{ date: dayOffset(-8), lines: ['writer old line'] }])
    writeMemory(brain, 'designer', 'Designer', ['Headlines only.'], [{ date: dayOffset(-8), lines: ['designer old line'] }])
    desk.saveBot({ id: 'designer', name: 'Designer', cli: 'grok', model: 'default', effort: 'low', description: 'Headlines.' })
    runner.queue('writer', [{ hang: true }])
    runner.queue('designer', [{ text: '- Headlines only.' }])
    const opening = desk.open()
    await until(() => (runner.pending.get('writer') || []).length === 1, 'writer tidy did not start')
    assert.equal(runner.prompts.some((p) => p.id === 'designer'), false)
    assert.ok(desk.anyBusy().includes('Writer'))
    assert.equal(runner.maxLive(), 1)
    t.mock.timers.tick(SLOW_TURN_MS)
    assert.equal(mail(desk).some((m) => m.system === 'slow' && m.text === 'Writer is still working.'), true)
    const stopping = desk.stop('writer')
    await opening
    await stopping
    assert.equal(runner.maxLive(), 1)
    assert.ok(runner.prompts.some((p) => p.id === 'designer'))
    const writerMem = readFileSync(memoryFile(brain, 'writer'), 'utf8')
    assert.ok(writerMem.includes('Keep the voice plain.'))
    assert.ok(!writerMem.includes('writer old line'))
    assert.ok(readFileSync(archiveFile(brain, 'writer'), 'utf8').includes('writer old line'))
    assert.equal(readFileSync(weekFile(brain, 'writer'), 'utf8').trim(), isoWeek(NOW))
    assert.equal(readFileSync(weekFile(brain, 'designer'), 'utf8').trim(), isoWeek(NOW))
    assert.equal(mail(desk).some((m) => m.system === 'fallback'), false)
    const compact = runner.prompts.find((p) => p.id === 'writer')
    assert.ok(compact?.prompt.includes('Keep the voice plain.'))
    assert.ok(compact?.prompt.includes('writer old line'))
    assert.equal(compact?.effort, 'low')
  } finally {
    cleanup()
  }
})

test('overflow folds today only after the turn, keeps Standing, and does not write the week marker', async () => {
  const { brain, runner, desk, cleanup } = boot()
  try {
    const fat = Array.from({ length: 12 }, (_, i) => `today line ${i} ${'x'.repeat(70)}`)
    writeMemory(brain, 'conductor', 'Conductor', ['Keep the voice plain.'], [{ date: dayOffset(0), lines: fat }])
    await desk.open()
    assert.equal(runner.prompts.length, 0)
    runner.queue('conductor', [{ text: 'All set.' }, { text: '- Keep the voice plain.' }])
    await desk.say('Status?')
    const calls = runner.prompts.filter((p) => p.id === 'conductor')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].effort, 'high')
    assert.equal(calls[1].effort, 'low')
    assert.ok(calls[1].prompt.includes('Keep the voice plain.'))
    assert.ok(calls[1].prompt.includes('today line 0'))
    const mem = readFileSync(memoryFile(brain, 'conductor'), 'utf8')
    assert.ok(mem.includes('Keep the voice plain.'))
    assert.ok(readFileSync(archiveFile(brain, 'conductor'), 'utf8').includes('today line 0'))
    assert.equal(existsSync(weekFile(brain, 'conductor')), false)
    assert.equal(stateOf(desk, 'conductor').state, 'idle')
  } finally {
    cleanup()
  }
})

test('a URL and a click share one card, and the next prompt has the page', async () => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    runner.queue('writer', [{ text: browse('url: https://example.com') }, { text: browse('click: Pricing') }, { text: 'Done looking.' }])
    await desk.say('Open pricing.', 'writer')
    assert.equal(browser.steps.length, 2)
    assert.equal(browser.steps[0].action, 'url')
    assert.equal(browser.steps[1].action, 'click')
    assert.equal(browser.steps[0].id, browser.steps[1].id)
    const card = desk.view('writer').find((m) => m.kind === 'browse')
    assert.equal(card?.browse?.steps.length, 2)
    const texts = mail(desk).filter((m) => m.kind === 'browse').map((m) => m.text)
    assert.ok(texts.some((t) => t.startsWith('Opened https://example.com')))
    assert.ok(texts.includes('Clicked Pricing'))
    const after = runner.prompts.filter((p) => p.id === 'writer')[2].prompt
    assert.ok(after.includes(PAGE_SENTENCE))
    assert.ok(after.includes('PRICE-PAGE'))
    assert.ok(after.includes('Pricing'))
  } finally {
    cleanup()
  }
})

test('eight browser steps stop the ninth, release the lock, and do not wake Writer again', async () => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    browser.pushStep(page('https://example.com', 'PAGE-BODY', ['Pricing', 'Home']))
    for (let i = 0; i < 7; i++) browser.pushStep({ refused: 'missing', name: 'Pricing', url: 'https://example.com' })
    const click = browse('click: Pricing')
    runner.queue('writer', [
      { text: browse('url: https://example.com') },
      ...Array.from({ length: 7 }, () => ({ text: click })),
      { text: `${click}\n\nThat is the page.` }
    ])
    await desk.say('Look around.', 'writer')
    assert.equal(browser.steps.length, 8)
    const refusals = mail(desk).filter((m) => m.kind === 'browse' && m.text === "Couldn't find Pricing.")
    assert.equal(refusals.length, 7)
    const follow = runner.prompts.filter((p) => p.id === 'writer')
    assert.equal(follow.length, 9)
    for (let i = 2; i <= 8; i++) {
      assert.ok(follow[i].prompt.includes(PAGE_SENTENCE))
      assert.ok(follow[i].prompt.includes('PAGE-BODY'))
      assert.ok(follow[i].prompt.includes("Couldn't find Pricing."))
    }
    assert.equal(mail(desk).some((m) => m.system === 'browse-limit' && m.text === 'Writer stopped after 8 browser steps.'), true)
    const reply = mail(desk).find((m) => m.text === 'That is the page.')
    assert.equal(reply?.kind, 'reply')
    assert.equal(browser.holder(), null)
    assert.equal(stateOf(desk, 'writer').state, 'idle')
    const job = mail(desk).find((m) => m.kind === 'browse')?.job
    assert.ok(job)
    assert.equal(desk.bus.isClosed(job), true)
  } finally {
    cleanup()
  }
})

test('a pay click holds, a later browse is dropped, and Approve clicks that same page', async () => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    browser.pushStep(page('https://example.com'))
    browser.pushStep({ hold: 'spend', name: 'Pay', url: 'https://example.com' })
    runner.queue('writer', [{ text: browse('url: https://example.com') }, { text: browse('click: Pay') }])
    await desk.say('Buy it.', 'writer')
    const tile = mail(desk).find((m) => m.kind === 'hold')
    assert.ok(tile)
    assert.equal(tile.text, 'Approving clicks Pay in the desk browser. Other browsing waits until you answer.')
    assert.equal(tile.hold?.browseClick, 'Pay')
    assert.equal(tile.hold?.pageUrl, 'https://example.com')
    assert.equal(browser.clicks.length, 0)
    runner.queue('writer', [{ text: `${browse('click: Pricing')}\n\nStill going.` }])
    await desk.say('keep going', 'writer')
    assert.equal(browser.steps.length, 2)
    assert.equal(browser.holder(), browser.steps[0].id)
    assert.equal(mail(desk).some((m) => m.system === 'extra-tile'), true)
    runner.queue('writer', [{ text: 'Moved on.' }])
    await desk.answerHold(tile.id, 'yes')
    assert.deepEqual(browser.clicks, [{ name: 'Pay', url: 'https://example.com' }])
    await desk.answerHold(tile.id, 'yes')
    assert.equal(browser.clicks.length, 1)
  } finally {
    cleanup()
  }
})

test('Not now on a browser hold releases the lock and wakes Writer with Joe said no', async () => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    browser.pushStep(page('https://example.com'))
    browser.pushStep({ hold: 'spend', name: 'Pay', url: 'https://example.com' })
    runner.queue('writer', [{ text: browse('url: https://example.com') }, { text: browse('click: Pay') }, { text: 'Standing by.' }])
    await desk.say('Buy it.', 'writer')
    const tile = mail(desk).find((m) => m.kind === 'hold')
    assert.ok(tile)
    await desk.answerHold(tile.id, 'no')
    assert.equal(browser.clicks.length, 0)
    assert.equal(browser.holder(), null)
    const prompt = runner.prompts.filter((p) => p.id === 'writer').at(-1)?.prompt || ''
    assert.ok(prompt.includes('Joe said no.'))
    assert.ok(!prompt.includes(PAGE_SENTENCE))
    assert.equal(mail(desk).find((m) => m.replaces === tile.id)?.actedAt, undefined)
  } finally {
    cleanup()
  }
})

test('Submit is refused, a second bot waits, and Stop does not take the browser', async (t) => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    browser.pushStep(page('https://example.com'))
    browser.pushStep({ refused: 'pay', name: 'Submit', url: 'https://example.com' })
    runner.queue('writer', [{ text: browse('url: https://example.com') }, { text: browse('click: Submit') }, { hang: true }])
    const looking = desk.say('Open it.', 'writer')
    await until(() => (runner.pending.get('writer') || []).length === 1)
    assert.equal(mail(desk).some((m) => m.text === 'That button stays unclicked. Send it from a tile instead.'), true)
    runner.queue('checker', [{ text: browse('url: https://example.com/other') }, { text: 'Saw it.' }])
    const other = desk.say('You look.', 'checker')
    await until(() => {
      const st = stateOf(desk, 'checker')
      return st.state === 'working' && st.task === 'Waiting for the desk browser'
    })
    assert.equal(browser.got.includes(browser.opens.at(-1) || ''), false)
    t.mock.timers.tick(SLOW_TURN_MS)
    assert.equal(mail(desk).some((m) => m.system === 'slow'), true)
    await desk.stop('checker')
    assert.equal(browser.holder(), browser.steps[0].id)
    runner.release('writer', { text: 'Done looking.' })
    await looking
    await other
    assert.equal(browser.holder(), null)
  } finally {
    cleanup()
  }
})

test('a spend hold pauses for Approve and does not call a sender', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    runner.queue('writer', [
      { text: hold('spend', 'May I buy the domain?') },
      { text: 'Thanks.' },
      { text: hold('spend', 'May I buy a second?') },
      { text: 'All right.' },
      { text: hold('send', 'Just send it.') }
    ])
    await desk.say('Ask.', 'writer')
    const tile = mail(desk).find((m) => m.kind === 'hold')
    assert.ok(tile)
    assert.ok(tile.text.includes('May I buy the domain?'))
    assert.ok(tile.text.includes('It does not spend money or change the ads account.'))
    assert.equal(stateOf(desk, 'writer').state, 'waiting-you')
    await desk.answerHold(tile.id, 'yes')
    assert.equal(box.emails.length, 0)
    assert.equal(box.texts.length, 0)
    assert.ok(mail(desk).some((m) => m.replaces === tile.id && m.actedAt))
    await desk.answerHold(tile.id, 'no')
    assert.equal(mail(desk).filter((m) => m.replaces === tile.id).length, 1)
    await desk.say('Ask again.', 'writer')
    const second = mail(desk).filter((m) => m.kind === 'hold' && !m.replaces).at(-1)
    assert.ok(second)
    await desk.answerHold(second.id, 'no')
    assert.equal(mail(desk).find((m) => m.replaces === second.id)?.hold?.answer, 'no')
    assert.equal(mail(desk).find((m) => m.replaces === second.id)?.actedAt, undefined)
    await desk.answerHold(second.id, 'yes')
    assert.equal(mail(desk).filter((m) => m.replaces === second.id && m.actedAt).length, 0)
    runner.queue('writer', [{ text: hold('send', 'Just send it.') }])
    await desk.say('Bad hold.', 'writer')
    assert.equal(mail(desk).some((m) => m.system === 'bad-hold'), true)
    assert.equal(desk.view('writer').some((m) => m.kind === 'hold' && !m.hold?.answer), false)
  } finally {
    cleanup()
  }
})

test('email send, not now, revision, and a dry run stay on the same job', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    const first = email({ reply: 'msg-1', to: 'Brent <brent@example.com>', subject: 'September numbers', body: 'September numbers are in the note.' })
    runner.queue('drafts', [{ text: first }, { text: 'Understood.' }, { text: email({ reply: 'msg-1', to: 'Brent <brent@example.com>', subject: 'Shorter', body: 'Short version.' }) }])
    await desk.say('Draft the note.', 'drafts')
    const tile = mail(desk).find((m) => m.kind === 'email')
    assert.ok(tile?.email)
    assert.equal(stateOf(desk, 'drafts').state, 'waiting-you')
    box.emailResult = { ok: true, dryRun: true, note: 'Dry run. Nothing left this Mac.' }
    await desk.answerEmail(tile.id, 'yes')
    assert.equal(box.emails.length, 1)
    assert.equal(box.emails[0].to, 'Brent <brent@example.com>')
    assert.equal(box.emails[0].subject, 'September numbers')
    assert.equal(box.emails[0].body, 'September numbers are in the note.')
    assert.equal(box.emails[0].replyTo, 'msg-1')
    const sent = mail(desk).find((m) => m.replaces === tile.id)
    assert.equal(sent?.email?.sent, 'yes')
    assert.ok(sent?.actedAt)
    assert.equal(sent?.email?.note, 'Dry run. Nothing left this Mac.')
    assert.equal(sent?.from, tile.from)
    assert.equal(sent?.job, tile.job)
    await desk.answerEmail(tile.id, 'yes')
    assert.equal(box.emails.length, 1)
  } finally {
    cleanup()
  }
})

test('Not now keeps the job open and a shorter draft replaces the unsent tile', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    runner.queue('drafts', [
      { text: email({ reply: 'msg-1', to: 'Brent <brent@example.com>', subject: 'September numbers', body: 'Long note.' }) },
      { text: 'Understood.' },
      { text: email({ reply: 'msg-1', to: 'Brent <brent@example.com>', subject: 'Shorter', body: 'Short version.' }) }
    ])
    runner.queue('conductor', [{ text: 'On the team thread.' }])
    await desk.say('Draft it.', 'drafts')
    const tile = mail(desk).find((m) => m.kind === 'email')
    assert.ok(tile)
    await desk.answerEmail(tile.id, 'no')
    assert.equal(box.emails.length, 0)
    const declined = mail(desk).find((m) => m.replaces === tile.id)
    assert.equal(declined?.email?.sent, 'no')
    assert.equal(declined?.actedAt, undefined)
    const prompt = runner.prompts.filter((p) => p.id === 'drafts').at(-1)?.prompt || ''
    assert.ok(prompt.includes('Joe said no.'))
    const reply = mail(desk).find((m) => m.text === 'Understood.')
    assert.equal(reply?.kind, 'reply')
    assert.equal(stateOf(desk, 'drafts').state, 'waiting-you')
    assert.equal(desk.bus.isClosed(tile.job || ''), false)
    await desk.say('hello team')
    await desk.say('shorter', 'drafts')
    const revision = runner.prompts.filter((p) => p.id === 'drafts').at(-1)?.prompt || ''
    assert.ok(revision.includes('shorter'))
    assert.ok(revision.includes('September numbers'))
    assert.ok(revision.includes('Long note.'))
    assert.ok(!revision.includes('hello team'))
    const visible = desk.view('drafts').filter((m) => m.kind === 'email')
    assert.equal(visible.length, 1)
    assert.equal(visible[0].email?.subject, 'Shorter')
    assert.equal(visible[0].email?.body, 'Short version.')
    assert.ok(mail(desk).some((m) => m.replaces === declined?.id))
    box.emailResult = { ok: true, note: 'sent' }
    await desk.answerEmail(visible[0].id, 'yes')
    assert.equal(box.emails.length, 1)
    assert.equal(box.emails[0].subject, 'Shorter')
    await desk.answerEmail(visible[0].id, 'yes')
    assert.equal(box.emails.length, 1)
  } finally {
    cleanup()
  }
})

test('a revision that finishes after Send posts that the message already went', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    runner.queue('drafts', [
      { text: email({ to: 'Brent <brent@example.com>', subject: 'September numbers', body: 'Long note.' }) },
      { text: 'Noted.' }
    ])
    await desk.say('Draft it.', 'drafts')
    const tile = mail(desk).find((m) => m.kind === 'email')
    assert.ok(tile)
    await desk.answerEmail(tile.id, 'no')
    runner.queue('drafts', [{ hang: true }])
    const shorter = desk.say('shorter', 'drafts')
    await until(() => (runner.pending.get('drafts') || []).length === 1)
    const visible = desk.view('drafts').find((m) => m.kind === 'email')
    assert.ok(visible)
    box.emailResult = { ok: true, note: 'sent' }
    const sending = desk.answerEmail(visible.id, 'yes')
    await until(() => box.emails.length === 1)
    const before = box.emails.length
    runner.release('drafts', { text: email({ to: 'Brent <brent@example.com>', subject: 'Too late', body: 'No.' }) })
    await shorter
    await sending
    assert.equal(box.emails.length, before)
    assert.equal(mail(desk).some((m) => m.system === 'already-sent' && m.text === 'That message already went.'), true)
  } finally {
    cleanup()
  }
})

test('Stop and a failed revision leave the unsent tile sendable', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    runner.queue('drafts', [
      { text: email({ to: 'Brent <brent@example.com>', subject: 'September numbers', body: 'Long note.' }) },
      { text: 'Noted.' }
    ])
    runner.queue('writer', [{ hang: true }])
    await desk.say('Draft it.', 'drafts')
    const tile = mail(desk).find((m) => m.kind === 'email')
    assert.ok(tile)
    await desk.answerEmail(tile.id, 'no')
    const writer = desk.say('Wait here.', 'writer')
    await until(() => (runner.pending.get('writer') || []).length === 1)
    runner.queue('drafts', [{ hang: true }])
    const shorter = desk.say('shorter', 'drafts')
    await until(() => (runner.pending.get('drafts') || []).length === 1)
    await desk.stop('drafts')
    assert.equal(desk.bus.isClosed(tile.job || ''), false)
    assert.equal(stateOf(desk, 'drafts').state, 'waiting-you')
    const stopped = mail(desk).find((m) => m.kind === 'stopped' && m.from === 'drafts')
    assert.deepEqual(stopped?.inputs, [])
    assert.equal(runner.stopped.includes('writer'), false)
    const visible = desk.view('drafts').find((m) => m.kind === 'email')
    assert.ok(visible?.email?.sendable)
    const handoff = desk.bus.post({ from: 'researcher', to: 'writer', kind: 'send', text: 'still open', job: tile.job })
    assert.notEqual(handoff.status, 'late')
    box.emailResult = { ok: true, note: 'sent' }
    runner.release('writer', { text: 'Done.' })
    await shorter
    await writer
    runner.queue('drafts', [{ fail: 'empty' }])
    await desk.say('Change it.', 'drafts')
    const err = mail(desk).filter((m) => m.kind === 'error' && m.from === 'drafts').at(-1)
    assert.deepEqual(err?.inputs, [])
    assert.equal(desk.bus.isClosed(tile.job || ''), false)
    assert.equal(stateOf(desk, 'drafts').state, 'waiting-you')
    const still = desk.view('drafts').find((m) => m.kind === 'email')
    assert.ok(still?.email?.sendable)
    assert.equal(still?.actedAt, undefined)
    await desk.answerEmail(still?.id || '', 'yes')
    assert.equal(box.emails.length, 1)
  } finally {
    cleanup()
  }
})

test('a failed sender copies the note and does not stamp sent', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    runner.queue('drafts', [
      { text: email({ reply: 'missing-id', to: 'Brent <brent@example.com>', subject: 'Missing', body: 'Body.' }) },
      { text: email({ to: 'Brent <brent@example.com>', subject: 'Killed', body: 'Body.' }) },
      { text: email({ to: 'Brent <brent@example.com>', subject: 'Retry me', body: 'Body.' }) }
    ])
    box.checkResult = 'missing'
    await desk.say('One.', 'drafts')
    let tile = mail(desk).find((m) => m.kind === 'email' && m.email?.subject === 'Missing')
    assert.equal(tile?.email?.sendable, false)
    assert.equal(tile?.email?.note, "That email isn't in Gmail, so this stays a draft.")
    assert.deepEqual(box.checks, ['missing-id'])
    box.checkResult = 'ok'
    box.emailResult = { ok: false, killed: true, sendable: false, note: 'This may have gone. Check Sent in Gmail before trying again.' }
    await desk.say('Two.', 'drafts')
    tile = mail(desk).find((m) => m.kind === 'email' && m.email?.subject === 'Killed')
    assert.ok(tile)
    const killedId = tile.id
    await desk.answerEmail(killedId, 'yes')
    const killed = mail(desk).find((m) => m.replaces === killedId)
    assert.equal(killed?.email?.sent, undefined)
    assert.equal(killed?.actedAt, undefined)
    assert.equal(killed?.email?.sendable, false)
    assert.equal(killed?.email?.note, 'This may have gone. Check Sent in Gmail before trying again.')
    box.emailResult = { ok: false, sendable: true, note: 'Message was not sent.' }
    await desk.say('Three.', 'drafts')
    tile = mail(desk).find((m) => m.kind === 'email' && m.email?.subject === 'Retry me')
    assert.ok(tile)
    await desk.answerEmail(tile.id, 'yes')
    const retry = mail(desk).find((m) => m.replaces === tile.id)
    assert.equal(retry?.email?.sent, undefined)
    assert.equal(retry?.email?.sendable, true)
    assert.equal(retry?.actedAt, undefined)
  } finally {
    cleanup()
  }
})

test('an sms to Brent follows the chat match, and WhatsApp stays a draft', async () => {
  const { runner, box, desk, cleanup } = boot()
  try {
    box.lookup = { sendable: false, note: 'More than one iMessage chat matches Brent.' }
    runner.queue('drafts', [{ text: sms('Brent', 'Hello Brent.') }])
    await desk.say('Text Brent.', 'drafts')
    let tile = mail(desk).find((m) => m.kind === 'text')
    assert.equal(tile?.textMsg?.sendable, false)
    await desk.answerText(tile?.id || '', 'yes')
    assert.equal(box.texts.length, 0)
    box.lookup = { sendable: true, guid: 'guid-brent', label: 'Brent · home' }
    runner.queue('drafts', [{ text: sms('Brent', 'The September note is ready.') }])
    await desk.say('Text Brent again.', 'drafts')
    tile = mail(desk).filter((m) => m.kind === 'text').at(-1)
    assert.equal(tile?.text, 'Brent · home')
    assert.equal(tile?.textMsg?.chatGuid, 'guid-brent')
    box.textResult = { ok: false, error: 'Sent but no matching chat.db row yet' }
    await desk.answerText(tile?.id || '', 'yes')
    assert.deepEqual(box.texts, [{ guid: 'guid-brent', body: 'The September note is ready.' }])
    const stamped = mail(desk).find((m) => m.replaces === tile?.id)
    assert.ok(stamped?.actedAt)
    runner.queue('drafts', [{ text: sms('Brent', 'On WhatsApp.', 'WhatsApp') }])
    await desk.say('WhatsApp instead.', 'drafts')
    const wa = mail(desk).filter((m) => m.kind === 'text').at(-1)
    assert.equal(wa?.textMsg?.sendable, false)
    assert.equal(wa?.textMsg?.note, "WhatsApp send from Desk isn't set up. This stays a draft.")
    await desk.answerText(wa?.id || '', 'yes')
    assert.equal(box.whatsapp, 0)
    assert.equal(box.texts.length, 1)
  } finally {
    cleanup()
  }
})

test('an email and a hold in one turn keeps the email', async () => {
  const { runner, desk, cleanup } = boot()
  try {
    runner.queue('drafts', [{ text: `${email({ to: 'Brent <brent@example.com>', subject: 'Numbers', body: 'Body.' })}\n\n${hold('spend', 'Spend?')}` }])
    await desk.say('Both.', 'drafts')
    assert.equal(ofKind(desk, 'email').length, 1)
    assert.equal(ofKind(desk, 'hold').length, 0)
    assert.equal(mail(desk).some((m) => m.system === 'extra-tile' && m.text === 'One tile per turn. The rest was left out.'), true)
  } finally {
    cleanup()
  }
})

test('status makes no model call, and errors name the model that actually ran', async () => {
  const both = () => ({ grok: true, claude: true, gpt: false, cursor: false })
  const { runner, desk, cleanup } = boot({ detect: both })
  try {
    const before = runner.prompts.length
    const card = desk.status()
    assert.equal(card.status, 'stored')
    if (card.status === 'stored') {
      assert.equal(card.msg.from, ME)
      assert.equal(card.msg.to, ME)
      assert.equal(card.msg.kind, 'status')
      assert.ok(card.msg.text.includes('Writer'))
    }
    assert.equal(runner.prompts.length, before)
    runner.queue('conductor', [{ fail: 'not-installed' }])
    const none = boot({ detect: () => ({ grok: false, claude: false, gpt: false, cursor: false }) })
    try {
      none.runner.queue('conductor', [{ fail: 'not-installed' }])
      await none.desk.say('Hello.')
      const err = mail(none.desk).find((m) => m.kind === 'error')
      assert.equal(err?.failure, 'not-installed')
      assert.equal(err?.text, 'No model app is installed on this Mac.')
      assert.ok(err?.lastTry)
    } finally {
      none.cleanup()
    }
    runner.queue('writer', [{ text: 'The draft.', used: { cli: 'grok', model: 'default' } }])
    await desk.say('Draft.', 'writer')
    const fallback = mail(desk).find((m) => m.system === 'fallback' && m.from === 'writer')
    assert.equal(fallback?.text, "Writer's model didn't answer. Used Grok.")
    assert.equal(mail(desk).find((m) => m.text === 'The draft.')?.used?.cli, 'grok')
    runner.queue('writer', [{ fail: 'not-signed-in', cli: 'grok' }])
    await desk.say('Again.', 'writer')
    const signed = mail(desk).filter((m) => m.kind === 'error').at(-1)
    assert.equal(signed?.lastTry?.cli, 'grok')
    assert.ok(signed?.text.includes("Grok isn't signed in."))
    assert.equal(desk.store.readBot('writer')?.cli, 'claude')
    const inputs = signed?.inputs || []
    assert.ok(inputs.length > 0)
    runner.queue('writer', [{ text: 'Retried cleanly.' }])
    await desk.retry(signed?.id || '')
    const retried = mail(desk).find((m) => m.text === 'Retried cleanly.')
    assert.ok(retried?.job)
    assert.notEqual(retried.job, signed?.job)
  } finally {
    cleanup()
  }
})

test('a fourth send is dropped, and stopJob drops the held handoff', async () => {
  const { runner, desk, cleanup } = boot()
  try {
    const four = [1, 2, 3, 4].map((n) => send('Checker', `note ${n}`)).join('\n\n')
    runner.queue('writer', [{ text: four }])
    await desk.say('Pass four.', 'writer')
    assert.equal(ofKind(desk, 'send').length, 3)
    assert.equal(mail(desk).some((m) => m.system === 'extra-tile' && m.text === 'Three handoffs per turn. The rest was left out.'), true)
    runner.queue('conductor', [{ text: assign('Researcher', 'Bounce.', 'A loop.', ['clients/summit/notes.md']) }])
    const bounce = (to: string, n: number) => ({ text: send(to, `pass ${n}`) })
    runner.queue('researcher', [1, 3, 5, 7, 9, 11].map((n) => bounce('Writer', n)))
    runner.queue('writer', [2, 4, 6, 8, 10].map((n) => bounce('Researcher', n)))
    await desk.say('Loop them.')
    assert.equal(mail(desk).some((m) => m.system === 'loop'), true)
    const job = ofKind(desk, 'pack').at(-1)?.job
    assert.ok(job)
    assert.equal(desk.bus.isClosed(job), false)
    const stopped = await desk.stopJob(job)
    assert.equal(stopped.msg?.text, 'Stopped.')
    assert.equal(desk.bus.isClosed(job), true)
  } finally {
    cleanup()
  }
})

test('two browse blocks run the first, and a browse drops the email', async () => {
  const { runner, browser, desk, cleanup } = boot()
  try {
    runner.queue('writer', [
      { text: `${browse('url: https://example.com')}\n\n${browse('click: Pricing')}\n\nFirst only.` },
      { text: `${browse('url: https://example.com/next')}\n\n${email({ to: 'Brent <brent@example.com>', subject: 'Nope', body: 'Body.' })}` },
      { text: 'Done.' }
    ])
    await desk.say('Browse twice.', 'writer')
    assert.equal(browser.steps.length, 2)
    assert.equal(mail(desk).some((m) => m.system === 'extra-tile' && m.text === 'One browser step per turn.'), true)
    assert.equal(ofKind(desk, 'email').length, 0)
    assert.equal(mail(desk).some((m) => m.system === 'extra-tile' && m.text === 'One tile per turn. The rest was left out.'), true)
  } finally {
    cleanup()
  }
})

test('quit and closing Desk stop the busy bot', async () => {
  const { runner, desk, cleanup } = boot()
  try {
    runner.queue('writer', [{ hang: true }])
    const pending = desk.say('Work.', 'writer')
    await until(() => (runner.pending.get('writer') || []).length === 1)
    await desk.quit()
    await pending
    assert.equal(runner.stopAllCount(), 1)
    assert.equal(mail(desk).some((m) => m.kind === 'stopped' && m.text === 'Stopped when Brain quit.' && m.from === 'writer'), true)
    assert.deepEqual(mail(desk).find((m) => m.text === 'Stopped when Brain quit.')?.inputs, [])
  } finally {
    cleanup()
  }
})

test('a restarted controller sends the unsent email and approves the browser hold without focus launching Chrome', async () => {
  const ctx = boot()
  try {
    ctx.runner.queue('drafts', [{ text: email({ reply: 'msg-9', to: 'Brent <brent@example.com>', subject: 'September numbers', body: 'Long note.' }) }])
    await ctx.desk.say('Draft it.', 'drafts')
    const tile = mail(ctx.desk).find((m) => m.kind === 'email')
    assert.ok(tile)
    await ctx.desk.answerEmail(tile.id, 'no')
    const next = bootOn(ctx.brain)
    try {
      assert.equal(stateOf(next.desk, 'drafts').state, 'waiting-you')
      assert.equal(next.desk.bus.isClosed(tile.job || ''), false)
      assert.equal(next.runner.prompts.length, 0)
      next.runner.queue('drafts', [{ text: 'Sent it.' }])
      const visible = next.desk.view('drafts').find((m) => m.kind === 'email')
      assert.ok(visible)
      await next.desk.answerEmail(visible.id, 'yes')
      assert.equal(next.box.emails.length, 1)
      assert.equal(next.runner.prompts.some((p) => p.id === 'drafts'), true)
    } finally {
      next.cleanup()
    }
    const done = boot()
    try {
      done.runner.queue('drafts', [{ text: email({ to: 'Brent <brent@example.com>', subject: 'Gone', body: 'Body.' }) }])
      await done.desk.say('Draft.', 'drafts')
      const gone = mail(done.desk).find((m) => m.kind === 'email')
      assert.ok(gone)
      await done.desk.answerEmail(gone.id, 'yes')
      const restarted = bootOn(done.brain)
      try {
        assert.notEqual(stateOf(restarted.desk, 'drafts').state, 'waiting-you')
        assert.equal(restarted.desk.bus.isClosed(gone.job || ''), true)
      } finally {
        restarted.cleanup()
      }
    } finally {
      done.cleanup()
    }
    const browseDesk = boot()
    try {
      browseDesk.browser.pushStep(page('https://example.com'))
      browseDesk.browser.pushStep({ hold: 'spend', name: 'Pay', url: 'https://example.com' })
      browseDesk.runner.queue('writer', [{ text: browse('url: https://example.com') }, { text: browse('click: Pay') }])
      await browseDesk.desk.say('Hold the click.', 'writer')
      const restarted = bootOn(browseDesk.brain)
      try {
        const holdMsg = restarted.desk.view('writer').find((m) => m.kind === 'hold')
        assert.ok(holdMsg)
        assert.equal(restarted.browser.windowOpen(), false)
        restarted.runner.queue('writer', [{ text: 'Clicked.' }])
        await restarted.desk.answerHold(holdMsg.id, 'yes')
        assert.deepEqual(restarted.browser.clicks, [{ name: 'Pay', url: 'https://example.com' }])
        assert.equal(restarted.desk.view('writer').find((m) => m.kind === 'browse')?.browse?.windowOpen, true)
        const focuses = restarted.browser.focuses()
        restarted.desk.focus()
        assert.equal(restarted.browser.focuses(), focuses + 1)
        restarted.browser.setWindow(false)
        restarted.desk.focus()
        assert.equal(restarted.browser.windowOpen(), false)
      } finally {
        restarted.cleanup()
      }
    } finally {
      browseDesk.cleanup()
    }
  } finally {
    ctx.cleanup()
  }
})

test('the controller asks the close rule after a turn, an answer, and Stop', async () => {
  const calls: string[] = []
  const { runner, desk, cleanup } = boot({
    isOpen: (job, view) => {
      calls.push(job)
      return jobIsOpen(job, view)
    }
  })
  try {
    runner.queue('writer', [{ text: hold('spend', 'May I buy the domain?') }])
    await desk.say('Ask.', 'writer')
    const afterTurn = calls.length
    assert.ok(afterTurn > 0)
    const tile = mail(desk).find((m) => m.kind === 'hold')
    assert.ok(tile?.job)
    assert.equal(desk.bus.isClosed(tile.job), false)
    runner.queue('writer', [{ text: 'Thanks.' }])
    await desk.answerHold(tile.id, 'yes')
    assert.ok(calls.length > afterTurn)
    runner.queue('writer', [{ hang: true }])
    const pending = desk.say('More.', 'writer')
    await until(() => (runner.pending.get('writer') || []).length === 1)
    const beforeStop = calls.length
    await desk.stop('writer')
    await pending
    assert.ok(calls.length > beforeStop)
  } finally {
    cleanup()
  }
})

test('remove refuses a busy bot, and an idle bot with a queued send is dropped', async () => {
  const { brain, runner, desk, cleanup } = boot()
  try {
    desk.saveBot({ id: 'designer', name: 'Designer', cli: 'grok', model: 'default', effort: 'low', description: 'Headlines.' })
    runner.queue('designer', [{ hang: true }])
    const working = desk.say('Work.', 'designer')
    await until(() => (runner.pending.get('designer') || []).length === 1)
    assert.equal(desk.removeBot('designer'), 'Designer is in the middle of something. Finish or stop that first.')
    assert.equal(existsSync(join(brain, 'desk/bots/designer.md')), true)
    runner.release('designer', { text: 'Done.' })
    await working
    runner.queue('designer', [{ text: hold('spend', 'Approve this?') }])
    await desk.say('Ask.', 'designer')
    assert.equal(stateOf(desk, 'designer').state, 'waiting-you')
    assert.equal(desk.removeBot('designer'), 'Designer is in the middle of something. Finish or stop that first.')
    await desk.answerHold(mail(desk).find((m) => m.kind === 'hold')?.id || '', 'no')
    desk.bus.pause('designer')
    runner.queue('researcher', [{ text: send('Designer', 'for you') }])
    await desk.say('Send it.', 'researcher')
    assert.equal(stateOf(desk, 'designer').state, 'idle')
    assert.equal(stateOf(desk, 'researcher').state, 'waiting-bot')
    assert.equal(desk.removeBot('designer'), null)
    assert.equal(existsSync(join(brain, 'desk/bots/designer.md')), false)
    assert.equal(existsSync(memoryFile(brain, 'designer')), false)
    assert.equal(stateOf(desk, 'researcher').state, 'idle')
    assert.equal(mail(desk).some((m) => m.system === 'removed' && m.name === 'Designer'), true)
    assert.equal(runner.prompts.some((p) => p.id === 'designer' && p.prompt.split('\n').some((line) => line.trim() === 'for you')), false)
    for (let i = 0; i < 200; i++) desk.store.appendMail({ from: ME, to: ME, kind: 'task', text: `filler ${i}` })
    assert.equal(desk.list().removedNames.designer, 'Designer')
  } finally {
    cleanup()
  }
})

function bootOn(brain: string) {
  const runner = createRunner()
  const browser = createBrowser()
  const { box, senders } = createSenderBox()
  const desk = createDeskController({
    brain,
    role: 'owner',
    runner,
    browser,
    senders,
    detect: DETECT_GROK,
    now: () => NOW,
    tokenReady: () => true
  })
  return { runner, browser, box, desk, cleanup: () => undefined }
}
