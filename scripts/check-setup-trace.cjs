const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } = require('node:fs')
const { homedir, userInfo } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const root = join(__dirname, '..')
const runRoot = join('/tmp', `brain-setup-check-${process.pid}`)
const tracePath = join(userInfo().homedir, 'Library/Application Support/brain-app/setup-trace.jsonl')
const stub = join(runRoot, 'setup-cloudflared-stub')
const banned = [
  'send mail',
  'send an email',
  'send email',
  'change google ads',
  'change the ads',
  'install the github app',
  'install a github app',
  'install github'
]

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function lines() {
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function slice(name) {
  const all = lines()
  const start = all.findIndex((row) => row.event === 'run' && row.name === name)
  if (start < 0) fail(`missing run ${name}`)
  let end = all.findIndex((row, i) => i > start && row.event === 'run')
  if (end < 0) end = all.length
  return all.slice(start, end)
}

function writeStub() {
  mkdirSync(join(stub, '..'), { recursive: true })
  writeFileSync(stub, '#!/bin/bash\necho "https://setup-check.trycloudflare.com"\necho "Registered tunnel connection"\nsleep 30\n')
  chmodSync(stub, 0o755)
}

function runElectron(extra) {
  const env = {
    ...process.env,
    BRAIN_APP_SETUP_TRACE: '1',
    BRAIN_APP_SETUP_DRIVE: '1',
    BRAIN_APP_SETUP_ROOT: runRoot,
    BRAIN_APP_PRETEND_JOIN: '1',
    CLOUDFLARED_BIN: stub,
    ...extra
  }
  const cmd = 'npm'
  const args = ['run', 'dev']
  const before = existsSync(tracePath) ? lines().filter((row) => row.event === 'drive-done').length : 0
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('setup drive timed out'))
    }, 360000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const done = existsSync(tracePath) ? lines().filter((row) => row.event === 'drive-done').length : 0
      if (done <= before) reject(new Error(`drive exited ${code} without a new done line\n${out.slice(-2000)}`))
      else resolve(code)
    })
  })
}

function assertPrompt(row) {
  const text = String(row.text || '')
  if (!text.includes('Explain this step.')) fail(`prompt missing the step sentence: ${text}`)
  const low = text.toLowerCase()
  for (const phrase of banned) {
    if (low.includes(phrase)) fail(`prompt contains ${phrase}`)
  }
  if (row.appTools && row.appTools.length) fail('appTools was not empty')
  if (String(row.cwd || '').includes('setup-drafts')) fail(`warm cwd is under setup-drafts: ${row.cwd}`)
}

async function bundle() {
  const mod = await import(pathToFileURL(join(root, 'src/shared/setup-guide.ts')).href)
  const bad = [
    [[{ from: 'resources', filter: ['*/'] }], 'resources/bin/cloudflared'],
    [['resources/*/'], 'resources/bin/cloudflared'],
    [['pack-extra/*/'], 'pack-extra/cloudflared'],
    [[{ from: 'pack-extra', filter: ['*/'] }], 'pack-extra/cloudflared']
  ]
  for (const [entries, file] of bad) {
    if (!mod.packShipsFile(entries, file)) fail(`bundle check missed ${file}`)
  }
  const yaml = require(join(root, 'node_modules/js-yaml'))
  const doc = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
  const real = []
    .concat(doc.files || [])
    .concat(doc.extraResources || [])
    .concat(doc.extraFiles || [])
  if (real.some((entry) => /cloudflared/i.test(JSON.stringify(entry)))) fail('electron-builder.yml names cloudflared')
  if (mod.packShipsFile(real, 'resources/bin/cloudflared')) fail('the real pack list would ship cloudflared')
  if (mod.packShipsFile(real, 'pack-extra/cloudflared')) fail('the real pack list would ship cloudflared')
}

function check() {
  const joiner = slice('joiner')
  const watchers = joiner.filter((row) => row.event === 'watcher')
  if (watchers.length !== 1 || watchers[0].fn !== 'startBrainSync') fail(`joiner watchers ${JSON.stringify(watchers)}`)
  const prompts = joiner.filter((row) => row.event === 'prompt')
  if (!prompts.some((row) => row.kind === 'grok')) fail('joiner did not prompt Grok')
  prompts.forEach(assertPrompt)
  const opened = joiner.filter((row) => row.event === 'chat-open' && row.opened === true)
  if (!opened.length) fail('joiner chat did not open')
  for (const row of opened) {
    if (row.signedIn !== true || row.git !== true) fail('opened chat without both booleans')
    if (!String(row.model || '').trim() || !String(row.effort || '').trim()) fail('chat opened without Model and Effort')
    if (!String(row.folder || '').includes('plyntr-fixture-brain')) fail(`chat-open folder ${row.folder}`)
  }
  for (const row of prompts) {
    if ((row.kind === 'grok' || row.kind === 'cursor') && row.sendsAppTools !== true) fail(`${row.kind} did not send appTools`)
    if ((row.kind === 'claude' || row.kind === 'gpt') && row.sendsAppTools !== false) fail(`${row.kind} sent appTools`)
  }
  const phone = lines().find((row) => row.event === 'phone')
  if (!phone || phone.mode !== 'quick' || phone.host !== 'setup-check.trycloudflare.com') fail(`phone ${JSON.stringify(phone)}`)
  if (phone.host === 'brain-phone.plyntr.com') fail('phone used the named host')

  for (const name of ['git-exit-0-absent', 'git-exit-1-absent']) {
    const rows = slice(name)
    const install = rows.find((row) => row.event === 'install' && row.id === 'git')
    if (!install || install.ok !== false || install.presentAfter !== false) fail(`${name} install ${JSON.stringify(install)}`)
    const needs = rows.find((row) => row.event === 'needs')
    if (!needs || needs.ready !== false || needs.git !== false) fail(`${name} needs ${JSON.stringify(needs)}`)
    if (rows.some((row) => row.event === 'chat-open')) fail(`${name} opened chat`)
  }
  const present = slice('git-exit-1-present').find((row) => row.event === 'install' && row.id === 'git')
  if (!present || present.ok !== true || present.presentAfter !== true) fail(`git present install ${JSON.stringify(present)}`)
  const cloud = slice('cloud-exit-0-absent').find((row) => row.event === 'install' && row.id === 'cloudflared')
  if (!cloud || cloud.ok !== false || cloud.presentAfter !== false) fail(`cloudflared install ${JSON.stringify(cloud)}`)

  const signed = slice('signed-out').find((row) => row.event === 'chat-open')
  if (!signed || signed.signedIn !== false || signed.git !== true || signed.opened !== false) {
    fail(`signed-out ${JSON.stringify(signed)}`)
  }

  for (const name of ['team', 'project', 'project-real', 'pending']) {
    const screen = slice(`plyntr-${name}`).find((row) => row.event === 'screen')
    if (!screen || screen.screen !== 'plyntr-wait') fail(`${name} screen ${JSON.stringify(screen)}`)
    if (JSON.stringify(screen.buttons) !== JSON.stringify(['Check again'])) fail(`${name} buttons ${screen.buttons}`)
    if (['cli', 'needs', 'aiwork', 'plyntr-create'].includes(screen.screen)) fail(`${name} reached ${screen.screen}`)
  }
  for (const name of ['all', 'all-repositories', 'wrong-repo']) {
    const screen = slice(`plyntr-${name}`).find((row) => row.event === 'screen')
    if (!screen || screen.screen !== 'plyntr-wait') fail(`${name} screen ${JSON.stringify(screen)}`)
    if (screen.buttons.join('|') !== 'Open GitHub|Check GitHub') fail(`${name} buttons ${screen.buttons}`)
  }
  const owner = slice('plyntr-owner-off')
  const ownerScreen = owner.find((row) => row.event === 'screen')
  if (!ownerScreen || ownerScreen.buttons.join('|') !== 'Open GitHub|Check GitHub') fail(`owner buttons ${JSON.stringify(ownerScreen)}`)
  if (!owner.some((row) => row.event === 'ipc' && row.channel === 'setup:openPlyntrInstall')) fail('owner click did not record openPlyntrInstall')
  const after = owner.find((row) => row.event === 'screen' && row.run === 'owner-off-after')
  if (!after || ['cli', 'needs', 'aiwork', 'plyntr-create'].includes(after.screen)) fail(`owner moved to ${after && after.screen}`)
  const missing = slice('plyntr-missing-selection').find((row) => row.event === 'screen')
  if (!missing || missing.screen !== 'cli') fail(`missing selection ${JSON.stringify(missing)}`)

  const draft = slice('agency-owner-draft')
  if (draft.some((row) => row.event === 'agency' && row.handler === 'setup:putFolder')) {
    fail('agency owner copied the folder before both checks passed')
  }
  if (!draft.some((row) => row.event === 'agency' && row.handler === 'setup:pollInstall' && row.app === false)) {
    fail('agency owner did not read the GitHub app before copying')
  }
  if (!draft.some((row) => row.event === 'agency' && row.handler === 'setup:bridgeOnRepo')) {
    fail('agency owner did not read Brain Bridge before copying')
  }
  const draftChat = draft.find((row) => row.event === 'chat-open')
  if (!draftChat || draftChat.opened !== true || !String(draftChat.folder || '').includes('setup-drafts')) {
    fail(`agency owner draft chat ${JSON.stringify(draftChat)}`)
  }
  const chatScreen = draft.find((row) => row.event === 'screen' && row.screen === 'chat')
  if (!chatScreen || !chatScreen.buttons.includes('Continue')) fail('agency owner chat has no Continue button')
  if (!String(chatScreen.model || '').trim() || !String(chatScreen.effort || '').trim()) {
    fail(`chat screen lost Model or Effort ${JSON.stringify(chatScreen)}`)
  }
  const verify = draft.find((row) => row.event === 'screen' && row.run === 'agency-owner')
  if (!verify || verify.screen !== 'github-verify' || verify.buttons.join('|') !== 'Open GitHub') {
    fail(`agency owner screen ${JSON.stringify(verify)}`)
  }
  if (!draft.some((row) => row.event === 'ipc' && row.channel === 'setup:openAppInstall')) fail('owner Open GitHub was not recorded')

  const team = slice('agency-team').find((row) => row.event === 'screen')
  if (!team || team.screen !== 'github-verify' || JSON.stringify(team.buttons) !== JSON.stringify(['Check again'])) {
    fail(`agency team ${JSON.stringify(team)}`)
  }
  if (slice('agency-team').some((row) => row.event === 'ipc')) fail('team recorded an install click')
  const teamRows = slice('agency-team')
  const teamCopies = teamRows.filter((row) => row.event === 'agency' && row.handler === 'setup:putFolder')
  if (teamCopies.length < 2 || teamCopies[0].copy !== false || teamCopies[teamCopies.length - 1].copy !== true) {
    fail(`team copy ${JSON.stringify(teamCopies)}`)
  }
  const teamAfter = teamRows.find((row) => row.run === 'agency-team-after')
  if (!teamAfter || teamAfter.screen !== 'needs' || teamAfter.role !== 'team') {
    fail(`team continue ${JSON.stringify(teamAfter)}`)
  }
  if (teamRows.some((row) => row.event === 'chat-open' && String(row.folder || '').includes('setup-drafts'))) {
    fail('team continued as the owner draft')
  }

  const nocli = slice('agency-owner-nocli')
  if (nocli.some((row) => row.event === 'agency' && row.handler === 'setup:putFolder')) {
    fail('owner with no CLI copied the folder')
  }
  const nocliScreen = nocli.find((row) => row.event === 'screen')
  if (!nocliScreen || nocliScreen.screen !== 'cli' || nocliScreen.role !== 'owner') {
    fail(`owner with no CLI ${JSON.stringify(nocliScreen)}`)
  }
  if (!nocli.some((row) => row.event === 'draft')) fail('owner with no CLI did not keep a draft')
  if (!String(nocliScreen.path || '').includes('setup-drafts')) fail(`owner with no CLI path ${nocliScreen.path}`)

  const projectCopy = slice('plyntr-project-copy')
  const seat = projectCopy.find((row) => row.event === 'seat')
  if (!seat || seat.saved !== true || seat.role !== 'project' || seat.brainId !== 'project-real') {
    fail(`project seat ${JSON.stringify(seat)}`)
  }
  const projectScreen = projectCopy.find((row) => row.event === 'screen')
  if (!projectScreen || projectScreen.screen !== 'cli' || projectScreen.role !== 'project') {
    fail(`project copy screen ${JSON.stringify(projectScreen)}`)
  }
  const projectWatch = projectCopy.filter((row) => row.event === 'watcher')
  if (projectWatch.length !== 1 || projectWatch[0].fn !== 'startBrainSync') {
    fail(`project copy watchers ${JSON.stringify(projectWatch)}`)
  }

  const refused = slice('needs-refused')
  const review = refused.find((row) => row.event === 'screen')
  if (
    !review ||
    review.screen !== 'needs' ||
    review.h1 !== 'One setup, then Chat.' ||
    review.primaryDisabled !== false ||
    !String(review.primary || '').includes('Start setup') ||
    !String(review.path || '').includes('setup-trace-local')
  ) {
    fail(`refused start ${JSON.stringify(review)}`)
  }
  const refusedOpen = refused.find((row) => row.event === 'chat-open')
  if (!refusedOpen || refusedOpen.opened !== false || !String(refusedOpen.folder || '').includes('setup-trace-local')) {
    fail(`refused open ${JSON.stringify(refusedOpen)}`)
  }

  const off = slice('pretend-off')
  if (off.some((row) => row.event === 'agency')) fail('pretend ran with the drive flag off')
  const offGit = off.find((row) => row.event === 'install' && row.id === 'git')
  if (!offGit || offGit.ok !== true || offGit.presentAfter !== true) fail(`off-drive git ${JSON.stringify(offGit)}`)
  const offInstall = off.find((row) => row.event === 'install-read')
  if (!offInstall || offInstall.selection !== 'selected') fail(`off-drive install ${JSON.stringify(offInstall)}`)

  const unpicked = slice('needs-unpicked').find((row) => row.event === 'screen')
  if (
    !unpicked ||
    unpicked.screen !== 'needs' ||
    unpicked.h1 !== 'One setup, then Chat.' ||
    unpicked.primaryDisabled !== false ||
    !String(unpicked.primary || '').includes('Start setup') ||
    unpicked.radios !== 4
  ) {
    fail(`unpicked start ${JSON.stringify(unpicked)}`)
  }
  if (slice('needs-unpicked').some((row) => row.event === 'chat-open')) fail('unpicked start opened chat')
  if (slice('needs-unpicked').some((row) => row.event === 'install')) fail('unpicked start installed a tool')

  const radio = slice('needs-radio')
  const radioScreen = radio.find((row) => row.event === 'screen')
  if (!radioScreen || radioScreen.model !== 'Claude') fail(`radio model ${JSON.stringify(radioScreen)}`)
  if (!radio.some((row) => row.event === 'needs' && row.picked === 'claude')) fail('radio did not drive the needs check')

  const agencyCli = slice('needs-agency-cli')
  const agencyNeeds = agencyCli.find((row) => row.event === 'needs' && row.picked === 'claude')
  if (!agencyNeeds || agencyNeeds.mode === 'local' || agencyNeeds.mode === 'plyntr' || agencyNeeds.ready !== false) {
    fail(`agency needs ${JSON.stringify(agencyNeeds)}`)
  }
  if (!agencyCli.some((row) => row.event === 'install' && row.id === 'claude')) {
    fail('agency start skipped the selected CLI')
  }
  if (agencyCli.some((row) => row.event === 'chat-open' && row.opened === true)) {
    fail('agency opened chat without the selected CLI')
  }

  const retry = slice('agency-owner-retry')
  if (retry.some((row) => row.event === 'agency' && row.handler === 'setup:putFolder')) fail('owner retry copied before both checks')
  if (retry.some((row) => row.event === 'screen' && row.screen === 'bridge')) fail('owner retry stopped on Brain Bridge')
  const retryOpen = retry.filter((row) => row.event === 'chat-open' && row.opened === true)
  if (!retryOpen.length || retryOpen.some((row) => !String(row.folder || '').includes('setup-drafts'))) {
    fail(`owner retry chat ${JSON.stringify(retryOpen)}`)
  }
  const retryChat = retry.find((row) => row.event === 'screen' && row.run === 'agency-owner-retry')
  if (!retryChat || retryChat.screen !== 'chat' || !retryChat.buttons.includes('Continue') || !String(retryChat.path || '').includes('setup-drafts')) {
    fail(`owner retry screen ${JSON.stringify(retryChat)}`)
  }

  const brew = slice('needs-brew')
  if (!brew.some((row) => row.event === 'install' && row.id === 'brew')) fail('missing Homebrew was skipped')
  if (brew.some((row) => row.event === 'chat-open' && row.opened === true)) fail('chat opened while Homebrew was missing')

  const joinOff = off.find((row) => row.event === 'join-off')
  if (!joinOff || joinOff.ok !== false) fail(`pretend join off-drive ${JSON.stringify(joinOff)}`)

  const bridgeOff = slice('agency-bridge-off')
  if (bridgeOff.some((row) => row.event === 'agency' && row.handler === 'setup:putFolder')) {
    fail('bridge-off copied the folder before Brain Bridge passed')
  }
  const bridgeScreen = bridgeOff.find((row) => row.event === 'screen' && row.screen === 'bridge')
  if (!bridgeScreen) fail(`bridge-off ${JSON.stringify(bridgeOff.filter((row) => row.event === 'screen'))}`)
  if (bridgeOff.some((row) => row.event === 'chat-open' && row.opened === true && !String(row.folder || '').includes('setup-drafts'))) {
    fail('bridge-off opened chat on the shared folder')
  }

  const bridgeOn = slice('agency-bridge-on')
  const bridgeLanded = bridgeOn.find((row) => row.event === 'screen')
  if (!bridgeLanded || bridgeLanded.screen === 'bridge' || bridgeLanded.screen === 'github-verify') {
    fail(`bridge-on landed on ${bridgeLanded && bridgeLanded.screen}`)
  }
  const bridgeWatch = bridgeOn.filter((row) => row.event === 'watcher')
  if (bridgeWatch.length !== 1) fail(`bridge-on watchers ${JSON.stringify(bridgeWatch)}`)
  if (!bridgeOn.some((row) => row.event === 'agency' && row.handler === 'setup:putFolder' && row.copy === true)) {
    fail('bridge-on did not copy after both checks')
  }
  if (!bridgeOn.some((row) => row.event === 'chat-open' && row.opened === true && String(row.folder || '').includes('setup-trace-agency-brain'))) {
    fail('bridge-on did not open chat on the copied folder')
  }

  const ownerCreate = slice('owner-create')
  const draftRow = ownerCreate.find((row) => row.event === 'draft')
  if (!draftRow || draftRow.sync !== false || draftRow.remote !== false || !String(draftRow.path).includes('setup-drafts')) {
    fail(`draft ${JSON.stringify(draftRow)}`)
  }
  const strip = ownerCreate.find((row) => row.event === 'strip')
  if (!strip || !strip.heading) fail('missing strip')
  const other = ownerCreate.filter((row) => row.event === 'prompt' && ['claude', 'cursor', 'gpt'].includes(row.kind))
  if (other.length < 3) fail(`strip prompts ${other.length}`)
  for (const row of other) {
    assertPrompt(row)
    if (!String(row.text).includes(strip.heading)) fail('prompt missing the strip heading')
    if ((row.kind === 'claude' || row.kind === 'gpt') && row.sendsAppTools !== false) fail(`${row.kind} sent appTools`)
  }
  const cursorPrompt = ownerCreate.find((row) => row.event === 'prompt' && row.kind === 'cursor')
  if (!cursorPrompt || cursorPrompt.sendsAppTools !== true) fail('cursor prompt did not send appTools')
  const plants = ownerCreate.find((row) => row.event === 'plants')
  if (!plants) fail('missing plants')
  if (plants.copied !== 'from the draft\n') fail(`new file ${plants.copied}`)
  if (plants.left !== 'clone differs\n') fail(`clone file was overwritten ${plants.left}`)
  if (plants.leave !== 'clone leave\n') fail(`leave file changed ${plants.leave}`)
  if (plants.skills || plants.grok || plants.teamConfig) fail('skipped trees were copied')
  if (!readFileSync(join(plants.clone, 'context', 'new-from-draft.md'), 'utf8').includes('from the draft')) {
    fail('clone is missing the draft-only file')
  }
  const ownerWatch = ownerCreate.filter((row) => row.event === 'watcher')
  if (ownerWatch.length !== 1 || ownerWatch[0].fn !== 'startBrainSync') fail(`owner watchers ${JSON.stringify(ownerWatch)}`)

  const local = slice('local')
  const localScreen = local.find((row) => row.event === 'screen')
  if (!localScreen || localScreen.screen !== 'cli') fail(`local screen ${JSON.stringify(localScreen)}`)
  const localRow = local.find((row) => row.event === 'local')
  if (!localRow || !localRow.brainPath) fail(`local folder ${JSON.stringify(localRow)}`)
  if (local.some((row) => row.event === 'watcher')) fail('local started a watcher')
  if (!local.some((row) => row.event === 'chat-open' && row.opened === true)) fail('local chat did not open')
  if (!local.some((row) => row.event === 'install' && row.id === 'cloudflared')) fail('local did not install Cloudflare Tunnel')
  if (local.some((row) => row.event === 'draft')) fail('local created a draft')

  const done = lines().filter((row) => row.event === 'drive-done')
  if (!done.length || done.some((row) => row.ok === false)) fail(`drive ${JSON.stringify(done)}`)
}

function cleanup() {
  rmSync(runRoot, { recursive: true, force: true })
}

async function main() {
  mkdirSync(runRoot, { recursive: true })
  writeStub()
  writeFileSync(tracePath, '')
  try {
    await runElectron({})
    const home = join('/tmp', 'brain-setup-signed-out-home')
    mkdirSync(home, { recursive: true })
    await runElectron({ HOME: home, BRAIN_APP_SETUP_RUN: 'signed-out', BRAIN_APP_PRETEND_PRESENT: 'git' })
    await bundle()
    check()
    console.log('setup-trace ok')
  } finally {
    cleanup()
  }
}

main().catch((err) => fail(String(err && err.stack ? err.stack : err)))
