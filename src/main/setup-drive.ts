import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { setupTrace } from './setup-trace'

type Dom = {
  screen: string
  buttons: string[]
  strip: string
  model: string
  effort: string
  h1: string
  primary: string
  primaryDisabled: boolean
  role: string
  path: string
  radios: number
}

function blankDom(): Dom {
  return { screen: '', buttons: [], strip: '', model: '', effort: '', h1: '', primary: '', primaryDisabled: false, role: '', path: '', radios: 0 }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearPretend(): void {
  delete process.env.BRAIN_APP_PRETEND_ABSENT
  delete process.env.BRAIN_APP_PRETEND_PRESENT
  delete process.env.BRAIN_APP_PRETEND_EXIT
  delete process.env.BRAIN_APP_PRETEND_INSTALL
  delete process.env.BRAIN_APP_PRETEND_AGENCY
  delete process.env.BRAIN_APP_PRETEND_SIGNED_OUT
  delete process.env.BRAIN_APP_PRETEND_NO_CLI
}

async function js<T>(win: BrowserWindow, source: string): Promise<T> {
  return (await win.webContents.executeJavaScript(source)) as T
}

async function boot(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const ready = await js<boolean>(win, 'Boolean(window.__brainBoot && window.__brainDrive)').catch(() => false)
    if (ready) return
    await sleep(150)
  }
  throw new Error('The setup window did not finish starting.')
}

async function readDom(win: BrowserWindow): Promise<Dom> {
  return js<Dom>(win, 'window.__brainDrive.read()')
}

async function waitScreen(win: BrowserWindow, screen: string): Promise<Dom> {
  let last = blankDom()
  for (let i = 0; i < 80; i++) {
    last = await readDom(win)
    if (last.screen === screen) return last
    await sleep(150)
  }
  return last
}

async function waitButton(win: BrowserWindow, label: string): Promise<Dom> {
  let last = await readDom(win)
  for (let i = 0; i < 30; i++) {
    if (last.buttons.includes(label)) return last
    await sleep(100)
    last = await readDom(win)
  }
  return last
}

async function clickStart(win: BrowserWindow): Promise<void> {
  const clicked = await js<boolean>(
    win,
    `new Promise((resolve) => {
      let n = 0
      const tick = () => {
        const btn = document.querySelector('[data-setup-screen="needs"] .primary')
        if (btn && !btn.disabled) { btn.click(); resolve(true); return }
        if (++n > 40) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })`
  )
  if (!clicked) throw new Error('Start setup was not ready to click.')
  await sleep(1500)
}

function noteScreen(name: string, dom: Dom): void {
  setupTrace({
    event: 'screen',
    run: name,
    screen: dom.screen,
    buttons: dom.buttons,
    strip: dom.strip,
    model: dom.model,
    effort: dom.effort,
    h1: dom.h1,
    primary: dom.primary,
    primaryDisabled: dom.primaryDisabled,
    role: dom.role,
    path: dom.path,
    radios: dom.radios
  })
}

async function waitNeedsReview(win: BrowserWindow): Promise<Dom> {
  let last = blankDom()
  for (let i = 0; i < 80; i++) {
    last = await readDom(win)
    if (last.h1 === 'One setup, then Chat.' && last.primary.includes('Start setup') && !last.primaryDisabled) return last
    await sleep(150)
  }
  return last
}

async function joiner(win: BrowserWindow): Promise<void> {
  clearPretend()
  setupTrace({ event: 'run', name: 'joiner' })
  await js(win, `window.__brainDrive.setChannel('plyntr')`)
  const row = await js<Record<string, string>>(win, `window.brain.plyntr.resolve('TESTTEST12')`)
  await js(win, `window.__brainDrive.join(${JSON.stringify(row)})`)
  const dom = await waitScreen(win, 'cli')
  noteScreen('joiner', dom)
  await js(win, `window.__brainDrive.pick('grok')`)
  await waitScreen(win, 'needs')
  await sleep(400)
  await clickStart(win)
}

async function gitCases(win: BrowserWindow): Promise<void> {
  const runs = [
    { name: 'git-exit-0-absent', absent: 'git', present: '', exit: 'git:0', id: 'git' },
    { name: 'git-exit-1-absent', absent: 'git', present: '', exit: 'git:1', id: 'git' },
    { name: 'git-exit-1-present', absent: '', present: 'git', exit: 'git:1', id: 'git' },
    { name: 'cloud-exit-0-absent', absent: 'cloudflared', present: '', exit: 'cloudflared:0', id: 'cloudflared' }
  ]
  for (const run of runs) {
    clearPretend()
    if (run.absent) process.env.BRAIN_APP_PRETEND_ABSENT = run.absent
    if (run.present) process.env.BRAIN_APP_PRETEND_PRESENT = run.present
    process.env.BRAIN_APP_PRETEND_EXIT = run.exit
    setupTrace({ event: 'run', name: run.name })
    await js(win, `window.brain.setup.install(${JSON.stringify(run.id)})`)
    await js(win, `window.brain.setup.status()`)
  }
  clearPretend()
}

async function refusedStart(win: BrowserWindow): Promise<void> {
  clearPretend()
  process.env.BRAIN_APP_PRETEND_PRESENT = 'git'
  setupTrace({ event: 'run', name: 'needs-refused' })
  await js(win, `window.__brainDrive.setChannel('local')`)
  await js(
    win,
    `window.__brainDrive.join(${JSON.stringify({
      brainId: 'local-brain',
      repo: '',
      slug: 'setup-trace-local',
      role: 'owner',
      email: 'joe@plyntr.com',
      name: 'Local'
    })})`
  )
  await waitScreen(win, 'cli')
  await js(win, `window.__brainDrive.pick('grok')`)
  await waitScreen(win, 'needs')
  await sleep(300)
  await clickStart(win)
  noteScreen('needs-refused', await waitNeedsReview(win))
}

async function signedOut(win: BrowserWindow): Promise<void> {
  await refusedStart(win)
  clearPretend()
  process.env.BRAIN_APP_PRETEND_PRESENT = 'git'
  setupTrace({ event: 'run', name: 'signed-out' })
  await js(win, `window.brain.setup.tryOpen('grok')`)
  setupTrace({ event: 'run', name: 'phone' })
  await js(win, `window.brain.phone.start()`)
  await sleep(1500)
  await js(win, `window.brain.phone.stop()`)
}

async function notConfirmed(win: BrowserWindow): Promise<void> {
  const runs = [
    { name: 'team', code: 'TEAMJOIN1', install: 'off', click: '' },
    { name: 'project', code: 'PROJJOIN1', install: 'off', click: '' },
    { name: 'project-real', code: 'PR0J3CT12X', install: 'off', click: '' },
    { name: 'pending', code: 'OWNRPEND1', install: 'off', click: '' },
    { name: 'all', code: 'TESTTEST12', install: 'all', click: '' },
    { name: 'all-repositories', code: 'TESTTEST12', install: 'all_repositories', click: '' },
    { name: 'wrong-repo', code: 'TESTTEST12', install: 'wrong-repo', click: '' },
    { name: 'owner-off', code: 'OWNRJOIN1', install: 'off', click: 'Open GitHub' }
  ]
  for (const run of runs) {
    clearPretend()
    process.env.BRAIN_APP_PRETEND_INSTALL = run.install
    setupTrace({ event: 'run', name: `plyntr-${run.name}` })
    await js(win, `window.__brainDrive.setChannel('plyntr')`)
    const row = await js<Record<string, string>>(win, `window.brain.plyntr.resolve(${JSON.stringify(run.code)})`)
    await js(win, `window.__brainDrive.join(${JSON.stringify(row)})`)
    const dom = await waitScreen(win, 'plyntr-wait')
    noteScreen(run.name, dom)
    if (run.click) {
      await js(win, `window.__brainDrive.click(${JSON.stringify(run.click)})`)
      await sleep(200)
      noteScreen(`${run.name}-after`, await readDom(win))
    }
  }
  clearPretend()
  process.env.BRAIN_APP_PRETEND_INSTALL = 'selected'
  setupTrace({ event: 'run', name: 'plyntr-project-copy' })
  await js(win, `window.__brainDrive.setChannel('plyntr')`)
  const copied = await js<{ brainId: string; role: string }>(win, `window.brain.plyntr.resolve('PR0J3CT12X')`)
  const saved = await js<boolean>(win, `window.brain.plyntr.hasSeat(${JSON.stringify(copied.brainId)})`)
  setupTrace({ event: 'seat', brainId: copied.brainId, role: copied.role, saved: saved === true })
  await js(win, `window.__brainDrive.join(${JSON.stringify(copied)})`)
  noteScreen('project-copy', await waitScreen(win, 'cli'))
  clearPretend()
  process.env.BRAIN_APP_PRETEND_INSTALL = 'missing'
  setupTrace({ event: 'run', name: 'plyntr-missing-selection' })
  await js(win, `window.__brainDrive.setChannel('plyntr')`)
  const row = await js<Record<string, string>>(win, `window.brain.plyntr.resolve('TESTTEST12')`)
  await js(win, `window.__brainDrive.join(${JSON.stringify(row)})`)
  noteScreen('missing-selection', await waitScreen(win, 'cli'))
  clearPretend()
}

async function agency(win: BrowserWindow): Promise<void> {
  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'app-off'
  setupTrace({ event: 'run', name: 'agency-owner-draft' })
  await js(win, `window.__brainDrive.agency('owner')`)
  noteScreen('agency-owner-chat', await waitButton(win, 'Continue'))
  await js(win, `window.__brainDrive.click('Continue')`)
  await sleep(500)
  noteScreen('agency-owner', await readDom(win))
  await js(win, `window.__brainDrive.click('Open GitHub')`)
  await sleep(200)

  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'app-off'
  process.env.BRAIN_APP_PRETEND_NO_CLI = '1'
  setupTrace({ event: 'run', name: 'agency-owner-nocli' })
  await js(win, `window.__brainDrive.agency('owner')`)
  noteScreen('agency-owner-nocli', await waitScreen(win, 'cli'))

  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'app-off'
  setupTrace({ event: 'run', name: 'agency-team' })
  await js(win, `window.__brainDrive.agency('team')`)
  await sleep(300)
  noteScreen('agency-team', await readDom(win))
  process.env.BRAIN_APP_PRETEND_AGENCY = 'bridge-on'
  await js(win, `window.__brainDrive.click('Check again')`)
  let teamAfter = blankDom()
  for (let i = 0; i < 40; i++) {
    teamAfter = await readDom(win)
    if (teamAfter.screen === 'needs') break
    await sleep(150)
  }
  noteScreen('agency-team-after', teamAfter)

  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'bridge-off'
  setupTrace({ event: 'run', name: 'agency-bridge-off' })
  await js(win, `window.__brainDrive.agency('owner')`)
  await waitButton(win, 'Continue')
  await js(win, `window.__brainDrive.click('Continue')`)
  await sleep(500)
  noteScreen('agency-bridge-off', await readDom(win))

  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'bridge-on'
  setupTrace({ event: 'run', name: 'agency-bridge-on' })
  await js(win, `window.__brainDrive.agency('owner')`)
  await waitButton(win, 'Continue')
  await js(win, `window.__brainDrive.click('Continue')`)
  await waitScreen(win, 'needs')
  await clickStart(win)
  noteScreen('agency-bridge-on', await readDom(win))
  clearPretend()
  process.env.BRAIN_APP_PRETEND_ABSENT = 'claude'
  process.env.BRAIN_APP_PRETEND_EXIT = 'claude:0'
  setupTrace({ event: 'run', name: 'needs-agency-cli' })
  await js(win, `window.__brainDrive.bareNeeds()`)
  await waitScreen(win, 'needs')
  const pickedClaude = await js<boolean>(
    win,
    `new Promise((resolve) => {
      let n = 0
      const tick = () => {
        const el = document.querySelectorAll('[data-setup-screen="needs"] input[name="setup-cli"]')[1]
        if (el) { el.click(); resolve(true); return }
        if (++n > 40) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })`
  )
  if (!pickedClaude) throw new Error('The Claude radio was not on the agency needs panel.')
  await sleep(300)
  await clickStart(win)
  clearPretend()
}

async function ownerCreate(win: BrowserWindow): Promise<void> {
  clearPretend()
  setupTrace({ event: 'run', name: 'owner-create' })
  const row = {
    createId: 'owner-create',
    wizardStep: 6,
    label: 'Setup trace',
    org: 'setup-trace',
    slug: 'setup-trace-owner',
    scoutEmail: 'joe@plyntr.com',
    brainId: 'dry-brain'
  }
  await js(win, `window.__brainDrive.create(${JSON.stringify(row)})`)
  await waitScreen(win, 'plyntr-create')
  let draft = ''
  for (let i = 0; i < 40 && !draft; i++) {
    draft = await js<string>(win, `window.__setupDraft || ''`)
    if (!draft) await sleep(150)
  }
  const dom = await readDom(win)
  noteScreen('owner-create', dom)
  if (!draft) throw new Error('The company draft was not created.')
  writeFileSync(join(draft, 'context', 'new-from-draft.md'), 'from the draft\n')
  writeFileSync(join(draft, 'context', 'TEMPLATE-business.md'), 'draft bytes\n')
  mkdirSync(join(draft, 'skills'), { recursive: true })
  writeFileSync(join(draft, 'skills', 'skip.md'), 'do not copy\n')
  mkdirSync(join(draft, '.grok'), { recursive: true })
  writeFileSync(join(draft, '.grok', 'skip.md'), 'do not copy\n')
  mkdirSync(join(draft, '.team-config'), { recursive: true })
  writeFileSync(join(draft, '.team-config', 'skip.md'), 'do not copy\n')
  const applied = await js<{ brainPath?: string }>(
    win,
    `window.brain.setup.putFolderPlyntr({ brainId: 'dry-brain', org: 'setup-trace', slug: 'setup-trace-owner', repo: 'setup-trace/setup-trace-owner-brain' })`
  )
  const clone = String(applied?.brainPath || '')
  if (!clone) throw new Error('The company copy did not return a folder.')
  writeFileSync(join(clone, 'context', 'TEMPLATE-business.md'), 'clone differs\n')
  writeFileSync(join(draft, 'context', 'leave.md'), 'draft leave\n')
  mkdirSync(join(clone, 'context'), { recursive: true })
  writeFileSync(join(clone, 'context', 'leave.md'), 'clone leave\n')
  await js(win, `window.brain.setup.mergeDraft(${JSON.stringify(draft)}, ${JSON.stringify(clone)})`)
  const copied = readFileSync(join(clone, 'context', 'new-from-draft.md'), 'utf8')
  const left = readFileSync(join(clone, 'context', 'TEMPLATE-business.md'), 'utf8')
  const leave = readFileSync(join(clone, 'context', 'leave.md'), 'utf8')
  setupTrace({
    event: 'plants',
    draft,
    clone,
    copied,
    left,
    leave,
    skills: existsSync(join(clone, 'skills', 'skip.md')),
    grok: existsSync(join(clone, '.grok', 'skip.md')),
    teamConfig: existsSync(join(clone, '.team-config', 'skip.md'))
  })
  await js(
    win,
    `window.brain.setup.explain(${JSON.stringify({ heading: 'Copy the folder', kinds: ['grok'], strip: false, cwd: clone })})`
  )
}

async function localOnly(win: BrowserWindow): Promise<void> {
  clearPretend()
  setupTrace({ event: 'run', name: 'local' })
  await js(win, `window.__brainDrive.setChannel('local')`)
  await js(
    win,
    `window.__brainDrive.join(${JSON.stringify({
      brainId: 'local-brain',
      repo: '',
      slug: 'setup-trace-local',
      role: 'owner',
      email: 'joe@plyntr.com',
      name: 'Local'
    })})`
  )
  const dom = await waitScreen(win, 'cli')
  noteScreen('local', dom)
  await js(win, `window.__brainDrive.pick('grok')`)
  await waitScreen(win, 'needs')
  await sleep(300)
  await js(win, `window.brain.setup.install('cloudflared')`)
  await clickStart(win)
}

async function brewMissing(win: BrowserWindow): Promise<void> {
  clearPretend()
  process.env.BRAIN_APP_PRETEND_ABSENT = 'brew'
  process.env.BRAIN_APP_PRETEND_EXIT = 'brew:0'
  setupTrace({ event: 'run', name: 'needs-brew' })
  await js(win, `window.__brainDrive.bareNeeds()`)
  await waitScreen(win, 'needs')
  const picked = await js<boolean>(
    win,
    `new Promise((resolve) => {
      let n = 0
      const tick = () => {
        const el = document.querySelectorAll('[data-setup-screen="needs"] input[name="setup-cli"]')[0]
        if (el) { el.click(); resolve(true); return }
        if (++n > 40) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })`
  )
  if (!picked) throw new Error('The Grok radio was not on the needs panel.')
  await sleep(300)
  await clickStart(win)
  clearPretend()
}

async function ownerRetry(win: BrowserWindow): Promise<void> {
  clearPretend()
  process.env.BRAIN_APP_PRETEND_AGENCY = 'app-off'
  process.env.BRAIN_APP_PRETEND_SIGNED_OUT = '1'
  setupTrace({ event: 'run', name: 'agency-owner-retry' })
  await js(win, `window.__brainDrive.agency('owner')`)
  noteScreen('agency-owner-retry-needs', await waitScreen(win, 'needs'))
  delete process.env.BRAIN_APP_PRETEND_SIGNED_OUT
  await clickStart(win)
  noteScreen('agency-owner-retry', await readDom(win))
  clearPretend()
}

async function unpicked(win: BrowserWindow): Promise<void> {
  clearPretend()
  process.env.BRAIN_APP_PRETEND_ABSENT = 'git'
  process.env.BRAIN_APP_PRETEND_EXIT = 'git:0'
  setupTrace({ event: 'run', name: 'needs-unpicked' })
  await js(win, `window.__brainDrive.bareNeeds()`)
  await waitScreen(win, 'needs')
  await sleep(500)
  await clickStart(win)
  noteScreen('needs-unpicked', await waitNeedsReview(win))
  clearPretend()
}

async function radioChoice(win: BrowserWindow): Promise<void> {
  clearPretend()
  setupTrace({ event: 'run', name: 'needs-radio' })
  await js(win, `window.__brainDrive.bareNeeds()`)
  await waitScreen(win, 'needs')
  const picked = await js<boolean>(
    win,
    `new Promise((resolve) => {
      let n = 0
      const tick = () => {
        const el = document.querySelectorAll('[data-setup-screen="needs"] input[name="setup-cli"]')[1]
        if (el) { el.click(); resolve(true); return }
        if (++n > 40) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })`
  )
  if (!picked) throw new Error('The Claude radio was not on the needs panel.')
  await sleep(400)
  noteScreen('needs-radio', await readDom(win))
}

async function pretendOff(win: BrowserWindow): Promise<void> {
  setupTrace({ event: 'run', name: 'pretend-off' })
  const drive = process.env.BRAIN_APP_SETUP_DRIVE
  try {
    delete process.env.BRAIN_APP_SETUP_DRIVE
    process.env.BRAIN_APP_PRETEND_AGENCY = 'bridge-on'
    process.env.BRAIN_APP_PRETEND_INSTALL = 'all'
    process.env.BRAIN_APP_PRETEND_ABSENT = 'git'
    process.env.BRAIN_APP_PRETEND_EXIT = 'git:0'
    await js(win, `window.brain.setup.putFolder({ teamSlug: 'pretend-off', org: 'agency' })`)
    await js(win, `window.brain.setup.install('git')`)
    const installed = await js<{ repositorySelection?: string }>(
      win,
      `window.brain.plyntr.installed('pretend-off', 'agency/example-brain')`
    )
    setupTrace({ event: 'install-read', selection: String(installed?.repositorySelection || '') })
    const join = await js<{ ok: boolean; role?: string }>(
      win,
      `window.brain.plyntr.resolve('TEAMJOIN1').then((row) => ({ ok: true, role: row.role })).catch(() => ({ ok: false, role: '' }))`
    )
    setupTrace({ event: 'join-off', ok: join.ok === true, role: String(join.role || '') })
  } finally {
    if (drive) process.env.BRAIN_APP_SETUP_DRIVE = drive
    clearPretend()
  }
}

export async function runSetupDrive(win: BrowserWindow): Promise<void> {
  try {
    await boot(win)
    if (process.env.BRAIN_APP_SETUP_RUN === 'signed-out') await signedOut(win)
    else {
      await localOnly(win)
      await joiner(win)
      await gitCases(win)
      await notConfirmed(win)
      await agency(win)
      await ownerCreate(win)
      await ownerRetry(win)
      await brewMissing(win)
      await unpicked(win)
      await radioChoice(win)
      await pretendOff(win)
    }
    setupTrace({ event: 'drive-done', ok: true })
    app.exit(0)
  } catch (err) {
    setupTrace({ event: 'drive-done', ok: false, detail: String((err as Error).message || err) })
    app.exit(1)
  }
}
