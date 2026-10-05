import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACK_NOTED, REVIEW_MAX, VOICE_MAX, type RunRecord } from '../../shared/factory.ts'
import { buildBrief } from './brief.ts'
import type { Decision, FactoryDeps, StartResult } from './controller.ts'
import type { SpawnFn } from './opus.ts'
import { planPrompt, strictPrompt } from './opus.ts'
import type { ProfilePatch } from './profile.ts'
import { factorySessionRules, watchOnlyDecision } from './gates.ts'
import { TIER_LIMITS } from './tripwire.ts'

registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json|node)$/.test(spec)) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  }
})

const loaded = Promise.all([import('./conductor.ts'), import('./controller.ts'), import('./gates.ts'), import('./profile.ts'), import('./run-store.ts')]).then(
  ([conductor, controller, gates, profile, store]) => ({ conductor, controller, gates, profile, store })
)

const here = fileURLToPath(import.meta.url)
const root = join(here, '../../../..')
const temp = mkdtempSync(join(tmpdir(), 'conductor-'))
const userData = join(temp, 'userData')
const projects = join(temp, 'projects')
mkdirSync(userData, { recursive: true })
mkdirSync(projects, { recursive: true })

let explainRun: (run: RunRecord) => string
let conduct: (id: string, text: string) => Promise<RunRecord>
let configureFactory: (next: FactoryDeps) => void
let startRun: (input: { task: string; workRepo: string; brainPath: string }) => StartResult
let getRun: (id: string) => RunRecord | null
let decideRun: (id: string, choice: Decision) => RunRecord
let settle: (id: string) => Promise<RunRecord | null>
let factoryGen: (id: string) => number
let dropMemory: () => void
let saveProfile: (repo: string, profile: ProfilePatch) => unknown
let setUserDataDir: (fn: () => string) => void
let KENNEL_DEPLOY_REFUSAL = ''

const STATUS = "What's happening?"
const STATUS_REPLY = 'The build is still running.'
const STATUS_SHIP = 'how far has it gotten'
const EDIT = 'please make the button blue'
const EDIT_TEXT = 'make the button blue'
const EDIT_REPLY = 'Filing that edit.'
const BAD = 'open the pod bay doors'
const REVIEW_GO = 'Continue fixing and running the review until approval'
const VOICE_GO = 'Continue the voice fixes until voice approves'
const TIER_GO = 'Continue past the tier stop'
const PROCEED_GO = 'Proceed past this hold'
const STOP = 'Stop'
const SHIP = "Let's get this live"
const SHIP_REPLY = 'Committing, then pushing, then deploying.'
const APPROVE = 'Approve the plan.'
const APPROVE_REPLY = 'Approving the plan.'
const BAD_CHOICE = 'Jump to done.'
const PAUSE = 'Pause this run.'
const RESUME = 'Resume this run.'

test('plan, strict, and build wording, and the T3 limit stays', () => {
  const plan = planPrompt({ task: 'add a webhook endpoint feature', workRepo: '/x', plans: [], reasons: [], tier: 'T2' })
  assert.match(plan, /before any edit/)
  assert.equal(plan.includes('The fixer adds the named test'), false)
  const t3 = planPrompt({ task: 't', workRepo: '/x', plans: [], reasons: [], tier: 'T3' })
  assert.ok(t3.includes('Limit T3: no file or line cap; no lockfile changes, no migrations.'))
  const strict = strictPrompt({ task: 't', tier: 'T2', risk: 'elevated', base: 'abc', diff: 'd', workRepo: '/x' })
  assert.match(strict, /A green check that only restates the new code is a fail/)
  const brief = buildBrief({
    role: 'builder',
    tier: 'T2',
    phase: 'build',
    workRepo: '/x',
    brainPath: '/b',
    task: 'add a webhook endpoint feature'
  })
  assert.match(brief, /Run the check from the plan/)
  assert.match(brief, /Do not add a unit test that restates the change/)
  assert.deepEqual(TIER_LIMITS.T3, { files: Infinity, lines: Infinity })
  const pane = readFileSync(join(root, 'src/renderer/src/FactoryPane.tsx'), 'utf8')
  const send = pane.slice(pane.indexOf('async function sendNote'), pane.indexOf('const voiceHeld'))
  assert.match(send, /factory\.conduct\(/)
  assert.equal(send.includes('factory.guide('), false)
  assert.match(pane, /placeholder="Ask about this run"/)
  assert.equal(pane.includes('placeholder="Guide this run"'), false)
  assert.ok(send.indexOf('showOutgoing(') < send.indexOf('factory.conduct('))
  const guideAt = pane.indexOf("e.kind === 'guide'")
  const streamAt = pane.indexOf("e.kind !== 'stream'")
  assert.ok(guideAt > 0 && streamAt > guideAt)
  assert.equal(pane.slice(guideAt, streamAt).includes('setActivity'), false)
  assert.match(pane.slice(guideAt, streamAt), /raw: p\.raw/)
  assert.equal(watchOnlyDecision(true, 'read', 'ask', false), 'allow')
  assert.equal(watchOnlyDecision(true, 'edit', 'ask', true), 'reject')
  assert.equal(watchOnlyDecision(false, 'edit', 'ask', false), 'ask')
  assert.equal(watchOnlyDecision(false, 'edit', 'ask', true), 'allow')
  assert.equal(factorySessionRules('factory-1'), '')
  assert.equal(factorySessionRules('factory-1-orch').includes('You are a Factory builder'), false)
  assert.match(factorySessionRules('factory-1-orch'), /Do not edit/)
})

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Factory Check', '-c', 'user.email=factory@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8'
  })
}

function repo(name: string): string {
  const dir = join(temp, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Factory Check'])
  git(dir, ['config', 'user.email', 'factory@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'src.ts'), 'export const n = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

function addRemote(dir: string): void {
  const bare = `${dir}.git`
  git(temp, ['init', '--bare', '-q', bare])
  git(dir, ['remote', 'add', 'origin', bare])
}

function child(out: string, code = 0, wait?: Promise<void>) {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = () => true
  setTimeout(() => {
    const send = () => {
      c.stdout.emit('data', Buffer.from(out))
      c.emit('close', code)
    }
    if (wait) void wait.then(send)
    else send()
  }, 0)
  return c
}

function envelope(result: string): string {
  return JSON.stringify({ result, total_cost_usd: 0, num_turns: 1 })
}

let prompts: string[] = []
let promptCalls: { tabId: string; text: string }[] = []
let warms: string[] = []
let orchMode: 'card' | 'empty' | 'throw' | 'tell' | 'notell' | 'tell-anyway' = 'card'
let cancels = 0
let pubs: { allow?: boolean }[] = []
let publishAllow: boolean | undefined
let deploys = 0
let opusSeen: string[][] = []
let trace: string[] = []
let hang = false
let armGate = false
const gate: { release: ((value?: void) => void) | null } = { release: null }
function gateOpen(): boolean {
  return gate.release !== null
}
function fireGate(): void {
  const go = gate.release
  gate.release = null
  go?.()
}
let raiseCritical = false
let holdTriage = false
let triageJunk = false
const triageGate: { release: ((value?: void) => void) | null } = { release: null }
function triageOpen(): boolean {
  return triageGate.release !== null
}
function fireTriage(): void {
  const go = triageGate.release
  triageGate.release = null
  go?.()
}
let voiceCode = 0
let opusPass = false
let failsLeft = 1_000_000
let touch: () => void = () => {}
let lastPrompt = ''
let activeId = ''
let stamp = 0

/** A fix that writes the same bytes pauses on the third unchanged diff. Each turn changes one comment. */
function stampWork(): void {
  if (!activeId) return
  const repo = getRun(activeId)?.workRepo
  if (!repo) return
  const file = join(repo, 'src.ts')
  if (!existsSync(file)) return
  stamp++
  const cur = readFileSync(file, 'utf8').replace(/\n\/\*s\d+\*\/$/, '')
  writeFileSync(file, `${cur.replace(/\n$/, '')}\n/*s${stamp}*/`)
}

function replyFromCard(prompt: string): string {
  const cycles = prompt.match(/^reviewCycles: (\d+)$/m)
  const strict = prompt.match(/^strict: (\S+)$/m)
  if (!cycles || !strict) return 'no card'
  return `Strict rejects: ${cycles[1]}. Latest review: ${strict[1]}.`
}

function orchAnswer(prompt: string): string {
  lastPrompt = prompt
  if (orchMode === 'throw') throw new Error('session down')
  if (orchMode === 'empty') return ''
  if (orchMode === 'tell') return 'Adding that.\nFACTORY_TELL: add a footer credit'
  if (orchMode === 'notell') return 'I can add that.'
  if (orchMode === 'tell-anyway') return 'It is still going.\nFACTORY_TELL: add a footer credit'
  return replyFromCard(prompt)
}

function replyFor(prompt: string): string {
  const joe = (prompt.split('\n').find((l) => l.startsWith('Joe: ')) || '').slice(5)
  if (joe === STATUS) return JSON.stringify({ kind: 'none', reply: STATUS_REPLY })
  if (joe === STATUS_SHIP) return JSON.stringify({ kind: 'ship', reply: SHIP_REPLY })
  if (joe === EDIT) return JSON.stringify({ kind: 'guide', text: EDIT_TEXT, reply: EDIT_REPLY })
  if (joe === BAD) return JSON.stringify({ kind: 'teleport', phase: 'done', reply: 'no' })
  if (joe === REVIEW_GO) return JSON.stringify({ kind: 'override', boundary: 'review', on: true, reply: 'Review continues.' })
  if (joe === VOICE_GO) return JSON.stringify({ kind: 'override', boundary: 'voice', on: true, reply: 'Voice continues.' })
  if (joe === TIER_GO) return JSON.stringify({ kind: 'override', boundary: 'tier', on: true, reply: 'Tier continues.' })
  if (joe === PROCEED_GO) return JSON.stringify({ kind: 'override', boundary: 'proceed', on: true, reply: 'Proceeding.' })
  if (joe === STOP) return JSON.stringify({ kind: 'override', boundary: 'review', on: false, reply: 'Stopped.' })
  if (joe === SHIP) return JSON.stringify({ kind: 'ship', reply: SHIP_REPLY })
  if (joe === APPROVE) return JSON.stringify({ kind: 'decide', choice: 'approve-plan', reply: APPROVE_REPLY })
  if (joe === BAD_CHOICE) return JSON.stringify({ kind: 'decide', choice: 'teleport', reply: 'no' })
  if (joe === PAUSE) return JSON.stringify({ kind: 'pause', reply: 'Paused.' })
  if (joe === RESUME) return JSON.stringify({ kind: 'resume', reply: 'Resumed.' })
  return JSON.stringify({ kind: 'none', reply: 'unsure' })
}

const deps: FactoryDeps = {
  driver: {
    warm: async (o) => {
      warms.push(String(o.tabId || ''))
      return { sessionId: 'sess' }
    },
    prompt: async (o) => {
      const tabId = String(o.tabId || '')
      const text = String(o.text || '')
      promptCalls.push({ tabId, text })
      if (tabId.endsWith('-orch')) return orchAnswer(text)
      prompts.push(text)
      if (hang) return new Promise(() => {})
      if (armGate) {
        armGate = false
        await new Promise<void>((r) => {
          gate.release = r
        })
      }
      touch()
      stampWork()
      return ''
    },
    cancel: () => {
      cancels++
    },
    close: () => {}
  },
  emit: () => {},
  env: () => ({ ...process.env }),
  runScript: async () => ({ code: 0, out: 'ok' }),
  grokBin: () => '/usr/bin/true',
  claudeBin: () => '/usr/bin/true',
  projectsDir: projects,
  askConductor: async (prompt) => {
    lastPrompt = prompt
    return replyFor(prompt)
  },
  spawnTriage: (() => {
    const data = raiseCritical
      ? { size: 'T2', risk: 'critical', reason: 'raised' }
      : { size: 'T0', risk: 'none', reason: 'ok' }
    const payload = triageJunk ? 'not-json' : JSON.stringify(data)
    let wait: Promise<void> | undefined
    if (holdTriage) {
      holdTriage = false
      wait = new Promise<void>((r) => {
        triageGate.release = r
      })
    }
    return child(JSON.stringify({ type: 'text', data: payload }) + '\n', 0, wait)
  }) as unknown as FactoryDeps['spawnTriage'],
  spawnOpus: ((_bin: string, args: string[]) => {
    opusSeen.push(args)
    trace.push('opus')
    const prompt = String(args[args.indexOf('-p') + 1] || '')
    const effortAt = args.indexOf('--effort')
    const effort = effortAt >= 0 ? args[effortAt + 1] : ''
    // Strict review is effort low. A review-cap fix is an Opus build (medium, bypassPermissions)
    // and must not use up the one allowed strict fail. Kennel's gate is medium and follows opusPass.
    let result = 'GAPS: 0\nPASS'
    if (prompt.includes('Write the implementation plan')) result = 'Files: src.ts\nCheck: the route answers.\n'
    else if (effort === 'low') {
      if (!(opusPass || failsLeft <= 0)) {
        result = 'gap\nGAPS: 1\nFAIL'
        failsLeft--
      }
    } else if (!opusPass) result = 'gap\nGAPS: 1\nFAIL'
    let wait: Promise<void> | undefined
    if (args.includes('bypassPermissions')) stampWork()
    if (armGate && args.includes('bypassPermissions')) {
      armGate = false
      wait = new Promise<void>((r) => {
        gate.release = r
      })
    }
    return child(envelope(result), 0, wait)
  }) as unknown as SpawnFn,
  spawnVoice: (() => child('REJECT: no\n', voiceCode)) as unknown as FactoryDeps['spawnVoice'],
  voiceCheckPath: here,
  publish: async (_repo, _t, over) => {
    trace.push('publish')
    publishAllow = over?.allowProtected
    pubs.push({ allow: over?.allowProtected })
    return { ok: true, out: '' }
  },
  deploy: async () => {
    trace.push('deploy')
    deploys++
    return { ok: true, out: 'up' }
  }
}

function reset(): void {
  prompts = []
  promptCalls = []
  warms = []
  orchMode = 'card'
  cancels = 0
  pubs = []
  publishAllow = undefined
  deploys = 0
  opusSeen = []
  trace = []
  hang = false
  armGate = false
  gate.release = null
  raiseCritical = false
  holdTriage = false
  triageJunk = false
  triageGate.release = null
  voiceCode = 0
  opusPass = false
  failsLeft = 1_000_000
  touch = () => {}
  lastPrompt = ''
  dropMemory()
}

async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  const run = activeId ? getRun(activeId) : null
  throw new Error(`${label} phase=${run?.phase} cycles=${run?.reviewCycles} voice=${run?.voiceCycles} strict=${run?.strict?.status} err=${run?.error} prompts=${prompts.length}`)
}

function runOf() {
  const run = getRun(activeId)
  if (!run) throw new Error('run gone')
  return run
}

async function boot(name: string, task: string, o: { voice?: boolean; remote?: boolean } = {}): Promise<string> {
  const dir = repo(name)
  if (o.remote) addRemote(dir)
  if (o.voice || o.remote) saveProfile(dir, { ...(o.voice ? { voice: { on: true } } : {}), ...(o.remote ? { deploy: { cmd: 'echo up' } } : {}) })
  const brain = repo(`${name}-brain`)
  const res = startRun({ task, workRepo: dir, brainPath: brain })
  if (!res.ok) throw new Error(res.error)
  activeId = res.run.id
  return dir
}

test('conductor drives the factory from the guide box', async () => {
  const mods = await loaded
  explainRun = mods.controller.explainRun
  conduct = mods.conductor.conduct
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  decideRun = mods.controller.decideRun
  settle = mods.controller.settle
  factoryGen = mods.controller.factoryGen
  dropMemory = mods.controller.dropMemory
  saveProfile = mods.profile.saveProfile
  setUserDataDir = mods.store.setUserDataDir
  KENNEL_DEPLOY_REFUSAL = mods.gates.KENNEL_DEPLOY_REFUSAL
  setUserDataDir(() => userData)
  configureFactory(deps)
  reset()
  const work = await boot('status', 'fix typo in footer')
  touch = () => writeFileSync(join(work, 'src.ts'), 'export const n = 2\n')
  hang = true
  await until(() => runOf().phase === 'build' && prompts.length > 0, 'in-flight build')
  const gen = factoryGen(activeId)
  const cancelled = cancels
  await conduct(activeId, STATUS)
  const run = runOf()
  assert.equal(factoryGen(activeId), gen)
  assert.equal(cancels, cancelled)
  assert.equal(run.phase, 'build')
  const note = (run.guide || []).find((g) => g.text === STATUS)
  assert.equal(note?.sent, true)
  assert.equal(note?.ack, replyFromCard(lastPrompt))
  assert.notEqual(note?.ack, ACK_NOTED)
  assert.equal((run.guide || []).some((g) => !g.sent && g.text === STATUS), false)
  assert.match(lastPrompt, /phase: build/)
  assert.match(lastPrompt, /tier: /)
  assert.match(lastPrompt, /risk: /)
  assert.match(lastPrompt, /live: \[\{/)
  assert.match(lastPrompt, /"phase":"build"/)
  assert.match(lastPrompt, /reviewCycles: /)
  assert.match(lastPrompt, /voiceCycles: /)
  assert.match(lastPrompt, /hold: /)
  assert.match(lastPrompt, /error: /)
  assert.match(lastPrompt, /override: /)
  assert.match(lastPrompt, /strict: /)
  assert.match(lastPrompt, /voice: /)
  assert.match(lastPrompt, /needsProceed: /)
  assert.match(lastPrompt, /suggest: /)
  assert.match(lastPrompt, /guide: /)
  assert.ok(lastPrompt.includes(STATUS))
  assert.equal(run.override?.review, undefined)
  assert.equal(run.override?.voice, undefined)
  assert.equal(run.override?.tier, undefined)
  assert.equal(run.override?.proceed, undefined)
  const firstAck = note?.ack || ''
  await conduct(activeId, STATUS)
  assert.match(lastPrompt, /"text":"What's happening\?"/)
  assert.ok(lastPrompt.includes(firstAck))
  const shipAskGen = factoryGen(activeId)
  await conduct(activeId, STATUS_SHIP)
  const shipAsk = (runOf().guide || []).find((g) => g.text === STATUS_SHIP)
  assert.equal(runOf().phase, 'build')
  assert.equal(factoryGen(activeId), shipAskGen)
  assert.equal(pubs.length, 0)
  assert.equal(shipAsk?.sent, true)
  assert.equal(shipAsk?.ask, true)
  assert.equal(shipAsk?.repo, '')
  assert.equal(shipAsk?.ack, replyFromCard(lastPrompt))
  assert.notEqual(shipAsk?.ack, SHIP_REPLY)
  await conduct(activeId, SHIP)
  assert.equal(runOf().phase, 'build')
  assert.equal(pubs.length, 0)
  assert.equal(deploys, 0)
  const refused = (runOf().guide || []).find((g) => g.text === SHIP)
  assert.equal(refused?.ack, 'Commit is only offered after review.')

  reset()
  const editRepo = await boot('edit', 'fix typo in footer')
  touch = () => writeFileSync(join(editRepo, 'src.ts'), 'export const n = 3\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'edit review')
  const beforeEdit = prompts.length
  const editGen = factoryGen(activeId)
  await conduct(activeId, EDIT)
  const edited = runOf()
  const editNote = (edited.guide || []).find((g) => g.text === EDIT)
  assert.ok(editNote)
  assert.equal((edited.guide || []).some((g) => g.text === EDIT_TEXT), false)
  assert.equal(editNote?.sent, true)
  assert.equal(editNote?.ask, true)
  assert.equal(editNote?.repo, '')
  assert.equal(editNote?.ack, replyFromCard(lastPrompt))
  assert.notEqual(editNote?.ack, EDIT_REPLY)
  assert.equal(factoryGen(activeId), editGen)
  assert.equal(prompts.length, beforeEdit)
  assert.equal(edited.phase, 'review')
  await settle(activeId)

  reset()
  const badRepo = await boot('bad', 'fix typo in footer')
  touch = () => writeFileSync(join(badRepo, 'src.ts'), 'export const n = 4\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'bad review')
  const badGen = factoryGen(activeId)
  await conduct(activeId, BAD)
  assert.equal(runOf().phase, 'review')
  assert.equal(factoryGen(activeId), badGen)
  await conduct(activeId, APPROVE)
  const thrown = (runOf().guide || []).find((g) => g.text === APPROVE)
  assert.match(thrown?.ack || '', /not waiting on a plan/)
  assert.notEqual(thrown?.ack, APPROVE_REPLY)
  assert.equal(runOf().phase, 'review')

  reset()
  failsLeft = 1_000_000
  const holdRepo = await boot('hold', 'add a webhook endpoint feature')
  touch = () => writeFileSync(join(holdRepo, 'src.ts'), 'export const n = 5\n')
  await until(() => runOf().phase === 'plan' && !!runOf().plan?.text, 'hold plan')
  decideRun(activeId, 'approve-plan')
  await until(() => runOf().phase === 'review' && !!runOf().diff && (runOf().reviewCycles || 0) >= REVIEW_MAX && runOf().strict?.status === 'fail', 'review hold')
  failsLeft = 1
  const pubsAtHold = pubs.length
  await conduct(activeId, REVIEW_GO)
  await settle(activeId)
  const continued = runOf()
  assert.equal(continued.override?.review, true)
  assert.equal(continued.override?.voice, undefined)
  assert.equal(continued.override?.tier, undefined)
  assert.equal(continued.override?.proceed, undefined)
  assert.ok((continued.reviewCycles || 0) > REVIEW_MAX)
  assert.equal(continued.strict?.status, 'pass')
  assert.equal(pubs.length, pubsAtHold)
  assert.notEqual(continued.phase, 'done')

  reset()
  const upRepo = await boot('up-stop', 'fix typo in footer')
  touch = () => {
    writeFileSync(join(upRepo, 'src.ts'), 'export const n = 6\n')
    writeFileSync(join(upRepo, 'extra.ts'), 'export const x = 1\n')
  }
  await until(() => runOf().phase === 'upgrade', 'upgrade hold')
  const tierBefore = runOf().tier
  await conduct(activeId, REVIEW_GO)
  assert.equal(runOf().phase, 'upgrade')
  assert.equal(runOf().tier, tierBefore)
  assert.equal(runOf().override?.tier, undefined)

  reset()
  raiseCritical = true
  await boot('proceed-stop', 'add a webhook endpoint feature')
  await until(() => runOf().phase === 'triage' && !!runOf().needsProceed, 'proceed hold')
  await conduct(activeId, REVIEW_GO)
  assert.equal(runOf().needsProceed, true)
  assert.equal(runOf().phase, 'triage')
  assert.equal(runOf().override?.proceed, undefined)

  reset()
  voiceCode = 2
  opusPass = true
  const voiceRepo = await boot('voice-stop', 'add a webhook endpoint feature', { voice: true })
  touch = () => writeFileSync(join(voiceRepo, 'README.md'), 'Hello there\n')
  await until(() => runOf().phase === 'plan' && !!runOf().plan?.text, 'voice plan')
  decideRun(activeId, 'approve-plan')
  await until(() => runOf().voice?.status === 'fail' && (runOf().voiceCycles || 0) >= VOICE_MAX && !!runOf().diff, 'voice hold')
  const voiceCycles = runOf().voiceCycles
  const voicePrompts = prompts.length
  await conduct(activeId, REVIEW_GO)
  assert.equal(runOf().voiceCycles, voiceCycles)
  assert.equal(prompts.length, voicePrompts)
  assert.equal(runOf().voice?.status, 'fail')
  assert.equal(runOf().override?.voice, undefined)

  reset()
  failsLeft = 1_000_000
  const stopRepo = await boot('stop', 'add a webhook endpoint feature')
  touch = () => writeFileSync(join(stopRepo, 'src.ts'), 'export const n = 7\n')
  await until(() => runOf().phase === 'plan' && !!runOf().plan?.text, 'stop plan')
  decideRun(activeId, 'approve-plan')
  await until(() => (runOf().reviewCycles || 0) >= REVIEW_MAX && runOf().strict?.status === 'fail' && !!runOf().diff, 'stop hold')
  armGate = true
  const cont = conduct(activeId, REVIEW_GO)
  await until(() => gateOpen(), 'gated fix')
  await cont
  await conduct(activeId, STOP)
  const opusAtStop = opusSeen.length
  failsLeft = 1_000_000
  fireGate()
  await settle(activeId)
  const stopped = runOf()
  assert.notEqual(stopped.override?.review, true)
  assert.equal(stopped.phase, 'review')
  assert.equal(stopped.strict?.status, 'fail')
  assert.ok(stopped.diff)
  assert.equal(opusSeen.length, opusAtStop + 1)
  assert.ok((stopped.reviewCycles || 0) >= REVIEW_MAX)

  reset()
  voiceCode = 2
  opusPass = true
  const voiceGo = await boot('voice-go', 'add a webhook endpoint feature', { voice: true })
  touch = () => writeFileSync(join(voiceGo, 'README.md'), 'Hello there\n')
  await until(() => runOf().phase === 'plan' && !!runOf().plan?.text, 'voice-go plan')
  decideRun(activeId, 'approve-plan')
  await until(() => runOf().voice?.status === 'fail' && (runOf().voiceCycles || 0) >= VOICE_MAX, 'voice-go hold')
  armGate = true
  const voiceCont = conduct(activeId, VOICE_GO)
  await until(() => gateOpen(), 'voice gate')
  await voiceCont
  const voiced = runOf()
  const postKick = voiced.voiceCycles || 0
  const rejectAtKick = prompts.filter((p) => p.includes('Voice check said REJECT')).length
  assert.equal(voiced.override?.voice, true)
  assert.equal(voiced.override?.review, undefined)
  assert.equal(voiced.override?.tier, undefined)
  assert.equal(voiced.override?.proceed, undefined)
  assert.ok(postKick > VOICE_MAX)
  assert.ok(rejectAtKick >= 1)
  armGate = true
  voiceCode = 2
  fireGate()
  await until(
    () => gateOpen() && (runOf().voiceCycles || 0) > postKick && prompts.filter((p) => p.includes('Voice check said REJECT')).length > rejectAtKick,
    'voice continued'
  )
  voiceCode = 0
  opusPass = true
  fireGate()
  await settle(activeId)

  reset()
  const tierRepo = await boot('tier', 'fix typo in footer')
  touch = () => {
    writeFileSync(join(tierRepo, 'src.ts'), 'export const n = 8\n')
    writeFileSync(join(tierRepo, 'extra.ts'), 'export const x = 2\n')
  }
  await until(() => runOf().phase === 'upgrade' && !!runOf().tripwire?.suggest, 'tier hold')
  await conduct(activeId, TIER_GO)
  const tiered = runOf()
  assert.equal(tiered.override?.tier, true)
  assert.equal(tiered.override?.review, undefined)
  assert.equal(tiered.override?.voice, undefined)
  assert.equal(tiered.override?.proceed, undefined)
  assert.equal(tiered.tier, 'T1')
  assert.notEqual(tiered.phase, 'upgrade')
  await settle(activeId)

  reset()
  raiseCritical = true
  await boot('proceed', 'add a webhook endpoint feature')
  await until(() => !!runOf().needsProceed, 'proceed wait')
  raiseCritical = false
  await conduct(activeId, PROCEED_GO)
  const proceeded = runOf()
  assert.equal(proceeded.override?.proceed, true)
  assert.equal(proceeded.override?.review, undefined)
  assert.equal(proceeded.override?.voice, undefined)
  assert.equal(proceeded.override?.tier, undefined)
  assert.equal(proceeded.needsProceed, undefined)
  assert.notEqual(proceeded.phase, 'triage')
  await settle(activeId)

  reset()
  holdTriage = true
  triageJunk = true
  const missRepo = await boot('proceed-flag', 'fix typo in footer')
  touch = () => writeFileSync(join(missRepo, 'src.ts'), 'export const n = 12\n')
  await until(() => triageOpen() && runOf().phase === 'triage', 'flagged triage')
  await conduct(activeId, PROCEED_GO)
  assert.equal(runOf().override?.proceed, true)
  assert.equal(runOf().needsProceed, undefined)
  fireTriage()
  await until(() => runOf().phase !== 'triage', 'flagged triage left')
  assert.equal(runOf().needsProceed, undefined)
  await settle(activeId)

  reset()
  holdTriage = true
  raiseCritical = true
  await boot('proceed-critical-flag', 'add a webhook endpoint feature')
  await until(() => triageOpen() && runOf().phase === 'triage', 'critical flag triage')
  await conduct(activeId, PROCEED_GO)
  assert.equal(runOf().override?.proceed, true)
  fireTriage()
  await until(() => runOf().phase === 'plan' || !!runOf().needsProceed, 'critical flag result')
  assert.equal(runOf().needsProceed, undefined)
  assert.equal(runOf().phase, 'plan')
  await settle(activeId)

  reset()
  const planRepo = await boot('approve', 'add a webhook endpoint feature')
  touch = () => writeFileSync(join(planRepo, 'src.ts'), 'export const n = 13\n')
  await until(() => runOf().phase === 'plan' && runOf().plan?.status === 'waiting' && !!runOf().plan?.text, 'approve wait')
  const planGen = factoryGen(activeId)
  const planOpus = opusSeen.filter((a) => String(a[a.indexOf('-p') + 1] || '').includes('Write the implementation plan')).length
  await conduct(activeId, BAD_CHOICE)
  assert.equal(runOf().phase, 'plan')
  assert.equal(runOf().plan?.status, 'waiting')
  assert.equal(factoryGen(activeId), planGen)
  await conduct(activeId, APPROVE)
  const approvedNote = (runOf().guide || []).find((g) => g.text === APPROVE)
  assert.equal(approvedNote?.sent, true)
  assert.equal(approvedNote?.ack, APPROVE_REPLY)
  assert.equal((runOf().guide || []).some((g) => g.text === APPROVE && !g.sent), false)
  await until(() => runOf().phase !== 'plan', 'approved')
  assert.equal(opusSeen.filter((a) => String(a[a.indexOf('-p') + 1] || '').includes('Write the implementation plan')).length, planOpus)
  await settle(activeId)

  reset()
  const pauseRepo = await boot('pause', 'fix typo in footer')
  touch = () => writeFileSync(join(pauseRepo, 'src.ts'), 'export const n = 14\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'pause review')
  await conduct(activeId, PAUSE)
  assert.equal(runOf().phase, 'paused')
  assert.equal((runOf().guide || []).find((g) => g.text === PAUSE)?.ack, 'Paused.')
  await conduct(activeId, RESUME)
  assert.equal(runOf().phase, 'review')
  assert.equal((runOf().guide || []).find((g) => g.text === RESUME)?.ack, 'Resumed.')

  reset()
  const injectRepo = await boot('inject', 'fix typo in footer')
  touch = () => writeFileSync(join(injectRepo, 'src.ts'), 'export const n = 15\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'inject review')
  await conduct(activeId, PAUSE)
  const injectGen = factoryGen(activeId)
  const injectPrompts = prompts.length
  await conduct(activeId, 'we forgot the soffit, add this to the plan')
  const injected = runOf()
  const injectNote = (injected.guide || []).find((g) => g.text.includes('soffit'))
  assert.equal(injected.phase, 'paused')
  assert.equal(factoryGen(activeId), injectGen)
  assert.equal(prompts.length, injectPrompts)
  assert.equal(injectNote?.sent, false)
  assert.equal(injectNote?.repo, '')
  assert.match(injectNote?.ack || '', /Filed with the plan/)
  assert.equal(realpathSync(injected.workRepo), realpathSync(injectRepo))

  reset()
  voiceCode = 2
  opusPass = true
  const shipRepo = await boot('ship', 'add a webhook endpoint feature', { voice: true, remote: true })
  touch = () => writeFileSync(join(shipRepo, 'README.md'), 'Ship this copy\n')
  await until(() => runOf().phase === 'plan' && !!runOf().plan?.text, 'ship plan')
  decideRun(activeId, 'approve-plan')
  await until(() => runOf().voice?.status === 'fail' && (runOf().voiceCycles || 0) >= VOICE_MAX && !!runOf().diff, 'ship voice hold')
  assert.equal(runOf().override?.review, undefined)
  trace = []
  await conduct(activeId, SHIP)
  const shipped = runOf()
  assert.ok(shipped.commitSha)
  assert.equal(pubs.length, 1)
  assert.equal(publishAllow, true)
  assert.ok(shipped.pushed)
  assert.ok(shipped.deployed)
  assert.equal(trace[0], 'publish')
  assert.equal(trace[1], 'deploy')
  assert.equal(deploys, 1)
  assert.equal((shipped.guide || []).find((g) => g.text === SHIP)?.ack, SHIP_REPLY)

  reset()
  const upShip = await boot('up-ship', 'fix typo in footer', { remote: true })
  touch = () => {
    writeFileSync(join(upShip, 'src.ts'), 'export const n = 9\n')
    writeFileSync(join(upShip, 'extra.ts'), 'export const x = 3\n')
  }
  await until(() => runOf().phase === 'upgrade', 'upgrade ship')
  await conduct(activeId, SHIP)
  assert.ok(runOf().commitSha)
  assert.equal(runOf().phase, 'done')

  reset()
  opusPass = false
  failsLeft = 1_000_000
  const kennel = await boot('mykennel', 'fix typo in footer', { remote: true })
  touch = () => writeFileSync(join(kennel, 'src.ts'), 'export const n = 10\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'kennel review')
  trace = []
  opusSeen = []
  await conduct(activeId, SHIP)
  assert.equal(pubs.length, 0)
  assert.equal(deploys, 0)
  assert.ok(opusSeen.length >= 1)
  const effortAt = opusSeen[0].indexOf('--effort')
  assert.equal(opusSeen[0][effortAt + 1], 'medium')
  assert.equal(trace.includes('publish'), false)
  assert.ok(runOf().commitSha)
  assert.match(runOf().pushError || '', /Kennel gate/)
  assert.match((runOf().guide || []).find((g) => g.text === SHIP)?.ack || '', /Kennel gate/)

  reset()
  opusPass = true
  const kennelOk = await boot('mykennel-ok', 'fix typo in footer', { remote: true })
  touch = () => writeFileSync(join(kennelOk, 'src.ts'), 'export const n = 11\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'kennel pass review')
  trace = []
  await conduct(activeId, SHIP)
  const kennelRun = runOf()
  assert.equal(trace[0], 'opus')
  assert.equal(trace[1], 'publish')
  assert.equal(pubs.length, 1)
  assert.equal(kennelRun.deployError, KENNEL_DEPLOY_REFUSAL)
  assert.equal((kennelRun.guide || []).find((g) => g.text === SHIP)?.ack, KENNEL_DEPLOY_REFUSAL)
  assert.equal(deploys, 0)

  reset()
  const cardRepo = await boot('card', 'fix typo in footer')
  touch = () => writeFileSync(join(cardRepo, 'src.ts'), 'export const n = 12\n')
  await until(() => runOf().phase === 'review' && !!runOf().diff, 'card review')
  await settle(activeId)
  const card = runOf()
  card.reviewCycles = 2
  card.strict = { status: 'fail', text: 'gap' }
  card.live = [{ id: 'c', phase: 'review', cli: 'claude', model: 'opus', effort: 'low', since: 1 }]
  const ask = 'how many reviews and fails so far?'
  const gen0 = factoryGen(activeId)
  const built0 = prompts.length
  const warms0 = warms.length
  await conduct(activeId, ask)
  const asked = (runOf().guide || []).find((g) => g.text === ask)
  assert.match(lastPrompt, /reviewCycles: 2/)
  assert.match(lastPrompt, /strict: fail/)
  assert.equal(asked?.ack, replyFromCard(lastPrompt))
  assert.equal(factoryGen(activeId), gen0)
  assert.equal(prompts.length, built0)
  assert.equal((runOf().guide || []).some((g) => !g.sent), false)
  assert.equal(warms.filter((t) => t.endsWith('-orch')).length, 1)
  assert.notEqual(warms.find((t) => t.endsWith('-orch')), card.acpTab)
  await conduct(activeId, ask)
  assert.equal(warms.filter((t) => t.endsWith('-orch')).length, 1)
  assert.equal(warms.length, warms0 + 1)
  const stripped = lastPrompt.replace(/^reviewCycles:.*$/m, '').replace(/^strict:.*$/m, '')
  assert.equal(replyFromCard(stripped), 'no card')
  assert.equal(replyFromCard(stripped).includes('2'), false)
  assert.equal(replyFromCard(stripped).includes('fail'), false)
  orchMode = 'empty'
  const empty = await conduct(activeId, ask)
  const emptyAck = (empty.guide || []).filter((g) => g.text === ask).pop()?.ack
  assert.match(emptyAck || '', /2/)
  assert.match(emptyAck || '', /fail/)
  assert.match(emptyAck || '', /claude/)
  assert.notEqual(emptyAck, explainRun(runOf()))
  orchMode = 'throw'
  const thrownAsk = await conduct(activeId, 'how many reviews and fails so far?')
  const thrownAck = (thrownAsk.guide || []).filter((g) => g.text === ask).pop()?.ack
  assert.match(thrownAck || '', /2/)
  assert.match(thrownAck || '', /fail/)
  assert.match(thrownAck || '', /claude/)
  assert.notEqual(thrownAck, explainRun(runOf()))
  const later = runOf()
  later.reviewCycles = 9
  later.strict = { status: 'pass', text: '' }
  later.live = [{ id: 'c', phase: 'review', cli: 'claude', model: 'opus', effort: 'low', since: 1 }]
  orchMode = 'card'
  await conduct(activeId, ask)
  const nine = (runOf().guide || []).filter((g) => g.text === ask).pop()?.ack
  assert.equal(nine, replyFromCard(lastPrompt))
  assert.match(nine || '', /9/)
  assert.match(nine || '', /pass/)
  assert.equal((nine || '').includes('Strict rejects: 2'), false)

  orchMode = 'notell'
  const gen1 = factoryGen(activeId)
  const built1 = prompts.length
  const unsent1 = (runOf().guide || []).filter((g) => !g.sent).length
  await conduct(activeId, 'add a footer credit to this run')
  const missed = (runOf().guide || []).find((g) => g.text === 'add a footer credit to this run')
  assert.equal(factoryGen(activeId), gen1)
  assert.equal(prompts.length, built1)
  assert.equal((runOf().guide || []).filter((g) => !g.sent).length, unsent1)
  assert.match(missed?.ack || '', /did not send that to the factory/)

  orchMode = 'tell'
  const gen2 = factoryGen(activeId)
  const warmAtTell = warms.length
  await conduct(activeId, 'add a footer credit to this run')
  await until(() => prompts.some((p) => p.includes('footer credit')), 'footer brief')
  assert.ok(factoryGen(activeId) > gen2)
  assert.ok(promptCalls.some((c) => c.tabId === runOf().acpTab && c.text.includes('footer credit')))
  assert.equal((runOf().guide || []).some((g) => (g.ack || '').includes('FACTORY_TELL') || g.text.includes('FACTORY_TELL')), false)
  assert.equal(warms.length, warmAtTell)
  await conduct(activeId, PAUSE)
  await settle(activeId)
  assert.equal(runOf().phase, 'paused')
  orchMode = 'tell'
  const gen3 = factoryGen(activeId)
  const built3 = prompts.length
  await conduct(activeId, 'please change the credit line')
  const queued = (runOf().guide || []).filter((g) => g.text === 'add a footer credit' && !g.sent)
  assert.equal(queued.length, 1)
  assert.equal(runOf().phase, 'paused')
  assert.equal(factoryGen(activeId), gen3)
  assert.equal(prompts.length, built3)

  orchMode = 'tell-anyway'
  const gen4 = factoryGen(activeId)
  const built4 = prompts.length
  const unsent4 = (runOf().guide || []).filter((g) => !g.sent).length
  await conduct(activeId, 'how is this factory run going?')
  assert.equal(factoryGen(activeId), gen4)
  assert.equal(prompts.length, built4)
  assert.equal((runOf().guide || []).filter((g) => !g.sent).length, unsent4)

  orchMode = 'throw'
  const orchBefore = promptCalls.filter((c) => c.tabId.endsWith('-orch')).length
  await conduct(activeId, PAUSE)
  await conduct(activeId, REVIEW_GO)
  await conduct(activeId, VOICE_GO)
  await conduct(activeId, TIER_GO)
  await conduct(activeId, PROCEED_GO)
  await conduct(activeId, STOP)
  await conduct(activeId, SHIP)
  assert.equal(runOf().phase, 'paused')
  await conduct(activeId, APPROVE)
  assert.equal(runOf().phase, 'paused')
  const soffit = await conduct(activeId, 'we forgot the soffit, add this to the plan')
  const soffitNote = (soffit.guide || []).find((g) => g.text.includes('soffit'))
  assert.equal(soffit.phase, 'paused')
  assert.equal(soffitNote?.sent, false)
  assert.match(soffitNote?.ack || '', /Filed with the plan/)
  await conduct(activeId, RESUME)
  assert.equal(promptCalls.filter((c) => c.tabId.endsWith('-orch')).length, orchBefore)
  await settle(activeId)
})
