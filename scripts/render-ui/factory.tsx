import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { REVIEW_MAX, VOICE_MAX, type RunEvent, type RunRecord } from '../../src/shared/factory'
import { FactoryPane } from '../../src/renderer/src/FactoryPane'
import { ActivityRail } from '../../src/renderer/src/ActivityRail'
import { factoryActivity, type Activity } from '../../src/renderer/src/factory-activity'
import timeline from './run-events.json'
import legacy from './run-ae98e1f8.json'

type Call = { fn: string; args: unknown[] }
const calls: Call[] = []
const runs = new Map<string, RunRecord>()
const blocks = new Map<string, string | null>()
const anyway = new Map<string, boolean>()
const deployBlocks = new Map<string, string | null>()
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
    deploy: (id: string) => rec('deploy', id),
    publishBlock: (id: string) => Promise.resolve({ ok: true, block: blocks.get(id) ?? null }),
    publishAnywayFor: (id: string) => Promise.resolve({ ok: true, offer: anyway.get(id) ?? false }),
    deployBlock: (id: string) => Promise.resolve({ ok: true, block: deployBlocks.get(id) ?? null }),
    triage: () => Promise.resolve(null),
    resolveRepo: () => Promise.resolve({ ok: false, error: 'none' }),
    profile: () => Promise.resolve({ ok: false, error: 'none' })
  },
  skin: { decide: (tabId: string, optionId: string) => rec('skin.decide', tabId, optionId) }
}
;(window as unknown as { brain: typeof brain }).brain = brain
window.confirm = () => true
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
async function mount(title: string, r: RunRecord, o: { block?: string | null; anyway?: boolean; deployBlock?: string | null } = {}): Promise<Mounted> {
  blocks.set(r.id, o.block ?? null)
  anyway.set(r.id, o.anyway ?? false)
  deployBlocks.set(r.id, o.deployBlock ?? null)
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
  queueMicrotask(() => root.render(<ActivityRail activity={activity} onPush={() => void brain.factory.publish(activity.runId)} />))
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

  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
