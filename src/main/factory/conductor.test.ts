import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACK_NOTED, holdOf, REVIEW_MAX, VOICE_MAX, type RunEvent, type RunRecord } from '../../shared/factory.ts'
import { buildBrief } from './brief.ts'
import type { Decision, FactoryDeps, StartResult } from './controller.ts'
import type { SpawnFn } from './opus.ts'
import { planPrompt, strictPrompt } from './opus.ts'
import type { ProfilePatch } from './profile.ts'
import { askRoute, factorySessionRules } from './gates.ts'
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
let startRun: (input: { task: string; workRepo: string; brainPath: string; proceedCritical?: boolean }) => StartResult
let abandonRun: (id: string) => RunRecord
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
  assert.match(pane, /placeholder="Talk to the team: ask, redirect, add something, or say go"/)
  assert.equal(pane.includes('placeholder="Guide this run"'), false)
  // Layout A: the run view is the team thread; the raw tool box and the phase pills are gone.
  const runView = pane.slice(pane.indexOf('const items = threadItems(run, pending)'))
  assert.match(runView, /<FactoryThread items=\{items\} \/>/)
  for (const gone of ['className="factory-activity"', 'className="phaserail"', 'factory-guide', 'factory-verify']) assert.equal(pane.includes(gone), false, gone)
  assert.match(pane, /onActivityRef\.current\(id, run \? factoryActivity\(run, pushBlock\) : null\)/)
  assert.match(pane, /e\.key === 'Enter' && !e\.shiftKey/)
  // The intake view (before Start) is unchanged.
  const intake = pane.slice(pane.indexOf('if (!run) {'), pane.indexOf('const live = run.phase'))
  for (const kept of ['What should change?', 'Approve in advance (plan, asks, and a clean Commit go ahead; never deploys)', 'Ship in advance: after an Opus review', '>\n                Start\n']) assert.ok(intake.includes(kept), kept)
  // The right rail: a Factory tab with a run shows ActivityRail; everything else keeps In use.
  const ws = readFileSync(join(root, 'src/renderer/src/TerminalWorkspace.tsx'), 'utf8')
  assert.match(ws, /const railActivity = railFor\(tab, lastChatId, activityByTab\)/)
  assert.match(ws, /\{railActivity \? \(\s*<ActivityRail\s+activity=\{railActivity\}/)
  assert.match(ws, /<h2>In use<\/h2>/)
  assert.match(ws, /onActivity=\{onActivity\}/)
  assert.ok(send.indexOf('showOutgoing(') < send.indexOf('factory.conduct('))
  const guideAt = pane.indexOf("e.kind === 'guide'")
  const streamAt = pane.indexOf("e.kind !== 'stream'")
  assert.ok(guideAt > 0 && streamAt > guideAt)
  assert.equal(pane.slice(guideAt, streamAt).includes('setActivity'), false)
  assert.match(pane.slice(guideAt, streamAt), /raw: p\.raw/)
  const route = (watchOnly: boolean, kind: string, runThrough: boolean) => askRoute({ watchOnly, kind, filtered: 'ask', runThrough, fast: false })
  assert.equal(route(true, 'read', false), 'allow')
  assert.equal(route(true, 'edit', true), 'reject')
  assert.equal(route(false, 'edit', false), 'card')
  assert.equal(route(false, 'edit', true), 'allow')
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
let orchReply: string | null = null
let buildThrows = false
let stampOff = false
let orchHeld: (() => void)[] | null = null
const orchPending = new Map<string, (raw: string) => void>()
let cancels = 0
let pubs: { allow?: boolean }[] = []
let publishAllow: boolean | undefined
let deploys = 0
let opusSeen: string[][] = []
let opusCwd: string[] = []
let planQueue: string[] = []
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
  if (!activeId || stampOff) return
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
  if (orchReply !== null) return orchReply
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
      if (tabId.endsWith('-orch')) {
        // Real ACP cancels the turn still running on this tab when a new prompt arrives (acp-session.ts).
        orchPending.get(tabId)?.('')
        if (!orchHeld) return orchAnswer(text)
        const held = orchHeld
        return new Promise<string>((done) => {
          const finish = (raw: string) => {
            if (orchPending.get(tabId) === finish) orchPending.delete(tabId)
            done(raw)
          }
          orchPending.set(tabId, finish)
          held.push(() => finish(orchAnswer(text)))
        })
      }
      prompts.push(text)
      if (buildThrows) throw new Error('builder crashed')
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
  spawnOpus: ((_bin: string, args: string[], opts?: { cwd?: string }) => {
    opusSeen.push(args)
    opusCwd.push(String(opts?.cwd || ''))
    trace.push('opus')
    const prompt = String(args[args.indexOf('-p') + 1] || '')
    const effortAt = args.indexOf('--effort')
    const effort = effortAt >= 0 ? args[effortAt + 1] : ''
    // Strict review is effort low. A review-cap fix is an Opus build (medium, bypassPermissions)
    // and must not use up the one allowed strict fail. Kennel's gate is medium and follows opusPass.
    let result = 'GAPS: 0\nPASS'
    // A planner that follows the prompt ends with its verdict; queued answers stand in for other planners.
    if (prompt.includes('Write the implementation plan')) result = planQueue.length ? String(planQueue.shift()) : 'Files: src.ts\nCheck: the route answers.\nPLAN: READY\n'
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
  orchReply = null
  buildThrows = false
  stampOff = false
  orchHeld = null
  orchPending.clear()
  cancels = 0
  pubs = []
  publishAllow = undefined
  deploys = 0
  opusSeen = []
  opusCwd = []
  planQueue = []
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
  abandonRun = mods.controller.abandonRun
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
  assert.equal(editNote?.ack, `${replyFromCard(lastPrompt)} I did not send that to the factory.`)
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

test('Joe 2026-10-06 run-ae98e1f8: the conductor restarts in the right repo when Joe says so', async () => {
  const mods = await loaded
  conduct = mods.conductor.conduct
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  factoryGen = mods.controller.factoryGen
  dropMemory = mods.controller.dropMemory
  abandonRun = mods.controller.abandonRun
  mods.store.setUserDataDir(() => userData)
  const lotProjects = join(temp, 'lot-projects')
  mkdirSync(lotProjects, { recursive: true })
  const folder = (name: string, files: Record<string, string>): string => {
    const dir = join(lotProjects, name)
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'init'])
    return realpathSync(dir)
  }
  const intake = folder('360-seo-intake', { 'src.ts': 'export const n = 1\n' })
  const lot = folder('lotline', { 'README.md': '# LotOffice\n', 'src.ts': 'export const n = 1\n' })
  const yard = folder('dirty-yard', { 'src.ts': 'export const n = 1\n' })
  const brain = repo('lot-brain')
  configureFactory({ ...deps, projectsDir: lotProjects })
  const task = readFileSync(join(dirname(here), 'testdata/run-ae98e1f8-task.txt'), 'utf8')
  const ackOf = (id: string, text: string) => ([...(getRun(id)?.guide || [])].reverse().find((g) => g.text === text)?.ack || '')
  const orchCalls = () => promptCalls.filter((c) => c.tabId.endsWith('-orch')).length
  const lastOrch = () => [...promptCalls].reverse().find((c) => c.tabId.endsWith('-orch'))?.text || ''
  const start = (t: string, workRepo: string): string => {
    const res = startRun({ task: t, workRepo, brainPath: brain, proceedCritical: true })
    if (!res.ok) throw new Error(res.error)
    activeId = res.run.id
    return res.run.id
  }

  reset()
  hang = true
  holdTriage = true
  const one = start(task, intake)
  await until(() => triageOpen() && runOf().phase === 'triage', 'incident triage')
  await conduct(one, PAUSE)
  assert.equal(getRun(one)?.phase, 'paused')
  const why = 'why is it working in the 360seo intake project?'
  await conduct(one, why)
  assert.equal(getRun(one)?.phase, 'paused')
  assert.equal(getRun(one)?.workRepo, intake)
  const card = lastOrch()
  assert.ok(card.includes(`workRepo: ${intake}`), 'card names the work repo')
  assert.ok(card.includes(`taskRepo: ${lot}`), 'card names the repo the task names')
  assert.match(card, /^shipThrough: /m)
  assert.ok(card.includes(JSON.stringify(task.slice(0, 200)).slice(0, -1)), 'card carries the task')
  assert.ok(card.includes('Do not run commands or open files'))
  assert.ok(card.includes('Never say a push will not deploy'))
  orchReply = 'Moving it.\nFACTORY_TELL: use the lotoffice project'
  const should = 'it should be in the lotoffice project and it needs to do what i asked in that repo.'
  await conduct(one, should)
  orchReply = null
  const filed = (getRun(one)?.guide || []).find((g) => g.text === 'use the lotoffice project')
  assert.equal(filed?.sent, false)
  assert.equal(filed?.repo, lot)
  assert.match(filed?.ack || '', /Filed with the plan/)
  assert.equal((filed?.ack || '').includes('did not send'), false)
  assert.equal(getRun(one)?.phase, 'paused')
  const restarted = 'get the run restarted in the correct repo'
  await conduct(one, restarted)
  assert.equal(getRun(one)?.workRepo, lot)
  assert.notEqual(getRun(one)?.phase, 'paused')
  assert.ok(ackOf(one, restarted).includes(lot), ackOf(one, restarted))
  holdTriage = false
  fireTriage()
  abandonRun(one)

  reset()
  hang = true
  const two = start('fix typo in footer', intake)
  await until(() => runOf().phase === 'build' && prompts.length > 0, 'run 2 build')
  await conduct(two, PAUSE)
  await conduct(two, 'Resume this run')
  assert.notEqual(getRun(two)?.phase, 'paused')
  await conduct(two, PAUSE)
  const unpause = 'unpause the blasted run and have it use the right repo'
  await conduct(two, unpause)
  assert.notEqual(getRun(two)?.phase, 'paused')
  assert.equal(getRun(two)?.workRepo, intake)
  assert.equal(ackOf(two, unpause).includes('Resumed'), true, ackOf(two, unpause))
  await conduct(two, PAUSE)
  await conduct(two, 'so get it started for petes sake')
  assert.notEqual(getRun(two)?.phase, 'paused')

  const gen = factoryGen(two)
  const phase = getRun(two)?.phase
  const asked = orchCalls()
  await conduct(two, 'can you restart it?')
  assert.equal(orchCalls(), asked + 1)
  assert.equal(getRun(two)?.phase, phase)
  assert.equal(factoryGen(two), gen)
  await conduct(two, 'stop adding the footer')
  assert.equal(orchCalls(), asked + 2)
  assert.equal(getRun(two)?.override?.review, undefined)
  orchReply = 'Telling the builder.\nFACTORY_TELL: keep the footer text short'
  await conduct(two, 'the footer should stay short')
  orchReply = null
  await until(() => prompts.some((p) => p.includes('keep the footer text short')), 'tell reached the builder')
  orchMode = 'empty'
  await conduct(two, 'the header is wrong')
  orchMode = 'card'
  assert.ok(ackOf(two, 'the header is wrong').startsWith('I could not get an answer, so nothing was sent to the run.'), ackOf(two, 'the header is wrong'))

  const LANE = 'Two reviews so far.'
  orchReply = LANE
  orchHeld = []
  const before = orchCalls()
  const first = conduct(two, 'how many reviews so far?')
  const second = conduct(two, 'what phase is it in?')
  await until(() => orchCalls() === before + 1, 'first answer asked')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(orchCalls(), before + 1, 'the second question waits for the first answer')
  orchHeld.shift()?.()
  await until(() => orchCalls() === before + 2 && (orchHeld?.length || 0) === 1, 'second answer asked')
  orchHeld.shift()?.()
  await Promise.all([first, second])
  for (const q of ['how many reviews so far?', 'what phase is it in?']) assert.equal(ackOf(two, q), LANE, q)
  const held = conduct(two, 'what is it doing now?')
  await until(() => (orchHeld?.length || 0) === 1, 'held answer')
  await conduct(two, PAUSE)
  assert.equal(getRun(two)?.phase, 'paused')
  orchHeld.shift()?.()
  await held
  orchHeld = null
  orchReply = null
  orchMode = 'throw'
  await conduct(two, 'how far along is it?')
  orchMode = 'card'
  orchReply = LANE
  await conduct(two, 'how far along now?')
  orchReply = null
  assert.equal(ackOf(two, 'how far along now?'), LANE)

  const three = start('fix typo in footer', lot)
  const throwOut = 'so throw it all out and then restart in the lotline repo for crying out loud'
  await conduct(two, throwOut)
  assert.match(ackOf(two, throwOut), /already running/)
  assert.equal(ackOf(two, throwOut).includes('Resumed'), false)
  assert.equal(getRun(two)?.workRepo, intake)
  assert.equal(getRun(two)?.phase, 'paused')
  abandonRun(three)
  const titled = 'restart it in the lotoffice project'
  await conduct(two, titled)
  assert.equal(getRun(two)?.workRepo, lot)
  assert.notEqual(getRun(two)?.phase, 'paused')
  abandonRun(two)

  const four = start('fix typo in footer', intake)
  await until(() => runOf().phase === 'build', 'run 4 build')
  await conduct(four, PAUSE)
  await conduct(four, throwOut)
  assert.equal(getRun(four)?.workRepo, lot)
  assert.notEqual(getRun(four)?.phase, 'paused')
  abandonRun(four)

  writeFileSync(join(yard, 'wip.txt'), 'not committed\n')
  holdTriage = true
  const five = start('fix typo in footer', intake)
  await until(() => triageOpen() && runOf().phase === 'triage', 'run 5 triage')
  await conduct(five, PAUSE)
  const dirty = 'restart it in dirty-yard'
  await conduct(five, dirty)
  assert.equal(getRun(five)?.workRepo, yard)
  assert.equal(getRun(five)?.needsPrep, 'dirty')
  assert.match(ackOf(five, dirty), /Commit first|Stash first/)
  assert.equal(ackOf(five, dirty).includes('Resumed'), false)
  holdTriage = false
  fireTriage()
  abandonRun(five)

  reset()
  buildThrows = true
  const six = start('fix typo in footer', intake)
  await until(() => runOf().phase === 'failed', 'run 6 failed')
  buildThrows = false
  hang = true
  const seven = start('fix typo in footer', lot)
  await until(() => runOf().phase === 'build', 'run 7 build')
  const failedAsk = 'restart it in the lotline repo'
  await conduct(six, failedAsk)
  assert.match(ackOf(six, failedAsk), /already running/)
  assert.equal(ackOf(six, failedAsk).includes('Resumed'), false)
  assert.equal(getRun(six)?.workRepo, intake)
  abandonRun(seven)
  abandonRun(six)

  reset()
  hang = true
  raiseCritical = true
  const eight = start('fix typo in footer', intake)
  await until(() => runOf().phase === 'triage' && !!runOf().needsProceed, 'run 8 proceed hold')
  await conduct(eight, PAUSE)
  const proceedAsk = 'restart it in the lotline repo'
  await conduct(eight, proceedAsk)
  assert.equal(getRun(eight)?.workRepo, lot)
  assert.ok(ackOf(eight, proceedAsk).includes(lot), ackOf(eight, proceedAsk))
  assert.equal(ackOf(eight, proceedAsk).includes('Resumed'), false)
  abandonRun(eight)
  configureFactory(deps)
})

test('holdOf agrees with holdName and names the other holds', async () => {
  const mods = await loaded
  const holdName = mods.controller.holdName
  const base: RunRecord = {
    id: 'h',
    title: 't',
    task: 't',
    brainPath: '/b',
    workRepo: '/w',
    tier: 'T2',
    risk: 'none',
    triage: { size: 'T2', original: 'T2', capped: false, reasons: [] },
    phase: 'build',
    base: 'x',
    acpTab: 'a',
    createdAt: 0,
    updatedAt: 0
  }
  const cases: [string, Partial<RunRecord>, string | null, string][] = [
    ['review cap', { phase: 'review', diff: 'd', strict: { status: 'fail', text: 'g' }, reviewCycles: REVIEW_MAX }, 'review', 'review'],
    ['voice cap', { voice: { script: 'voice', status: 'fail' }, voiceCycles: VOICE_MAX }, 'voice', 'voice'],
    ['upgrade', { phase: 'upgrade', tripwire: { reasons: ['too big'], suggest: 'T3' } }, 'tier', 'tier'],
    ['proceed', { phase: 'triage', needsProceed: true }, 'proceed', 'proceed'],
    ['dirty', { phase: 'triage', needsPrep: 'dirty', dirtyCount: 3 }, 'dirty', 'none'],
    ['plan waiting', { phase: 'plan', plan: { text: 'p', by: 'opus', status: 'waiting', rejects: 0, reasons: [] } }, 'plan', 'none'],
    ['plan approved in advance', { phase: 'plan', runThrough: true, plan: { text: 'p', by: 'opus', status: 'waiting', rejects: 0, reasons: [] } }, null, 'none'],
    ['paused', { phase: 'paused', error: 'This turn changed no files in /w.' }, 'paused', 'none'],
    ['failed', { phase: 'failed', error: 'boom' }, 'failed', 'none'],
    ['strict fail under the cap', { phase: 'review', diff: 'd', strict: { status: 'fail', text: 'g' }, reviewCycles: 1 }, null, 'none']
  ]
  for (const [name, patch, kind, legacy] of cases) {
    const run = { ...base, ...patch }
    assert.equal(holdOf(run)?.kind ?? null, kind, name)
    assert.equal(holdName(run), legacy, name)
  }
  assert.equal(holdOf({ ...base, phase: 'paused', error: 'This turn changed no files in /w.' })?.text, 'This turn changed no files in /w.')
})

test('a run keeps a timeline of what the team did', async () => {
  const mods = await loaded
  conduct = mods.conductor.conduct
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  decideRun = mods.controller.decideRun
  dropMemory = mods.controller.dropMemory
  abandonRun = mods.controller.abandonRun
  mods.store.setUserDataDir(() => userData)
  configureFactory(deps)
  const commonDir = (dir: string) => git(dir, ['rev-parse', '--git-common-dir']).trim()
  const codeJson = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, commonDir(dir), 'brain-factory', id, 'code.json'), 'utf8')) as { events?: RunEvent[] }
  const metaJson = (id: string) => JSON.parse(readFileSync(join(userData, 'factory', 'runs', `${id}.json`), 'utf8')) as RunRecord
  const begin = (task: string, workRepo: string, o: { shipThrough?: boolean } = {}): string => {
    const res = (startRun as unknown as (i: object) => StartResult)({ task, workRepo, brainPath: repo(`${baseName(workRepo)}-brain`), ...o })
    if (!res.ok) throw new Error(res.error)
    activeId = res.run.id
    return res.run.id
  }
  const baseName = (p: string) => p.split('/').pop() || p

  reset()
  failsLeft = 1
  opusPass = false
  const one = repo('events-one')
  addRemote(one)
  let turnNo = 0
  touch = () => {
    turnNo++
    writeFileSync(join(one, turnNo === 1 ? 'src.ts' : 'fix.ts'), `export const turn = ${turnNo}\n`)
  }
  const id1 = begin('add a webhook endpoint feature', one, { shipThrough: true })
  await until(() => runOf().phase === 'plan' && runOf().plan?.status === 'waiting' && !!runOf().plan?.text, 'events plan')
  decideRun(id1, 'approve-plan')
  await until(() => runOf().phase === 'done' && !!runOf().pushed, 'events pushed')
  const ev = getRun(id1)?.events || []
  writeFileSync('/tmp/factory-fix/u2/events.json', JSON.stringify(ev, null, 2))
  const label = (e: RunEvent) =>
    e.kind === 'plan' ? `plan(${e.status})` : e.kind === 'review' ? `review(${e.status},${e.round})` : e.kind === 'hold' ? `hold(${e.hold})` : e.kind === 'end' ? `end(${e.phase})` : e.kind === 'push' ? `push(${e.ok ? 'ok' : 'fail'})` : e.kind
  assert.deepEqual(ev.map(label), ['repo', 'plan(waiting)', 'hold(plan)', 'plan(approved)', 'turn', 'test', 'review(fail,1)', 'turn', 'test', 'review(pass,2)', 'commit', 'end(done)', 'push(ok)'])
  const turns = ev.filter((e): e is Extract<RunEvent, { kind: 'turn' }> => e.kind === 'turn')
  assert.ok(turns[0].paths.includes('src.ts') && !turns[0].paths.includes('fix.ts'), JSON.stringify(turns[0].paths))
  assert.ok(turns[1].paths.includes('src.ts') && turns[1].paths.includes('fix.ts') && turns[1].files >= 2, JSON.stringify(turns[1].paths))
  const buildAts = (getRun(id1)?.usage || []).filter((u) => u.phase === 'build').map((u) => u.at)
  assert.notEqual(turns[0].call, turns[1].call)
  assert.ok(turns.every((t) => buildAts.includes(t.call)))
  const reviews = ev.filter((e): e is Extract<RunEvent, { kind: 'review' }> => e.kind === 'review')
  assert.match(reviews[0].text, /GAPS: 1/)
  assert.match(reviews[1].text, /GAPS: 0/)
  const plan = ev.find((e): e is Extract<RunEvent, { kind: 'plan' }> => e.kind === 'plan')
  assert.match(plan?.text || '', /Files: src\.ts/)
  const onDisk = metaJson(id1).events || []
  assert.equal(onDisk.length, ev.length)
  assert.ok(onDisk.every((e) => !('text' in e) || e.text === ''), 'userData events carry no text')
  const inRepo = codeJson(one, id1).events || []
  assert.deepEqual(inRepo, ev)
  dropMemory()
  const back = mods.controller.restoreRun(id1)
  assert.deepEqual(back?.events, ev)

  reset()
  const two = repo('events-two')
  writeFileSync(join(two, 'package.json'), JSON.stringify({ name: 'events-two', scripts: { typecheck: 'tsc --noEmit' } }))
  git(two, ['add', '-A'])
  git(two, ['commit', '-q', '-m', 'scripts'])
  let scriptCalls = 0
  configureFactory({ ...deps, runScript: async () => (++scriptCalls === 1 ? { code: 1, out: 'boom in src.ts' } : { code: 0, out: 'ok' }) })
  touch = () => writeFileSync(join(two, 'src.ts'), 'export const n = 22\n')
  const id2 = begin('fix typo in footer', two)
  await until(() => (getRun(id2)?.events || []).some((e) => e.kind === 'test' && e.rows.some((r) => r.status === 'fail')), 'events test fail')
  const failed = (getRun(id2)?.events || []).find((e): e is Extract<RunEvent, { kind: 'test' }> => e.kind === 'test' && e.rows.some((r) => r.status === 'fail'))!
  assert.match(failed.rows.find((r) => r.status === 'fail')?.tail || '', /boom in src\.ts/)
  const repoFail = (codeJson(two, id2).events || []).find((e): e is Extract<RunEvent, { kind: 'test' }> => e.kind === 'test' && e.rows.some((r) => r.status === 'fail'))
  assert.match(repoFail?.rows.find((r) => r.status === 'fail')?.tail || '', /boom in src\.ts/)
  assert.equal(JSON.stringify(metaJson(id2)).includes('boom in src.ts'), false)
  abandonRun(id2)
  configureFactory(deps)

  reset()
  const three = repo('events-three')
  writeFileSync(join(three, 'scratch.txt'), 'not committed\n')
  stampOff = true
  const id3 = begin('fix typo in footer', three)
  await until(() => getRun(id3)?.needsPrep === 'dirty', 'events dirty')
  decideRun(id3, 'prep-stash')
  await until(() => getRun(id3)?.phase === 'paused' && /changed no files/.test(getRun(id3)?.error || ''), 'events empty pause')
  assert.equal(getRun(id3)?.audit?.work.length, 0, 'the builder wrote nothing')
  const lot = join(projects, 'lotline')
  if (!existsSync(join(lot, '.git'))) {
    mkdirSync(lot, { recursive: true })
    git(lot, ['init', '-q', '-b', 'main'])
    writeFileSync(join(lot, 'src.ts'), 'export const n = 1\n')
    git(lot, ['add', '-A'])
    git(lot, ['commit', '-q', '-m', 'init'])
  }
  hang = true
  stampOff = false
  const id4 = begin('fix typo in footer', lot)
  await until(() => getRun(id4)?.phase === 'build', 'events lock holder')
  await conduct(id3, 'restart it in the lotline repo')
  assert.equal(getRun(id3)?.phase, 'paused')
  const holds = (getRun(id3)?.events || []).filter((e): e is Extract<RunEvent, { kind: 'hold' }> => e.kind === 'hold')
  assert.deepEqual(holds.map((h) => h.hold), ['dirty', 'paused', 'paused'])
  assert.match(holds[1].text, /changed no files/)
  assert.match(holds[2].text, /already running/)
  abandonRun(id4)
  abandonRun(id3)
})

test('the Lead acts: planner verdicts, a planner move, and re-plans after a move', async () => {
  const mods = await loaded
  const { planVerdict } = await import('./opus.ts')
  const { parseSlices } = await import('./slices.ts')
  const { threadItems } = await import('../../renderer/src/factory-thread.ts')
  conduct = mods.conductor.conduct
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  decideRun = mods.controller.decideRun
  dropMemory = mods.controller.dropMemory
  abandonRun = mods.controller.abandonRun
  mods.store.setUserDataDir(() => userData)
  const lp = join(temp, 'lead-projects')
  mkdirSync(lp, { recursive: true })
  const folder = (name: string, files: Record<string, string>): string => {
    const dir = join(lp, name)
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'init'])
    return realpathSync(dir)
  }
  const intake = folder('360-seo-intake', { 'src.ts': 'export const n = 1\n' })
  const lot = folder('lotline', { 'README.md': '# LotOffice\n', 'src.ts': 'export const n = 1\n' })
  const plain = join(lp, 'plain-folder')
  mkdirSync(plain, { recursive: true })
  const brain = repo('lead-brain')
  configureFactory({ ...deps, projectsDir: lp })
  const refusal =
    "I couldn't plan any edits because the work repo you gave me is the wrong one. `" + intake + '` contains only `index.html`.\nThe Lot Office code is in the sibling repo `' + lot + '`.'
  const blocked = (repoLine?: string) => `${refusal}\n${repoLine ? `REPO: ${repoLine}\n` : ''}PLAN: BLOCKED`
  const ready = 'Files: src.ts\nCheck: the webhook answers.\nPLAN: READY'
  const begin = (task: string, workRepo: string | undefined, o: { runThrough?: boolean } = {}): string => {
    const res = (startRun as unknown as (i: object) => StartResult)({ task, ...(workRepo ? { workRepo } : {}), brainPath: brain, proceedCritical: true, ...o })
    if (!res.ok) throw new Error(res.error)
    activeId = res.run.id
    return res.run.id
  }
  const plannerCalls = () => opusSeen.filter((a) => String(a[a.indexOf('-p') + 1] || '').includes('Write the implementation plan'))
  const plannerCwds = () => opusSeen.map((a, i) => (String(a[a.indexOf('-p') + 1] || '').includes('Write the implementation plan') ? opusCwd[i] : '')).filter(Boolean)
  const statuses = (id: string) => (getRun(id)?.events || []).flatMap((e) => (e.kind === 'plan' ? [`plan:${e.status}`] : e.kind === 'repo' && e.moved ? [`repo:moved${e.planner ? ':planner' : ''}`] : []))

  // (i) the prompt asks for the verdict.
  const t2p = planPrompt({ task: 't', workRepo: '/x', plans: [], reasons: [], tier: 'T2' })
  assert.ok(t2p.includes('PLAN: READY') && t2p.includes('REPO: <absolute path>') && t2p.includes('PLAN: BLOCKED'), 'T2 prompt asks for the verdict')
  const t3p = planPrompt({ task: 't', workRepo: '/x', plans: [], reasons: [], tier: 'T3' })
  assert.match(t3p, /PLAN: READY, after the slices JSON line/)

  // (g) a T3 plan with the slices line then PLAN: READY still parses its slices.
  const t3text = 'Steps.\n{"slices":[{"title":"a","files":["a.ts"]},{"title":"b","files":["b.ts"]}]}\nPLAN: READY'
  const v = planVerdict(t3text)
  assert.equal(v.verdict, 'ready')
  assert.deepEqual(parseSlices(v.body).map((x) => x.title), ['a', 'b'])

  // (a) the REPO-line move.
  reset()
  hang = true
  planQueue = [blocked(lot), ready]
  const a = begin('add a webhook endpoint feature', intake, { runThrough: true })
  assert.equal(getRun(a)?.tier, 'T2')
  await until(() => plannerCalls().length >= 1, 'planner 1 ran')
  await until(() => prompts.length > 0, 'builder after the second plan')
  assert.equal(plannerCwds()[0], intake)
  assert.equal(plannerCwds()[1], lot)
  assert.equal(getRun(a)?.workRepo, lot)
  assert.deepEqual(statuses(a), ['plan:blocked', 'repo:moved:planner', 'plan:waiting', 'plan:approved'])
  const planPath = (/Approved plan: (\S+)\. Read it first\./.exec(prompts[0]) || [])[1] || ''
  assert.ok(planPath, 'the brief names the plan file')
  const onDisk = readFileSync(planPath, 'utf8')
  assert.ok(onDisk.includes('Check: the webhook answers.') && !onDisk.includes("couldn't plan"), onDisk)
  assert.equal(/PLAN:|REPO:/.test(getRun(a)?.plan?.text || ''), false)
  assert.equal((getRun(a)?.events || []).some((e) => e.kind === 'plan' && /PLAN:|REPO:/.test(e.text)), false)
  assert.equal(getRun(a)?.guide?.length || 0, 0)
  const items = threadItems(getRun(a)!, null)
  assert.equal(items.some((it) => it.role === 'joe'), false)
  assert.ok(items.some((it) => it.role === 'lead' && it.text.includes('The planner said the code is there.')))
  abandonRun(a)

  // (a2) no ping-pong.
  reset()
  hang = true
  planQueue = [blocked(lot), blocked(intake)]
  const a2 = begin('add a webhook endpoint feature', intake, { runThrough: true })
  await until(() => getRun(a2)?.plan?.status === 'blocked' && plannerCalls().length === 2, 'second planner blocked')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getRun(a2)?.workRepo, lot)
  assert.equal(plannerCalls().length, 2)
  assert.equal(prompts.length, 0)
  abandonRun(a2)

  // (b) blocked in place: never approved, Re-plan carries the reason.
  reset()
  hang = true
  planQueue = [blocked()]
  const b = begin('add a webhook endpoint feature', intake, { runThrough: true })
  await until(() => getRun(b)?.plan?.status === 'blocked', 'blocked plan')
  assert.equal(holdOf(getRun(b)!)?.text, 'The planner could not plan here.')
  const before = JSON.stringify(getRun(b)?.plan)
  assert.throws(() => decideRun(b, 'approve-plan'), /could not plan here/)
  assert.equal(JSON.stringify(getRun(b)?.plan), before)
  await conduct(b, 'Approve the plan.')
  const door = [...(getRun(b)?.guide || [])].reverse().find((g) => g.text === 'Approve the plan.')
  assert.match(door?.ack || '', /could not plan here/)
  assert.notEqual(door?.ack, 'Approving the plan.')
  ;(decideRun as unknown as (id: string, c: string, o: { reason: string }) => RunRecord)(b, 'reject-plan', { reason: 'try again' })
  await until(() => plannerCalls().length === 2, 'planner 2 after Re-plan')
  assert.match(String(plannerCalls()[1][plannerCalls()[1].indexOf('-p') + 1]), /try again/)
  assert.equal(prompts.length, 0)
  abandonRun(b)

  // (c) no verdict with Approve in advance: it waits, says why, and builds on Approve.
  reset()
  hang = true
  planQueue = ['Files: a.ts\nCheck: it works.']
  const c = begin('add a webhook endpoint feature', intake, { runThrough: true })
  await until(() => getRun(c)?.plan?.status === 'waiting' && !!getRun(c)?.plan?.text, 'plan without a verdict')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getRun(c)?.plan?.unready, true)
  assert.equal(prompts.length, 0)
  const notReady = 'The planner did not say the plan is ready. Read it, then approve or re-plan.'
  assert.equal(holdOf(getRun(c)!)?.text, notReady)
  assert.ok((getRun(c)?.events || []).some((e) => e.kind === 'hold' && e.text === notReady))
  decideRun(c, 'approve-plan')
  await until(() => prompts.length > 0, 'build after approve')
  abandonRun(c)

  // (d) READY with Approve in advance builds with no click.
  reset()
  hang = true
  const d = begin('add a webhook endpoint feature', intake, { runThrough: true })
  await until(() => prompts.length > 0, 'ready plan built in advance')
  abandonRun(d)

  // (e) a REPO line that must not move the run.
  for (const [label, target] of [['brain', brain], ['missing', '/nonexistent/lotline'], ['current', intake], ['not git', plain]] as const) {
    reset()
    hang = true
    planQueue = [blocked(target)]
    const e = begin('add a webhook endpoint feature', intake, { runThrough: true })
    await until(() => getRun(e)?.plan?.status === 'blocked', `blocked (${label})`)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(getRun(e)?.workRepo, intake, label)
    assert.equal(plannerCalls().length, 1, label)
    abandonRun(e)
  }

  // (f) a T2 move before any build plans again in the new repo; after building it keeps its plan.
  reset()
  hang = true
  const f = begin('add a webhook endpoint feature', intake)
  await until(() => getRun(f)?.plan?.status === 'waiting' && !!getRun(f)?.plan?.text, 'f plan')
  decideRun(f, 'approve-plan')
  await until(() => prompts.length > 0, 'f build started')
  await conduct(f, PAUSE)
  const builtBefore = prompts.length
  await conduct(f, 'restart it in the lotline repo')
  await until(() => plannerCalls().length === 2, 'f re-plan')
  assert.equal(plannerCwds()[1], lot)
  await until(() => getRun(f)?.plan?.status === 'waiting' && !!getRun(f)?.plan?.text, 'f new plan waiting')
  assert.equal(getRun(f)?.workRepo, lot)
  assert.equal(prompts.length, builtBefore)
  abandonRun(f)

  reset()
  touch = () => writeFileSync(join(intake, 'src.ts'), 'export const n = 7\n')
  const f2 = begin('add a webhook endpoint feature', intake)
  await until(() => getRun(f2)?.plan?.status === 'waiting' && !!getRun(f2)?.plan?.text, 'f2 plan')
  decideRun(f2, 'approve-plan')
  await until(() => getRun(f2)?.phase === 'review' && !!getRun(f2)?.diff, 'f2 reviewed diff')
  await conduct(f2, PAUSE)
  const planners = plannerCalls().length
  await conduct(f2, 'restart it in the lotline repo')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(plannerCalls().length, planners, 'a run that changed files keeps its plan')
  assert.equal(getRun(f2)?.plan?.status, 'approved')
  abandonRun(f2)
  git(intake, ['checkout', '--', '.'])

  // (f3) a T3 move before any build drops its slices and plans again.
  reset()
  hang = true
  planQueue = ['Steps.\n{"slices":[{"title":"a","files":["a.ts"]},{"title":"b","files":["b.ts"]}]}\nPLAN: READY']
  const f3 = begin('redesign the webhook feature', intake)
  assert.equal(getRun(f3)?.tier, 'T3')
  await until(() => getRun(f3)?.plan?.status === 'waiting' && !!getRun(f3)?.plan?.text, 'f3 plan')
  decideRun(f3, 'approve-plan')
  await until(() => (getRun(f3)?.slices?.length || 0) === 2 && prompts.length > 0, 'f3 slices built')
  await conduct(f3, PAUSE)
  await conduct(f3, 'restart it in the lotline repo')
  await until(() => plannerCalls().length === 2, 'f3 re-plan')
  assert.equal(plannerCwds()[1], lot)
  assert.equal(getRun(f3)?.slices, undefined)
  abandonRun(f3)

  // (j) a not-ready plan stays put through Pause and Resume with Approve in advance on.
  reset()
  hang = true
  planQueue = ['Files: a.ts\nCheck: it works.']
  const j = begin('add a webhook endpoint feature', intake, { runThrough: true })
  await until(() => getRun(j)?.plan?.unready === true, 'j not-ready plan')
  await conduct(j, PAUSE)
  await conduct(j, 'Resume this run.')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getRun(j)?.plan?.status, 'waiting')
  assert.equal(prompts.length, 0, 'Resume did not approve a not-ready plan')
  abandonRun(j)

  // (k) a redirect while a plan is on screen (no Pause) plans again in the new repo.
  reset()
  hang = true
  const k = begin('add a webhook endpoint feature', intake)
  await until(() => getRun(k)?.plan?.status === 'waiting' && !!getRun(k)?.plan?.text, 'k plan')
  mods.controller.guideRun(k, `work in ${lot} instead`)
  await until(() => plannerCalls().length === 2, 'k planner 2')
  assert.equal(plannerCwds()[1], lot)
  await until(() => getRun(k)?.plan?.status === 'waiting' && !!getRun(k)?.plan?.text, 'k plan in lotline')
  assert.equal(getRun(k)?.workRepo, lot)
  abandonRun(k)

  // (l) a blocked plan in a repo Joe's note chose: the planner's REPO line does not pull the run away.
  const other = folder('other-repo', { 'src.ts': 'export const n = 1\n' })
  reset()
  hang = true
  planQueue = [ready, blocked(lot)]
  const l = begin('add a webhook endpoint feature', intake)
  await until(() => getRun(l)?.plan?.status === 'waiting' && !!getRun(l)?.plan?.text, 'l plan 1')
  mods.controller.guideRun(l, `work in ${other}`)
  await until(() => plannerCalls().length === 2 && getRun(l)?.plan?.status === 'blocked', 'l planner 2 blocked')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getRun(l)?.workRepo, other)
  assert.equal(plannerCwds()[1], other)
  assert.equal(plannerCalls().length, 2)
  abandonRun(l)

  // (h) the first Lead line says how the repo was picked.
  reset()
  hang = true
  const joeTask = readFileSync(join(dirname(here), 'testdata/run-ae98e1f8-task.txt'), 'utf8')
  const h1 = begin(joeTask, undefined)
  assert.deepEqual(getRun(h1)?.repoFrom, { from: 'title', word: 'lotoffice' })
  assert.match(threadItems(getRun(h1)!, null)[0].text, /^Working in lotline \(.+\)\. "lotoffice" in your task is lotline's name\.$/)
  abandonRun(h1)
  const h2 = begin(`fix typo in ${join(intake, 'src.ts')}`, undefined)
  assert.match(threadItems(getRun(h2)!, null)[0].text, /You named it\.$/)
  abandonRun(h2)
  const h3 = begin('fix typo', undefined)
  assert.equal(getRun(h3)?.repoFrom?.from, 'last')
  assert.match(threadItems(getRun(h3)!, null)[0].text, /No repo was named in the task, so this is the last Factory repo\. Say the right one if it is wrong\.$/)
  abandonRun(h3)
  configureFactory(deps)
})

test('push says what it deploys: Ship in advance stops before production, previews land on factory branches', async () => {
  const mods = await loaded
  conduct = mods.conductor.conduct
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  decideRun = mods.controller.decideRun
  dropMemory = mods.controller.dropMemory
  abandonRun = mods.controller.abandonRun
  mods.store.setUserDataDir(() => userData)
  const { hostDeploy } = mods.gates
  configureFactory({ ...deps, publish: (r, t, over) => mods.gates.publish(r, t, 90_000, over) })
  const { threadItems } = await import('../../renderer/src/factory-thread.ts')
  const remoteAt = (dir: string, ref: string) => (git(dir, ['ls-remote', 'origin', `refs/heads/${ref}`]).trim().split(/\s+/)[0] || '')
  const make = (name: string, files: Record<string, string> = {}, o: { branch?: string; remote?: boolean; vercel?: boolean; emptyVercel?: boolean } = {}): string => {
    const dir = repo(name)
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body)
    if (o.vercel || o.emptyVercel) writeFileSync(join(dir, '.gitignore'), '.vercel\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'setup', '--allow-empty'])
    if (o.vercel) {
      mkdirSync(join(dir, '.vercel'), { recursive: true })
      writeFileSync(join(dir, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_test', orgId: 'team_test' }))
    }
    if (o.emptyVercel) mkdirSync(join(dir, '.vercel'), { recursive: true })
    if (o.branch) git(dir, ['checkout', '-q', '-b', o.branch])
    if (o.remote !== false) addRemote(dir)
    return realpathSync(dir)
  }
  const ship = async (dir: string, o: { ship?: boolean; runThrough?: boolean; until: (r: RunRecord) => boolean }) => {
    reset()
    opusPass = true
    let n = 0
    touch = () => writeFileSync(join(dir, 'src.ts'), `export const n = ${++n}\n`)
    const res = (startRun as unknown as (i: object) => StartResult)({ task: 'add a webhook endpoint feature', workRepo: dir, brainPath: repo(`${dir.split('/').pop()}-brain`), proceedCritical: true, shipThrough: o.ship ?? true, runThrough: o.runThrough })
    if (!res.ok) throw new Error(res.error)
    const id = res.run.id
    activeId = id
    if (!o.runThrough) {
      await until(() => getRun(id)?.plan?.status === 'waiting' && !!getRun(id)?.plan?.text, 'push plan')
      decideRun(id, 'approve-plan')
    }
    await until(() => !!getRun(id) && o.until(getRun(id)!), 'push run settled')
    return { id, run: getRun(id)!, warnAtStart: res.run.pushWarn || '' }
  }
  const done = (r: RunRecord) => r.phase === 'done' && !!r.commitSha

  // (f) the host table.
  const v = make('host-vercel', {}, { remote: false, vercel: true })
  const nt = make('host-netlify', { 'netlify.toml': '[build]\n' }, { remote: false })
  const rw = make('host-railway', { 'railway.json': '{}\n' }, { remote: false })
  for (const [dir, host] of [[v, 'Vercel'], [nt, 'Netlify'], [rw, 'Railway']] as const) {
    assert.deepEqual(hostDeploy(dir, 'main'), { host, prod: true })
    assert.deepEqual(hostDeploy(dir, 'master'), { host, prod: true })
    assert.deepEqual(hostDeploy(dir, 'feature-x'), { host, prod: false })
  }
  const vjson = make('host-vercel-json', { 'vercel.json': '{}\n' }, { remote: false })
  const vempty = make('host-vercel-empty', {}, { remote: false, emptyVercel: true })
  const vscript = make('host-vercel-script', { 'package.json': JSON.stringify({ name: 'x', scripts: { vercel: 'vercel deploy' } }) }, { remote: false })
  for (const dir of [vjson, vempty, vscript, make('host-none', {}, { remote: false })]) assert.equal(hostDeploy(dir, 'main'), null, dir)

  // (a) Vercel main with Ship in advance: committed, held, then Joe's Push lands main.
  const a = make('push-vercel', {}, { vercel: true })
  const ra = await ship(a, { until: (r) => done(r) && !!r.shipHeld })
  assert.equal(remoteAt(a, 'main'), '')
  assert.equal(ra.run.shipHeld, 'Ship in advance stopped before the push: pushing main to origin deploys production on Vercel.')
  assert.equal(ra.warnAtStart, 'Ship in advance will stop before pushing main: Vercel deploys main to production.')
  assert.equal(ra.run.deployHint?.line, 'Pushing main to origin deploys production on Vercel.')
  await mods.controller.publishRun(ra.id, { by: 'joe' })
  assert.equal(remoteAt(a, 'main'), ra.run.commitSha)

  // (b) no link: Ship in advance pushes main with no click, and says nothing about a host.
  const b = make('push-plain')
  const rb = await ship(b, { until: (r) => done(r) && !!r.pushed })
  assert.equal(remoteAt(b, 'main'), rb.run.commitSha)
  assert.equal(rb.run.deployHint, undefined)
  assert.equal(rb.run.shipHeld, undefined)
  assert.equal(/Vercel|stop/.test(rb.warnAtStart), false, rb.warnAtStart)

  // (b2) things that are not a host link do not hold Ship in advance.
  for (const [name, files, o] of [
    ['push-vercel-json', { 'vercel.json': '{}\n' }, {}],
    ['push-vercel-empty', {}, { emptyVercel: true }],
    ['push-vercel-script', { 'package.json': JSON.stringify({ name: 'x', scripts: { vercel: 'vercel deploy' } }) }, {}]
  ] as const) {
    const dir = make(name, files, o)
    const r = await ship(dir, { until: (x) => done(x) && (!!x.pushed || !!x.shipHeld) })
    assert.equal(r.run.shipHeld, undefined, name)
    assert.equal(remoteAt(dir, 'main'), r.run.commitSha, name)
  }

  // (c) Vercel on a feature branch: pushed, and the line says preview.
  const c = make('push-vercel-feature', {}, { vercel: true, branch: 'feature-x' })
  const rc = await ship(c, { until: (r) => done(r) && !!r.pushed })
  assert.equal(remoteAt(c, 'feature-x'), rc.run.commitSha)
  assert.equal(rc.run.deployHint?.line, 'Vercel builds a preview of this branch.')

  // (c2) Vercel main, Ship off, Approve in advance: committed, the production line shows, Joe's Push lands main.
  const c2 = make('push-vercel-approve', {}, { vercel: true })
  const rc2 = await ship(c2, { ship: false, runThrough: true, until: done })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getRun(rc2.id)?.pushed, undefined)
  assert.equal(remoteAt(c2, 'main'), '')
  assert.equal(getRun(rc2.id)?.deployHint?.line, 'Pushing main to origin deploys production on Vercel.')
  await mods.controller.publishRun(rc2.id, { by: 'joe' })
  assert.equal(remoteAt(c2, 'main'), rc2.run.commitSha)

  // (c3) Netlify main holds the same way.
  const c3 = make('push-netlify', { 'netlify.toml': '[build]\n' })
  const rc3 = await ship(c3, { until: (r) => done(r) && !!r.shipHeld })
  assert.match(rc3.run.shipHeld || '', /production on Netlify/)
  assert.equal(remoteAt(c3, 'main'), '')
  await mods.controller.publishRun(rc3.id, { by: 'joe' })
  assert.equal(remoteAt(c3, 'main'), rc3.run.commitSha)

  // (d) a preview after HEAD moved pushes the run's commit to factory/<id> and leaves main alone.
  const d = make('push-preview-moved', {}, { vercel: true })
  const rd = await ship(d, { until: (r) => done(r) && !!r.shipHeld })
  git(d, ['commit', '-q', '--allow-empty', '-m', 'more work'])
  const head = git(d, ['rev-parse', 'HEAD']).trim()
  const pv = await mods.controller.publishPreview(rd.id)
  assert.equal(remoteAt(d, `factory/${rd.id}`), rd.run.commitSha)
  assert.equal(git(d, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
  assert.equal(git(d, ['rev-parse', 'HEAD']).trim(), head)
  assert.equal(remoteAt(d, 'main'), '')
  assert.ok(pv.preview && !pv.pushed)
  assert.ok(threadItems(getRun(rd.id)!, null).some((it) => it.role === 'lead' && it.text === `Pushed a preview to origin/factory/${rd.id}. Vercel builds it.`))
  const refused = await mods.controller.publishRun(rd.id, { by: 'joe' })
  assert.equal(refused.pushError, 'This branch moved since Factory committed. Push from Terminal.')

  // (d2) a preview, then Joe's Push, on an unmoved HEAD.
  const d2 = make('push-preview-then-main', {}, { vercel: true })
  const rd2 = await ship(d2, { until: (r) => done(r) && !!r.shipHeld })
  await mods.controller.publishPreview(rd2.id)
  assert.equal(remoteAt(d2, `factory/${rd2.id}`), rd2.run.commitSha)
  const both = await mods.controller.publishRun(rd2.id, { by: 'joe' })
  assert.equal(remoteAt(d2, 'main'), rd2.run.commitSha)
  assert.ok(both.preview && both.pushed)
  assert.equal(git(d2, ['rev-parse', 'HEAD']).trim(), rd2.run.commitSha)

  // (e) a preview with no remote shows its error and marks nothing pushed.
  const e = make('push-preview-noremote', {}, { vercel: true, remote: false })
  const re = await ship(e, { until: (r) => done(r) && !!r.shipHeld })
  const pe = await mods.controller.publishPreview(re.id)
  assert.match(pe.previewError || '', /no remote named origin/i)
  assert.equal(pe.preview, undefined)
  assert.equal(pe.pushed, undefined)
  configureFactory(deps)
})

test('the Tester runs the repo\'s own tsc when there is no typecheck script', async () => {
  const mods = await loaded
  const { strictPrompt } = await import('./opus.ts')
  const { threadItems } = await import('../../renderer/src/factory-thread.ts')
  configureFactory = mods.controller.configureFactory
  startRun = mods.controller.startRun
  getRun = mods.controller.getRun
  decideRun = mods.controller.decideRun
  dropMemory = mods.controller.dropMemory
  abandonRun = mods.controller.abandonRun
  saveProfile = mods.profile.saveProfile
  mods.store.setUserDataDir(() => userData)
  const realTsc = join(root, 'node_modules', '.bin', 'tsc')
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', skipLibCheck: true }, include: ['*.ts'] })
  const tsRepo = (name: string, o: { tsconfig?: boolean; tsc?: boolean; files?: Record<string, string> } = {}): string => {
    const dir = repo(name)
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    if (o.tsconfig !== false) writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG)
    for (const [rel, body] of Object.entries(o.files || {})) writeFileSync(join(dir, rel), body)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'ts setup'])
    if (o.tsc !== false) {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      execFileSync('/bin/ln', ['-s', realTsc, join(dir, 'node_modules', '.bin', 'tsc')])
    }
    return realpathSync(dir)
  }
  const T1 = 'fix the nav highlight on the dealer screens'
  const begin = (task: string, workRepo: string): string => {
    const res = (startRun as unknown as (i: object) => StartResult)({ task, workRepo, brainPath: repo(`${workRepo.split('/').pop()}-brain`), proceedCritical: true })
    if (!res.ok) throw new Error(res.error)
    activeId = res.run.id
    return res.run.id
  }
  const tests = (id: string) => (getRun(id)?.events || []).filter((e): e is Extract<RunEvent, { kind: 'test' }> => e.kind === 'test')
  const BAD = "export const n: number = 'x'\n"
  const GOOD = 'export const n: number = 1\n'

  // (a) a type error in a file this run changed: tsc fails, one fix turn, then it passes.
  configureFactory(deps)
  reset()
  const a = tsRepo('tsc-a')
  touch = () => writeFileSync(join(a, 'src.ts'), (prompts[prompts.length - 1] || '').includes('Verify failed') ? GOOD : BAD)
  const ida = begin(T1, a)
  assert.equal(getRun(ida)?.tier, 'T1')
  await until(() => tests(ida).some((t) => t.rows.some((r) => r.script === 'tsc --noEmit' && r.status === 'pass')), 'tsc passes after the fix')
  const first = tests(ida)[0].rows.find((r) => r.script === 'tsc --noEmit')
  assert.equal(first?.status, 'fail')
  assert.match(first?.tail || '', /src\.ts/)
  assert.equal(prompts.filter((p) => p.includes('Verify failed: tsc --noEmit')).length, 1)
  assert.equal(tests(ida).some((t) => t.rows.some((r) => r.script === 'typecheck')), false)
  const testers = threadItems(getRun(ida)!, null).filter((it) => it.role === 'tester')
  assert.match(testers[0].meta || '', /tsc --noEmit failed/)
  assert.ok(testers.some((it) => /tsc --noEmit passed/.test(it.meta || '')))
  assert.ok((testers[0].body || '').startsWith('tsc --noEmit') && !(testers[0].body || '').includes('npm run'))
  assert.equal(git(a, ['ls-files', '--others', '--exclude-standard']).split('\n').some((f) => f.endsWith('.js')), false)
  assert.equal(existsSync(join(a, 'src.js')), false)
  abandonRun(ida)

  // (a3) T3: the verify artifact carries the tsc output under its own label.
  reset()
  const a3 = tsRepo('tsc-a3')
  touch = () => writeFileSync(join(a3, 'src.ts'), BAD)
  const id3 = begin('redesign the webhook feature', a3)
  assert.equal(getRun(id3)?.tier, 'T3')
  await until(() => getRun(id3)?.plan?.status === 'waiting' && !!getRun(id3)?.plan?.text, 'a3 plan')
  decideRun(id3, 'approve-plan')
  await until(() => !!getRun(id3)?.verifyArtifact, 'a3 verify artifact')
  const art = readFileSync(getRun(id3)!.verifyArtifact!, 'utf8')
  assert.match(art, /== tsc --noEmit: fail/)
  assert.match(art, /TS2322/)
  assert.equal(art.includes('npm run tsc'), false)
  abandonRun(id3)

  // (b) a type error in a file this run did not change: no fix turn, on to review.
  reset()
  const b = tsRepo('tsc-b', { files: { 'other.ts': BAD } })
  touch = () => writeFileSync(join(b, 'src.ts'), GOOD)
  const idb = begin(T1, b)
  await until(() => getRun(idb)?.phase === 'review' && !!getRun(idb)?.diff, 'b on to review')
  const bRow = tests(idb)[0].rows.find((r) => r.script === 'tsc --noEmit')
  assert.equal(bRow?.status, 'fail')
  assert.match(bRow?.tail || '', /other\.ts/)
  assert.equal(prompts.some((p) => p.includes('Verify failed: tsc --noEmit')), false)
  abandonRun(idb)

  // (b2) the reviewer prompt names what ran.
  const sp = strictPrompt({ task: 't', tier: 'T2', risk: 'none', base: 'b', diff: 'd', workRepo: '/x', verify: [{ script: 'tsc --noEmit', status: 'fail', tail: 'src.ts(1,14): error TS2322' }] })
  assert.ok(sp.includes('- tsc --noEmit: fail') && !sp.includes('npm run tsc'))

  // (c)-(f) when the fallback must not run.
  const ran: string[] = []
  let tscCalls = 0
  configureFactory({ ...deps, runScript: async (_r, s) => (ran.push(s), { code: 0, out: 'ok' }), runTsc: async () => (tscCalls++, { code: 0, out: 'ok' }) })
  const onlyTypecheck = async (dir: string) => {
    reset()
    ran.length = 0
    tscCalls = 0
    touch = () => writeFileSync(join(dir, 'src.ts'), GOOD)
    const id = begin(T1, dir)
    await until(() => tests(id).length > 0, 'verify ran')
    const rows = tests(id)[0].rows
    abandonRun(id)
    return rows
  }
  const c = tsRepo('tsc-c', { files: { 'package.json': JSON.stringify({ name: 'c', scripts: { typecheck: 'tsc --noEmit' } }) } })
  const cRows = await onlyTypecheck(c)
  assert.ok(ran.includes('typecheck') && tscCalls === 0 && !cRows.some((r) => r.script === 'tsc --noEmit'), JSON.stringify({ ran, tscCalls, cRows }))
  const d = tsRepo('tsc-d', { tsc: false })
  const dRows = await onlyTypecheck(d)
  assert.ok(tscCalls === 0 && dRows.some((r) => r.script === 'typecheck' && r.status === 'skipped'), JSON.stringify(dRows))
  const e = tsRepo('tsc-e', { tsconfig: false })
  const eRows = await onlyTypecheck(e)
  assert.ok(tscCalls === 0 && eRows.some((r) => r.script === 'typecheck' && r.status === 'skipped'), JSON.stringify(eRows))
  const f = tsRepo('tsc-f', { files: { 'package.json': JSON.stringify({ name: 'f', scripts: { types: 'tsc --noEmit' } }) } })
  saveProfile(f, { scripts: { typecheck: 'types' } })
  await onlyTypecheck(f)
  assert.ok(ran.includes('types') && tscCalls === 0, JSON.stringify({ ran, tscCalls }))

  // (g) what the fallback runs, and its limit.
  assert.deepEqual(mods.controller.TSC_ARGS, ['--noEmit', '-p', 'tsconfig.json'])
  const ctl = readFileSync(join(root, 'src/main/factory/controller.ts'), 'utf8')
  assert.ok(ctl.includes("runBin(repo, join(repo, 'node_modules', '.bin', 'tsc'), TSC_ARGS, env)"))
  assert.ok(ctl.includes("runBin(repo, 'npm', ['run', '--silent', script], env)"))
  const runBinSrc = ctl.slice(ctl.indexOf('function runBin('), ctl.indexOf('function runBin(') + 900)
  assert.ok(runBinSrc.includes("setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)"), runBinSrc)
  assert.equal(/['"`]npx\b/.test(ctl), false, 'no npx command')
  configureFactory(deps)
})
