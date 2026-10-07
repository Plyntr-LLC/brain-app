import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { REVIEW_MAX, VOICE_MAX, watchDeployBlock, type DeployWatch, type RunEvent, type RunRecord } from '../../src/shared/factory'
import { FactoryPane } from '../../src/renderer/src/FactoryPane'
import { ActivityRail } from '../../src/renderer/src/ActivityRail'
import { factoryActivity, type Activity } from '../../src/renderer/src/factory-activity'
import timeline from './run-events.json'
import legacy from './run-ae98e1f8.json'
import lotTask from './run-5073ec51-task.json'

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []
const runs = new Map<string, RunRecord>()
const blocks = new Map<string, string | null>()
const anyway = new Map<string, boolean>()
const deployBlocks = new Map<string, string | null>()
const deployCmds = new Map<string, string>()
const polling = new Map<string, boolean>()
const confirms: string[] = []
const listeners: ((e: unknown) => void)[] = []
let conductHold: ((v: unknown) => void) | null = null
const rec = (fn: string, ...args: unknown[]) => {
  calls.push({ fn, args })
  return Promise.resolve({ ok: true, run: null })
}
const brain = {
  factory: {
    get: (id: string) => Promise.resolve(runs.get(id) || null),
    onEvent: (cb: (e: unknown) => void) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    },
    conduct: (id: string, text: string) => {
      calls.push({ fn: 'conduct', args: [id, text] })
      return new Promise((r) => (conductHold = r))
    },
    decide: (id: string, choice: string, reason?: string) => rec('decide', id, choice, ...(reason === undefined ? [] : [reason])),
    resume: (id: string) => rec('resume', id),
    pause: (id: string) => rec('pause', id),
    abandon: (id: string) => rec('abandon', id),
    commit: (id: string) => rec('commit', id),
    publish: (id: string) => rec('publish', id),
    publishAnyway: (id: string) => rec('publishAnyway', id),
    publishPreview: (id: string) => rec('publishPreview', id),
    deploy: (id: string) => rec('deploy', id),
    publishBlock: (id: string) => Promise.resolve({ ok: true, block: blocks.get(id) ?? null }),
    publishAnywayFor: (id: string) => Promise.resolve({ ok: true, offer: anyway.get(id) ?? false }),
    deployBlock: (id: string) => Promise.resolve({ ok: true, block: deployBlocks.get(id) ?? null, cmd: deployCmds.get(id) ?? '', polling: polling.get(id) ?? false }),
    checkDeploy: (id: string) => rec('checkDeploy', id),
    triage: () => Promise.resolve(null),
    resolveRepo: () => Promise.resolve({ ok: false, error: 'none' }),
    profile: () => Promise.resolve({ ok: false, error: 'none' })
  },
  skin: { decide: (tabId: string, optionId: string) => rec('skin.decide', tabId, optionId) }
}
;(window as unknown as { brain: typeof brain }).brain = brain
window.confirm = (msg?: string) => {
  confirms.push(String(msg || ''))
  return true
}
const layout = document.createElement('style')
layout.textContent =
  '.stage{margin:14px 0}.stage-title{font:600 12px sans-serif;margin:0 0 4px 14px}' +
  '.stage-row{display:grid;grid-template-columns:900px 300px;height:620px;margin-left:14px;border:1px solid #ccc}' +
  '.stage-pane{position:relative;overflow:hidden}.stage-rail{display:flex;flex-direction:column;border-left:1px solid #ddd;background:var(--paper)}'
document.head.appendChild(layout)

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: detail.slice(0, 300) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const emit = (e: unknown) => flushSync(() => listeners.forEach((l) => l(e)))

const now = 1791270000000
let seq = 0
function run(patch: Partial<RunRecord>): RunRecord {
  seq++
  const id = `run-ui-${seq}`
  const r: RunRecord = {
    id,
    title: 'LotOffice: nav highlight, ShedPro mapping, salesperson signature, company contract',
    task: 'fix the nav highlight',
    brainPath: '/Users/joe/Projects/agency-brain',
    workRepo: '/Users/joe/Projects/lotline',
    tier: 'T2',
    risk: 'none',
    triage: { size: 'T2', original: 'T2', capped: false, reasons: ['Reads like a standard feature.'] },
    phase: 'build',
    base: 'abc',
    acpTab: `factory-${id}`,
    profile: { repo: '/Users/joe/Projects/lotline', scripts: {}, voice: { on: false }, publish: { remote: 'origin' }, updatedAt: 0 },
    createdAt: now,
    updatedAt: now + 60000,
    ...patch
  }
  runs.set(id, r)
  return r
}

type Mounted = { el: HTMLElement; rail: HTMLElement; activity: () => Activity | null; r: RunRecord }
async function mount(title: string, r: RunRecord, o: { block?: string | null; anyway?: boolean; deployBlock?: string | null; deployCmd?: string; polling?: boolean } = {}): Promise<Mounted> {
  blocks.set(r.id, o.block ?? null)
  anyway.set(r.id, o.anyway ?? false)
  deployBlocks.set(r.id, o.deployBlock ?? null)
  deployCmds.set(r.id, o.deployCmd ?? '')
  polling.set(r.id, o.polling ?? false)
  const wrap = document.createElement('section')
  wrap.className = 'stage'
  wrap.innerHTML = `<p class="stage-title">${title}</p><div class="stage-row"><div class="stage-pane"></div><aside class="refs stage-rail"></aside></div>`
  document.getElementById('root')!.appendChild(wrap)
  const pane = wrap.querySelector('.stage-pane') as HTMLElement
  const rail = wrap.querySelector('.stage-rail') as HTMLElement
  let seen: Activity | null = null
  function Harness() {
    const [activity, setActivity] = useState<Activity | null>(null)
    return (
      <>
        <FactoryPane
          id={`tab-${r.id}`}
          runId={r.id}
          cwd={r.brainPath}
          active
          onRun={() => undefined}
          onFiles={() => undefined}
          onActivity={(_id, a) => {
            seen = a
            setActivity(a)
          }}
        />
        {activity ? <RailPortal el={rail} activity={activity} /> : null}
      </>
    )
  }
  createRoot(pane).render(<Harness />)
  await tick(80)
  return { el: pane, rail, activity: () => seen, r }
}

function RailPortal({ el, activity }: { el: HTMLElement; activity: Activity }) {
  const root = (el as unknown as { _root?: ReturnType<typeof createRoot> })._root || ((el as unknown as { _root?: ReturnType<typeof createRoot> })._root = createRoot(el))
  // The workspace passes openFile to every rail; the same handler here.
  queueMicrotask(() =>
    root.render(<ActivityRail activity={activity} onPush={() => void brain.factory.publish(activity.runId || '')} openFile={{ open: () => calls.push({ fn: 'openFile', args: [] }), canOpen: () => true }} />)
  )
  return null
}

const items = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.fthread > .fmsg')]
const label = (m: HTMLElement) => `${m.dataset.role}:${(m.querySelector('.fcard-title, .flead, .fbubble')?.textContent || '').trim()}`
const buttons = (el: HTMLElement, scope = '.factory-body') => [...el.querySelectorAll<HTMLButtonElement>(`${scope} button`)]
const btn = (el: HTMLElement, text: string) => buttons(el, '.factory').find((b) => (b.textContent || '').trim() === text)
async function click(el: HTMLElement, text: string): Promise<Call[]> {
  const before = calls.length
  const b = btn(el, text)
  if (!b) return [{ fn: `missing button ${text}`, args: [] }]
  b.click()
  await tick()
  return calls.slice(before)
}
const same = (got: Call[], fn: string, ...args: unknown[]) => got.length === 1 && got[0].fn === fn && JSON.stringify(got[0].args) === JSON.stringify(args)
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function main() {
  // (a) Unit 2's run-1 timeline.
  const ev = timeline as RunEvent[]
  const a = await mount(
    'a. the team thread from a real timeline',
    run({
      phase: 'done',
      events: ev,
      commitSha: '959aaeeb69ea02df6135a6d13366eaf2fc24af49',
      branch: 'main',
      pushed: { remote: 'origin', branch: 'main', sha: '959aaeeb69ea02df6135a6d13366eaf2fc24af49', at: now + 50000 },
      plan: { text: 'Files: src.ts\nCheck: the route answers.', by: 'opus', status: 'approved', rejects: 0, reasons: [] },
      audit: { brain: [], work: [{ path: 'fix.ts', added: 1, deleted: 0 }, { path: 'src.ts', added: 2, deleted: 1 }] },
      verify: [{ script: 'typecheck', status: 'skipped' }, { script: 'test', status: 'skipped' }, { script: 'e2e', status: 'skipped' }],
      strict: { status: 'pass', text: 'GAPS: 0\nPASS' },
      reviewCycles: 1
    })
  )
  const got = items(a.el).map((m) => m.dataset.role)
  check('a roles in order', JSON.stringify(got) === JSON.stringify(['lead', 'planner', 'lead', 'planner', 'builder', 'tester', 'reviewer', 'builder', 'tester', 'reviewer', 'lead', 'lead', 'lead']), JSON.stringify(got))
  const titles = items(a.el).map(label)
  check('a plan card carries the plan', (items(a.el)[1].querySelector('.fcard-body')?.textContent || '').includes('Files: src.ts'), titles.join(' | '))
  check('a builder 1 file then 2 files', titles[4] === 'builder:Changed 1 file  +2 −1' && titles[7].startsWith('builder:Changed 2 files'), titles.join(' | '))
  check('a review round 1 gaps with its text', titles[6] === 'reviewer:Round 1: gaps found' && (items(a.el)[6].querySelector('.fcard-body')?.textContent || '').includes('GAPS: 1'), titles[6])
  check('a review round 2 pass', titles[9] === 'reviewer:Round 2: pass', titles[9])
  const sha = (ev.find((e) => e.kind === 'commit') as Extract<RunEvent, { kind: 'commit' }>).sha
  check('a commit, done, pushed', titles[10].startsWith(`lead:Committed ${sha.slice(0, 7)}`) && titles[11] === 'lead:Done.' && titles[12] === 'lead:Pushed to origin/main.', titles.slice(10).join(' | '))
  check('a no raw activity box, no phase rail, no open diff', !a.el.querySelector('.factory-activity, .phaserail') && [...a.el.querySelectorAll('.factory-diff')].every((d) => d.closest('details')))
  check('a rail fed from onActivity equals factoryActivity(run)', JSON.stringify(a.activity()) === JSON.stringify(factoryActivity(a.r, null)))
  const shownPath = a.rail.querySelector<HTMLElement>('.rail-files .rail-path')
  check('a Factory file rows are not links and keep +N', !a.rail.querySelector('.rail-files button.rail-file') && (a.rail.querySelector('.rail-files .rail-file')?.textContent || '').includes('+'))
  check('a Factory changed files show without a click', !!shownPath && shownPath.offsetHeight > 0 && ['fix.ts', 'src.ts'].includes(shownPath.textContent || '') && !a.rail.querySelector('.rail-fold'))
  check('a rail Ship shows pushed, no Push', (a.rail.querySelector('.rail-ship')?.textContent || '').includes('Pushed 959aaee') && !a.rail.querySelector('.rail-ship button'))

  // (b) every question card, label to call.
  const dirty = await mount('b. dirty', run({ phase: 'triage', needsPrep: 'dirty', dirtyFiles: ['scratch.txt'], dirtyCount: 1 }))
  check('b dirty card says 1 file', (dirty.el.querySelector('.factory-trip')?.textContent || '').includes('(1 file)') && !(dirty.el.textContent || '').includes('1 files'))
  check('b dirty Commit first', same(await click(dirty.el, 'Commit first'), 'decide', dirty.r.id, 'prep-commit'))
  check('b dirty Stash first', same(await click(dirty.el, 'Stash first'), 'decide', dirty.r.id, 'prep-stash'))
  const proceed = await mount('b. proceed', run({ phase: 'triage', needsProceed: true, triage: { size: 'T2', original: 'T2', capped: false, reasons: ['Touches payments.'], llm: { by: 'jev', risk: 'critical' } } }))
  check('b proceed', same(await click(proceed.el, 'Proceed at T2'), 'decide', proceed.r.id, 'proceed'))
  check('b proceed has no Retry triage when Jev answered', !btn(proceed.el, 'Retry triage'))
  const skipped = await mount('b. proceed, triage skipped', run({ phase: 'triage', needsProceed: true, triage: { size: 'T2', original: 'T2', capped: false, reasons: ['Long request.'], llm: { skipped: 'timeout' } } }))
  check('b Retry triage', same(await click(skipped.el, 'Retry triage'), 'decide', skipped.r.id, 'retry-triage'))
  const plan = await mount(
    'b. plan',
    run({
      phase: 'plan',
      plan: { text: 'Files: nav.ts', by: 'opus', status: 'waiting', rejects: 0, reasons: [] },
      events: [{ at: now + 5, kind: 'plan', status: 'waiting', by: 'opus', text: 'Files: nav.ts' }]
    })
  )
  const waitingCard = plan.el.querySelector<HTMLDetailsElement>('[data-role="planner"] details.fcard')
  check('b the plan to approve is open in the thread', !!waitingCard?.open && (waitingCard.querySelector('.fcard-body') as HTMLElement).offsetHeight > 0 && (waitingCard.textContent || '').includes('Files: nav.ts'))
  const longText = `Files: big.ts\n${'step '.repeat(1400)}`
  const longPlan = await mount(
    'b. long plan waiting',
    run({
      phase: 'plan',
      plan: { text: longText, by: 'opus', status: 'waiting', rejects: 0, reasons: [] },
      events: [
        { at: now + 4, kind: 'plan', status: 'waiting', by: 'opus', text: 'Files: first.ts' },
        { at: now + 5, kind: 'plan', status: 'waiting', by: 'opus', text: longText.slice(0, 6000) }
      ]
    })
  )
  const longCards = [...longPlan.el.querySelectorAll<HTMLDetailsElement>('[data-role="planner"] details.fcard')]
  check('b a 7000-character waiting plan opens with all of it', longText.length > 7000 && !!longCards[1]?.open && (longCards[1].querySelector('.fcard-body')?.textContent || '').length === longText.length)
  check('b the earlier plan stays folded', !!longCards[0] && !longCards[0].open)
  const blockedPlan = await mount('b. blocked plan', run({ phase: 'plan', plan: { text: 'The code is in lotline, not here.', by: 'opus', status: 'blocked', rejects: 0, reasons: [] } }))
  check('b blocked plan has no Approve plan', !btn(blockedPlan.el, 'Approve plan') && (blockedPlan.el.textContent || '').includes('The planner could not plan here.'))
  typeInto(blockedPlan.el.querySelector('.factory-plan input') as HTMLInputElement, 'use lotline')
  await tick()
  check('b blocked plan Re-plan with the note', same(await click(blockedPlan.el, 'Re-plan'), 'decide', blockedPlan.r.id, 'reject-plan', 'use lotline'))
  const unready = await mount('b. plan with no verdict', run({ phase: 'plan', runThrough: true, plan: { text: 'Files: a.ts', by: 'opus', status: 'waiting', rejects: 0, reasons: [], unready: true } }))
  check('b not-ready plan says so and has Approve plan', (unready.el.textContent || '').includes('The planner did not say the plan is ready.') && same(await click(unready.el, 'Approve plan'), 'decide', unready.r.id, 'approve-plan'))
  const oldPlan = await mount('b. plan, saved before events', run({ phase: 'plan', plan: { text: 'Files: old.ts', by: 'opus', status: 'waiting', rejects: 0, reasons: [] } }))
  check('b a waiting plan with no timeline is open too', !!oldPlan.el.querySelector<HTMLDetailsElement>('[data-role="planner"] details.fcard')?.open)
  check('b Approve plan', same(await click(plan.el, 'Approve plan'), 'decide', plan.r.id, 'approve-plan'))
  typeInto(plan.el.querySelector('.factory-plan input') as HTMLInputElement, 'too big')
  await tick()
  check('b Reject with reason', same(await click(plan.el, 'Reject'), 'decide', plan.r.id, 'reject-plan', 'too big'))
  const tier = await mount('b. tier', run({ phase: 'upgrade', resumePhase: 'build', tripwire: { reasons: ['12 files over the T2 limit.'], suggest: 'T3' } }))
  check('b Move to T3', same(await click(tier.el, 'Move to T3'), 'decide', tier.r.id, 'upgrade'))
  check('b tier Trim', same(await click(tier.el, 'Trim'), 'decide', tier.r.id, 'trim'))
  check('b tier Stop', same(await click(tier.el, 'Stop'), 'decide', tier.r.id, 'stop'))
  const cap = await mount('b. review cap', run({ phase: 'review', diff: 'diff --git a/x b/x', strict: { status: 'fail', text: 'gap' }, reviewCycles: REVIEW_MAX }))
  check('b Keep fixing', same(await click(cap.el, 'Keep fixing'), 'decide', cap.r.id, 'keep-fix'))
  check('b Re-review', same(await click(cap.el, 'Re-review'), 'decide', cap.r.id, 're-review'))
  check('b cap Trim', same(await click(cap.el, 'Trim'), 'decide', cap.r.id, 'trim'))
  check('b cap Pause', same(await click(cap.el, 'Pause'), 'pause', cap.r.id))
  check('b Commit anyway', same(await click(cap.el, 'Commit anyway'), 'commit', cap.r.id))
  const voice = await mount('b. voice below cap', run({ phase: 'review', diff: 'diff --git a/x b/x', strict: { status: 'pass', text: '' }, voice: { script: 'voice', status: 'fail', tail: 'REJECT: hype' }, voiceCycles: 1 }))
  check('b voice Fix copy', same(await click(voice.el, 'Fix copy'), 'decide', voice.r.id, 'fix-copy'))
  check('b voice Commit disabled, no call', btn(voice.el, 'Commit')?.disabled === true && (await click(voice.el, 'Commit')).length === 0)
  const vcap = await mount('b. voice cap', run({ phase: 'review', diff: 'diff --git a/x b/x', strict: { status: 'pass', text: '' }, voice: { script: 'voice', status: 'fail', tail: 'REJECT' }, voiceCycles: VOICE_MAX }))
  check('b voice cap text', (vcap.el.querySelector('.factory-ready')?.textContent || '').includes(`Voice has not approved after ${VOICE_MAX} fixes.`))
  check('b voice cap Fix copy', same(await click(vcap.el, 'Fix copy'), 'decide', vcap.r.id, 'fix-copy'))
  check('b voice cap Commit disabled, no call', btn(vcap.el, 'Commit')?.disabled === true && (await click(vcap.el, 'Commit')).length === 0)
  const paused = await mount('b. paused', run({ phase: 'paused', resumePhase: 'build', error: 'This turn changed no files in /Users/joe/Projects/lotline.' }))
  check('b paused shows the error', (paused.el.querySelector('.factory-body')?.textContent || '').includes('This turn changed no files'))
  check('b paused Resume', same(await click(paused.el, 'Resume'), 'resume', paused.r.id))
  const failed = await mount('b. failed', run({ phase: 'failed', resumePhase: 'build', error: 'builder crashed' }))
  check('b failed Resume', same(await click(failed.el, 'Resume'), 'resume', failed.r.id))
  const ready = await mount('b. reviewed diff', run({ phase: 'review', diff: 'diff --git a/nav.ts b/nav.ts\n+one', strict: { status: 'pass', text: '' } }))
  const changes = ready.el.querySelector('.factory-changes') as HTMLDetailsElement
  check('b See changes folded at first', !!changes && !changes.open)
  ;(changes.querySelector('summary') as HTMLElement).click()
  await tick()
  check('b See changes opens the diff, no call', changes.open && (changes.textContent || '').includes('+one') && calls.slice(-1)[0]?.fn !== 'commit')
  check('b Commit', same(await click(ready.el, 'Commit'), 'commit', ready.r.id))
  const done = await mount('b. done, not pushed', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main' }))
  check('b Push', same(await click(done.el, 'Push'), 'publish', done.r.id))
  const anywayRun = await mount('b. push anyway', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'staging' }), { block: 'Brain does not push to staging. Push it from Terminal after review.', anyway: true })
  check('b Push anyway after confirm', same(await click(anywayRun.el, 'Push to staging anyway…'), 'publishAnyway', anywayRun.r.id))
  check('b blocked Push disabled with its reason, no call', btn(anywayRun.el, 'Push')?.disabled === true && (anywayRun.el.textContent || '').includes('Brain does not push to staging') && (await click(anywayRun.el, 'Push')).length === 0)
  const heldShip = await mount(
    'b. Ship in advance held on a Vercel main',
    run({
      phase: 'done',
      commitSha: 'feedbeefcafe',
      branch: 'main',
      shipHeld: 'Ship in advance stopped before the push: pushing main to origin deploys production on Vercel.',
      deployHint: { host: 'Vercel', prod: true, line: 'Pushing main to origin deploys production on Vercel.' }
    })
  )
  const shipText = heldShip.el.querySelector('.factory-ship')?.textContent || ''
  check('b held: the commit sentence and an enabled Push stay', shipText.includes('Committed feedbee on main. Not pushed.') && btn(heldShip.el, 'Push')?.disabled === false)
  check('b held: the deploy line and the stop note show', shipText.includes('Pushing main to origin deploys production on Vercel.') && shipText.includes('Ship in advance stopped before the push'))
  check('b held: Push a preview branch', same(await click(heldShip.el, 'Push a preview branch'), 'publishPreview', heldShip.r.id))
  await tick(60)
  const railShip = heldShip.rail.querySelector('.rail-ship')?.textContent || ''
  check('b held: the rail keeps its commit line and Push, with the deploy line', railShip.includes('Commit feedbee on main.') && railShip.includes('Pushing main to origin deploys production on Vercel.') && !!heldShip.rail.querySelector('.rail-ship button'))
  check('b a run with no host shows no deploy line and no preview button', !(done.el.textContent || '').includes('deploys production') && !btn(done.el, 'Push a preview branch'))
  const previewed = await mount(
    'b. a preview pushed',
    run({
      phase: 'done',
      commitSha: 'feedbeefcafe',
      branch: 'main',
      deployHint: { host: 'Vercel', prod: true, line: 'Pushing main to origin deploys production on Vercel.' },
      preview: { remote: 'origin', branch: 'factory/run-x', sha: 'feedbeefcafe', at: now + 9 },
      events: [{ at: now + 9, kind: 'push', ok: true, text: 'origin/factory/run-x (preview)' }]
    })
  )
  check('b the preview Lead line', items(previewed.el).some((m) => label(m) === 'lead:Pushed a preview to origin/factory/run-x. Vercel builds it.'))
  check('b after a preview, Push for main stays and no second preview button', !!btn(previewed.el, 'Push') && !btn(previewed.el, 'Push a preview branch'))
  const pushed = await mount('b. pushed, not deployed', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: { remote: 'origin', branch: 'main', sha: 'feedbeefcafe', at: now } }))
  check('b Deploy', same(await click(pushed.el, 'Deploy'), 'deploy', pushed.r.id))
  const noDeploy = await mount('b. deploy blocked', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: { remote: 'origin', branch: 'main', sha: 'feedbeefcafe', at: now } }), { deployBlock: 'No deploy command on this repo.' })
  check('b blocked Deploy disabled with its reason', btn(noDeploy.el, 'Deploy')?.disabled === true && (noDeploy.el.textContent || '').includes('No deploy command on this repo.'))
  const going = await mount('b. running header', run({ phase: 'build' }))
  check('b header Pause', same(await click(going.el, 'Pause'), 'pause', going.r.id))
  check('b header Abandon', same(await click(going.el, 'Abandon run'), 'abandon', going.r.id))
  check('b done run has no Pause or Abandon', !btn(done.el, 'Pause') && !btn(done.el, 'Abandon run'))

  // Item 2: permission asks.
  const perm = await mount('b. permission', run({ phase: 'build' }))
  emit({ runId: 'someone-else', kind: 'stream', ev: { kind: 'permission', title: 'Edit nav.ts', options: [{ id: 'allowOnce', label: 'Allow' }] } })
  await tick()
  check('b permission for another run shows nothing', !perm.el.querySelector('.skin-perm'))
  emit({ runId: perm.r.id, kind: 'stream', ev: { kind: 'permission', title: 'Edit nav.ts', path: 'src/nav.ts', options: [{ id: 'allowOnce', label: 'Allow' }, { id: 'reject', label: 'No' }] } })
  await tick()
  check('b permission options shown', !!btn(perm.el, 'Allow') && !!btn(perm.el, 'No'))
  check('b permission Allow', same(await click(perm.el, 'Allow'), 'skin.decide', perm.r.acpTab, 'allowOnce') && !perm.el.querySelector('.skin-perm'))
  emit({ runId: perm.r.id, kind: 'stream', ev: { kind: 'permission', title: 'Run npm test', options: [] } })
  await tick()
  check('b permission default Skip', same(await click(perm.el, 'Skip'), 'skin.decide', perm.r.acpTab, 'skip'))

  // Items 3 and 7: the pending line, FACTORY_TELL, Enter.
  const talk = await mount(
    'c. talking to the team',
    run({
      phase: 'build',
      guide: [
        { at: now + 1000, text: 'why is it working in the 360seo intake project?', sent: true, ask: true, repo: '', ack: 'It moved to lotline.' },
        { at: now + 2000, text: 'make sure plain text contracts still work', sent: true, ack: 'Added to the fix turn.' }
      ]
    })
  )
  const box = talk.el.querySelector('.factory-compose textarea') as HTMLTextAreaElement
  typeInto(box, 'keep the footer short')
  await tick()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
  await tick()
  check('c Shift+Enter sends nothing', !calls.some((c) => c.fn === 'conduct'))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick()
  check('c Enter sends through conduct', calls.some((c) => c.fn === 'conduct' && c.args[0] === talk.r.id && c.args[1] === 'keep the footer short'))
  const joes = [...talk.el.querySelectorAll<HTMLElement>('.fmsg.joe')]
  check('c the pending line is the last Joe bubble', (joes[joes.length - 1]?.textContent || '').trim() === 'keep the footer short', joes.map((j) => j.textContent).join(' | '))
  emit({ runId: talk.r.id, kind: 'guide', ev: { kind: 'text', data: 'Telling the builder.\nFACTORY_TELL: keep it short' } })
  await tick()
  check('c the reply streams without FACTORY_TELL', (talk.el.textContent || '').includes('Telling the builder.') && !(talk.el.textContent || '').includes('FACTORY_TELL'))
  const saved = { ...talk.r, guide: [...(talk.r.guide || []), { at: now + 3000, text: 'keep the footer short', sent: true, ack: 'Telling the builder.' }] }
  runs.set(talk.r.id, saved)
  conductHold?.({ ok: true, run: saved })
  await tick(80)
  check('c one bubble for the sent note', [...talk.el.querySelectorAll('.fmsg.joe')].filter((j) => (j.textContent || '').trim() === 'keep the footer short').length === 1)

  // (c) a run saved before events.
  const oldRun = { ...(legacy as unknown as RunRecord) }
  runs.set(oldRun.id, oldRun)
  const old = await mount('d. run-ae98e1f8 (no events)', oldRun)
  const oldTitles = items(old.el).map(label)
  check('d old run has a thread', oldTitles.length >= 5, oldTitles.join(' | '))
  check('d old run builder 26 files', oldTitles.some((t) => t.startsWith('builder:Changed 26 files')), oldTitles.join(' | '))
  check('d old run tester names the skipped typecheck', [...old.el.querySelectorAll('[data-role="tester"] .fmeta')].some((m) => (m.textContent || '').includes('No typecheck script')))
  check('d old run reviewer pass', oldTitles.includes('reviewer:Review: pass'))
  check('d old run push error line', oldTitles.some((t) => t.startsWith('lead:Push failed: Blocked')))

  // (d) the rail from runs in different states.
  const fixing = await mount(
    'e. rail: fixing after a round-1 FAIL',
    run({ phase: 'review', strict: { status: 'fail', text: 'gap' }, reviewCycles: 1, audit: { brain: [], work: [{ path: 'nav.ts', added: 4, deleted: 1 }] }, live: [{ id: 'l1', phase: 'build', cli: 'grok', model: 'grok-4.7-build-fast', effort: 'xhigh', since: Date.now() - 42000 }] })
  )
  await tick(60)
  const row = (rail: HTMLElement, name: string) => [...rail.querySelectorAll<HTMLElement>('.rail-row')].find((r) => (r.querySelector('.rail-label')?.textContent || '') === name)
  check('e Review is live, not done', !!row(fixing.rail, 'Review')?.classList.contains('live'), row(fixing.rail, 'Review')?.className || 'no row')
  check('e Builder live in Team', !!row(fixing.rail, 'Builder')?.classList.contains('live'))
  check('e Now names the builder', (fixing.rail.querySelector('.rail-now-text')?.textContent || '').startsWith('Builder'))
  check('e no Ship before done', !fixing.rail.querySelector('.rail-ship'))
  const blocked = await mount('e. rail: done, push blocked', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'staging' }), { block: 'Brain does not push to staging.' })
  await tick(60)
  const shipBtn = blocked.rail.querySelector('.rail-ship button') as HTMLButtonElement | null
  check('e Ship Push disabled with the block text', !!shipBtn && shipBtn.disabled && (blocked.rail.textContent || '').includes('Brain does not push to staging.'))

  // (e) folding.
  const long = 'x'.repeat(6000)
  const fold = await mount(
    'f. folding',
    run({
      phase: 'build',
      events: [
        { at: now + 1, kind: 'plan', status: 'approved', by: 'opus', text: long },
        { at: now + 2, kind: 'test', rows: [{ script: 'test', status: 'fail', tail: 'y'.repeat(2000) }] },
        { at: now + 3, kind: 'review', round: 1, status: 'fail', text: long }
      ]
    })
  )
  for (const role of ['planner', 'tester', 'reviewer']) {
    const card = fold.el.querySelector<HTMLDetailsElement>(`[data-role="${role}"] details.fcard`)
    check(`f ${role} folded and short`, !!card && !card.open && card.getBoundingClientRect().height < 200, card ? `${card.open} ${card.getBoundingClientRect().height}` : 'no card')
  }

  // (g) the ask approver: the intake's Asks select, the run chip, the rail row, a refusal card, a worker's card.
  {
    const wrap = document.createElement('section')
    wrap.className = 'stage'
    wrap.innerHTML = '<p class="stage-title">g. intake with the Asks select</p><div class="stage-row"><div class="stage-pane"></div><aside class="refs stage-rail"></aside></div>'
    document.getElementById('root')!.appendChild(wrap)
    const pane = wrap.querySelector('.stage-pane') as HTMLElement
    createRoot(pane).render(<FactoryPane id="tab-intake" cwd="/Users/joe/Projects/agency-brain" active onRun={() => undefined} onFiles={() => undefined} onActivity={() => undefined} />)
    await tick(80)
    const sel = pane.querySelector<HTMLSelectElement>('.factory-checks select')
    const checks = () => pane.querySelector('.factory-checks')?.textContent || ''
    check('g the Asks select defaults to Fable, with Opus 5.5 and No model', !!sel && sel.value === 'fable' && [...(sel?.options || [])].map((o) => o.value).join(',') === 'fable,opus,off', sel ? sel.value : 'no select')
    check('g with a model deciding, Approve in advance does not claim the asks', checks().includes('Approve in advance (plan and a clean Commit go ahead; never deploys)') && !checks().includes('plan, asks,'), checks())
    const labels = [...pane.querySelectorAll('.factory-checks label')].map((l) => (l.textContent || '').slice(0, 24))
    check('g the Asks row sits in the checks block, before Approve in advance and Ship in advance', labels[0].startsWith('Asks:') && labels[1].startsWith('Approve in advance') && labels[2].startsWith('Ship in advance'), JSON.stringify(labels))
    if (sel) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, 'off')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
    }
    check('g with No model, Approve in advance covers the asks again', checks().includes('plan, asks, and a clean Commit go ahead'), checks())
    if (sel) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, 'fable')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
    }
  }
  const ap = await mount(
    'g. a run Fable approves',
    run({
      phase: 'build',
      runThrough: true,
      approver: 'fable',
      asks: {
        allowed: 12,
        denied: 1,
        carded: 1,
        log: [
          { n: 13, at: now + 3, title: 'Run railway up', decision: 'deny', by: 'Fable', why: 'It deploys the project to a remote host.' },
          { n: 14, at: now + 4, title: 'Run psql "$DATABASE_URL" -c "drop table x"', decision: 'card', by: 'Fable', why: 'Fable says a person should decide: it drops a table.' }
        ]
      },
      events: [
        { at: now + 1, kind: 'repo', repo: '/Users/joe/Projects/lotline', moved: false, from: 'given' },
        { at: now + 3, kind: 'ask', n: 13, decision: 'deny', title: 'Run railway up', by: 'Fable', text: 'It deploys the project to a remote host.' },
        { at: now + 4, kind: 'ask', n: 14, decision: 'card', title: 'Run psql "$DATABASE_URL" -c "drop table x"', by: 'Fable', text: 'Fable says a person should decide: it drops a table.' }
      ]
    })
  )
  await tick(60)
  const chips = [...ap.el.querySelectorAll('.factory-chips .fchip')].map((c) => c.textContent || '')
  check('g the run chip says who decides asks and the counts', chips.includes('Fable decides asks · 12 allowed, 1 refused, 1 to you'), JSON.stringify(chips))
  const apTitles = items(ap.el).map(label)
  check('g the thread shows the refusal and the hand-off as reviewer cards', apTitles.includes('reviewer:Refused: Run railway up') && apTitles.some((t) => t.startsWith('reviewer:Handed to you: Run psql')), apTitles.join(' | '))
  const team = ap.activity()?.team || []
  const approverRow = team.find((t) => t.role === 'Approver')
  check('g the rail team lists the approver with its counts', approverRow?.who === 'Fable' && approverRow.note === '12 allowed, 1 refused, 1 to you', JSON.stringify(approverRow))
  emit({ runId: ap.r.id, kind: 'stream', ev: { kind: 'permission', title: 'Run psql "$DATABASE_URL" -c "drop table x"', detail: 'Fable says a person should decide: it drops a table.', options: [{ id: 'allow_once', label: 'Allow' }, { id: 'reject_once', label: 'Reject' }], requestId: '7', tabId: `factory-${ap.r.id}-w2` } })
  await tick()
  check('g the hand-off card shows the reason', (ap.el.querySelector('.factory-ask .skin-perm-detail')?.textContent || '').includes('it drops a table'))
  const answered = await click(ap.el, 'Reject')
  check('g a worker card answers the worker tab, not the main tab', same(answered, 'skin.decide', `factory-${ap.r.id}-w2`, 'reject_once'), JSON.stringify(answered))

  // (h) the deploy watch in the ship block: one line per state where the deploy hint sat, and Deploy on or off.
  const pushedAt = { remote: 'origin', branch: 'main', sha: 'feedbeefcafe', at: now }
  const watchFrames: [string, DeployWatch, string, boolean][] = [
    ['watching', { state: 'watching', since: now }, 'Watching for a deploy...', false],
    ['building', { state: 'building', host: 'Vercel', env: 'Production', since: now }, 'Vercel is building production...', false],
    ['live', { state: 'live', host: 'Vercel', env: 'Production', url: 'https://lotline.vercel.app', at: now }, 'Live on Vercel: https://lotline.vercel.app', false],
    ['failed', { state: 'failed', host: 'Vercel', env: 'Production', url: 'https://lotline-x.vercel.app', at: now }, 'Vercel deploy failed: https://lotline-x.vercel.app', true],
    ['none', { state: 'none', at: now }, 'No deploy started in the 3 minutes after the push.', true],
    ['unknown', { state: 'unknown', why: 'the GitHub CLI is not signed in (gh auth login).', at: now }, "Brain can't watch this host: the GitHub CLI is not signed in (gh auth login).", true]
  ]
  for (const [name, deployWatch, text, on] of watchFrames) {
    const f = await mount(`h. deploy watch: ${name}`, run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: pushedAt, deployWatch, deployHint: { host: 'Vercel', prod: true, line: 'Pushing main to origin deploys production on Vercel.' } }), { deployCmd: 'vercel deploy --prod --yes', polling: true })
    const ship = f.el.querySelector('.factory-ship')
    const shown = [...(ship?.querySelectorAll('.factory-deploy') || [])].map((p) => p.textContent || '')
    const deploy = btn(f.el, 'Deploy')
    check(`h ${name}: the ship block's one deploy line is "${text}"`, JSON.stringify(shown) === JSON.stringify([text]), JSON.stringify(shown))
    check(`h ${name}: Deploy is ${on ? 'on' : 'off'}`, !!deploy && deploy.disabled === !on, String(deploy?.disabled))
    if (!on) check(`h ${name}: the reason sits beside Deploy`, (deploy?.parentElement?.textContent || '').includes(watchDeployBlock(deployWatch) || '~'), deploy?.parentElement?.textContent || '')
  }
  const hint = await mount('h. committed, not pushed: the deploy hint stays', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', deployHint: { host: 'Vercel', prod: true, line: 'Pushing main to origin deploys production on Vercel.' } }))
  check('h before the push the hint line is unchanged', (hint.el.querySelector('.factory-ship .factory-deploy')?.textContent || '') === 'Pushing main to origin deploys production on Vercel.')
  const none = await mount('h. none: Deploy confirms the exact command', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: pushedAt, deployWatch: { state: 'none', at: now } }), { deployCmd: 'vercel deploy --prod --yes' })
  const c0 = confirms.length
  const deployed = await click(none.el, 'Deploy')
  check('h Deploy confirms with the exact command, then deploys', confirms.length === c0 + 1 && confirms.at(-1)!.includes('vercel deploy --prod --yes') && same(deployed, 'deploy', none.r.id), JSON.stringify({ confirm: confirms.at(-1), deployed }))
  const stale = await mount('h. watching after a restart: Check deploy again', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: pushedAt, deployWatch: { state: 'building', host: 'Vercel', since: now } }), { polling: false })
  check('h a building watch with no poller offers Check deploy again', same(await click(stale.el, 'Check deploy again'), 'checkDeploy', stale.r.id))
  const polled = await mount('h. watching with a poller', run({ phase: 'done', commitSha: 'feedbeefcafe', branch: 'main', pushed: pushedAt, deployWatch: { state: 'watching', since: now } }), { polling: true })
  check('h a watch with a live poller has no Check deploy again', !btn(polled.el, 'Check deploy again'))

  // (i) a finished run keeps its composer for questions; Pause and Abandon stay hidden.
  for (const phase of ['done', 'abandoned'] as const) {
    const over = await mount(`i. ${phase} run: ask about it`, run({ phase, commitSha: 'feedbeefcafe', branch: 'main' }))
    const box = over.el.querySelector<HTMLTextAreaElement>('.factory-compose textarea')
    check(`i ${phase}: the composer stays on screen, with "Ask about this run"`, box?.placeholder === 'Ask about this run' && box.offsetHeight > 0, box ? `${box.placeholder} ${box.offsetHeight}px` : 'no composer')
    check(`i ${phase}: no Pause or Abandon`, !btn(over.el, 'Pause') && !btn(over.el, 'Abandon run'))
    typeInto(box!, 'What did this run change?')
    await tick()
    const sent = await click(over.el, 'Send')
    check(`i ${phase}: Send asks through conduct`, sent.length === 1 && sent[0].fn === 'conduct' && sent[0].args[1] === 'What did this run change?', JSON.stringify(sent))
    conductHold?.({ ok: true, run: null })
  }
  const working = await mount('i. a live run keeps its composer text', run({ phase: 'build' }))
  check('i a live run keeps "Talk to the team"', working.el.querySelector<HTMLTextAreaElement>('.factory-compose textarea')?.placeholder === 'Talk to the team: ask, redirect, add something, or say go')

  // (j) the full task under the title: Show task / Hide task, nothing else in the header moves.
  const jBox = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect()
    return r ? [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(',') : 'missing'
  }
  const lot = await mount('j. the task, open (kept open for the screenshot)', run({ phase: 'build', title: lotTask.title, task: lotTask.task }))
  const headOf = (m: Mounted) => ({ h3: m.el.querySelector('.factory-h'), pause: btn(m.el, 'Pause'), abandon: btn(m.el, 'Abandon run'), block: m.el.querySelector<HTMLElement>('.factory-task') })
  const shut = headOf(lot)
  const jBefore = { pause: jBox(shut.pause), abandon: jBox(shut.abandon), size: shut.h3 ? getComputedStyle(shut.h3).fontSize : '' }
  check('j closed by default: the h3 is run.title, no task block, the toggle says Show task', shut.h3?.textContent === lotTask.title && !shut.block && !!btn(lot.el, 'Show task') && lotTask.task.length === 595, shut.h3?.textContent || '')
  btn(lot.el, 'Show task')!.click()
  await tick()
  const open = headOf(lot)
  check('j open: the h3 is still run.title and looks the same', open.h3?.textContent === lotTask.title && getComputedStyle(open.h3!).fontSize === jBefore.size && jBefore.size === '15px', `${open.h3?.textContent} ${jBefore.size}`)
  check("j open: the block holds run.task exactly (Joe's 595-character task)", open.block?.textContent === lotTask.task, JSON.stringify(open.block?.textContent?.slice(0, 80)))
  check('j open: Pause and Abandon have the same boxes as when closed', jBox(open.pause) === jBefore.pause && jBox(open.abandon) === jBefore.abandon && jBefore.pause !== 'missing', JSON.stringify({ jBefore, after: { pause: jBox(open.pause), abandon: jBox(open.abandon) } }))
  check('j open: the toggle says Hide task and the block sits right under the title row', !!btn(lot.el, 'Hide task') && open.block?.previousElementSibling?.classList.contains('factory-titlerow') === true)
  const closedFrame = await mount('j. the task, closed', run({ phase: 'build', title: lotTask.title, task: lotTask.task }))
  check('j a second mount of the same task opens closed', !closedFrame.el.querySelector('.factory-task'))

  const first = run({ phase: 'build', title: 'First run', task: 'First run task\nwith a second line' })
  const second = run({ phase: 'build', title: 'Second run', task: 'Second run task' })
  const jWrap = document.createElement('section')
  jWrap.className = 'stage'
  jWrap.innerHTML = '<p class="stage-title">j. one pane, then another run in it</p><div class="stage-row"><div class="stage-pane"></div><aside class="refs stage-rail"></aside></div>'
  document.getElementById('root')!.appendChild(jWrap)
  let show: (id: string) => void = () => undefined
  function Switcher() {
    const [rid, setRid] = useState(first.id)
    show = setRid
    return <FactoryPane id="tab-switch" runId={rid} cwd={first.brainPath} active onRun={() => undefined} onFiles={() => undefined} onActivity={() => undefined} />
  }
  const host = jWrap.querySelector('.stage-pane') as HTMLElement
  createRoot(host).render(<Switcher />)
  await tick(80)
  btn(host, 'Show task')!.click()
  await tick()
  const firstOpen = host.querySelector('.factory-task')?.textContent === first.task
  flushSync(() => show(second.id))
  await tick(80)
  check('j open one run, then the pane shows another: its task is closed', firstOpen && host.querySelector('.factory-h')?.textContent === 'Second run' && !host.querySelector('.factory-task') && !!btn(host, 'Show task'), JSON.stringify({ firstOpen, h3: host.querySelector('.factory-h')?.textContent }))

  const token = 'x'.repeat(400)
  const longTask = [token, ...Array.from({ length: 79 }, (_, i) => `line ${i + 2} of a long task`)].join('\n')
  const jLong = await mount('j. a 400-character token and 80 lines', run({ phase: 'build', title: 'Long task', task: longTask }))
  btn(jLong.el, 'Show task')!.click()
  await tick()
  const block = jLong.el.querySelector<HTMLElement>('.factory-task')
  const cs = block ? getComputedStyle(block) : null
  const extra = cs && cs.boxSizing !== 'border-jBox' ? ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + parseFloat(cs[k as 'paddingTop']), 0) : 0
  check('j a 400-character token wraps inside the block (no sideways overflow)', !!block && block.scrollWidth <= block.clientWidth && block.textContent === longTask, block ? `${block.scrollWidth} > ${block.clientWidth}` : 'no block')
  check('j 80 lines scroll inside the block, within its max height', !!block && !!cs && block.scrollHeight > block.clientHeight && cs.overflowY === 'auto' && block.getBoundingClientRect().height <= parseFloat(cs.maxHeight) + extra + 0.5, cs ? `${block?.scrollHeight}/${block?.clientHeight} ${cs.overflowY} ${cs.maxHeight}` : 'no block')
  check('j the long task keeps Pause and Abandon on screen in the title row', !!btn(jLong.el, 'Pause') && btn(jLong.el, 'Pause')!.closest('.factory-titlerow') !== null && !!btn(jLong.el, 'Abandon run'))

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
