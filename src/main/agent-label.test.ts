import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { agentInCommand, handoffFromTitle, handoffLabel, skinActivity, skinPulseLabel } from '../shared/agent-label.ts'

test('a Grok, Claude, Cursor, or Codex shell call names the AI, model, and effort', () => {
  assert.equal(agentInCommand('~/.grok/bin/grok --model grok-4.6 --effort xhigh --permission-mode plan -p "x"'), 'Grok 4.6 (xhigh)')
  assert.equal(agentInCommand('cd /x && grok -p "review" --model grok-4.7'), 'Grok 4.7')
  assert.equal(agentInCommand('command claude -p --model opus --effort medium --permission-mode plan "x"'), 'Claude Opus (medium)')
  assert.equal(agentInCommand('cursor-agent -p "x" --model gpt-5.6'), 'Cursor gpt-5.6')
  assert.equal(agentInCommand('codex exec "x"'), 'GPT (Codex)')
})

test('ordinary commands and words are not handoffs', () => {
  assert.equal(agentInCommand('npm run typecheck'), '')
  assert.equal(agentInCommand('cat grok-notes.md'), '')
  assert.equal(agentInCommand('claude --version'), '')
  assert.equal(agentInCommand('grep -rn claude src'), '')
  assert.equal(handoffLabel('Read', { file_path: '/x' }), null)
  assert.equal(handoffLabel('Bash', { command: 'ls' }), null)
})

test('Claude tool calls become plain handoff labels', () => {
  assert.equal(handoffLabel('Bash', { command: 'grok --model grok-4.6 --effort xhigh -p "x"' }), 'Asking Grok 4.6 (xhigh)')
  assert.equal(handoffLabel('Bash', { command: 'grok --model grok-4.6 --effort xhigh -p "x"', run_in_background: true }), 'Started in the background: asking Grok 4.6 (xhigh)')
  assert.equal(handoffLabel('Bash', { command: 'sleep 60', run_in_background: true, description: 'Wait for deploy' }), 'Started in the background: Wait for deploy')
  assert.equal(handoffLabel('Task', { description: 'Search the repo', subagent_type: 'Explore' }), 'Subagent: Search the repo')
  assert.equal(handoffLabel('Agent', { subagent_type: 'Plan' }), 'Subagent: Plan')
  assert.equal(handoffLabel('SendMessage', { to: 'researcher' }), 'Messaging researcher')
})

test('Grok ACP titles with a handoff command read as Asking', () => {
  assert.equal(handoffFromTitle('Run command grok -p "x" --model grok-4.6 --effort xhigh'), 'Asking Grok 4.6 (xhigh)')
  assert.equal(handoffFromTitle('Read file src/a.ts'), null)
})

test('skin keeps handoffs and hides raw tool names', () => {
  assert.equal(skinPulseLabel('Asking Grok 4.6 (xhigh)'), 'Asking Grok 4.6 (xhigh)')
  assert.equal(skinPulseLabel('Started in the background: asking Claude Opus (low)'), 'Started in the background: asking Claude Opus (low)')
  assert.equal(skinPulseLabel('Subagent: Search the repo'), 'Subagent: Search the repo')
  assert.equal(skinPulseLabel('Messaging researcher'), 'Messaging researcher')
  assert.equal(skinPulseLabel('Picking up background results'), 'Picking up background results')
  assert.equal(skinPulseLabel('In the background: asking Grok 4.6 (xhigh)'), 'In the background: asking Grok 4.6 (xhigh)')
  assert.equal(skinPulseLabel('Thinking'), 'Thinking')
  assert.equal(skinPulseLabel('Writing'), 'Writing')
  assert.equal(skinPulseLabel('Compacting'), 'Compacting')
  assert.equal(skinPulseLabel('Bash'), 'Working')
  assert.equal(skinPulseLabel('Read'), 'Working')
  assert.equal(skinPulseLabel('Read file src/a.ts'), 'Working')
})

test('skin shows one pulse for a busy handoff, an idle background task, or nothing', () => {
  const now = 1_700_000_000_000
  const busy = skinActivity({
    busy: true,
    waitLabel: 'Asking Grok 4.6 (xhigh)',
    waitSec: 4,
    bgTasks: [{ label: 'Started in the background: asking Claude Opus (low)', at: now - 1000 }],
    now
  })
  assert.equal(busy.show, true)
  if (busy.show) {
    assert.equal(busy.label, 'Asking Grok 4.6 (xhigh)')
    assert.equal(busy.seconds, 4)
  }
  const idle = skinActivity({
    busy: false,
    waitLabel: 'Working',
    waitSec: 0,
    bgTasks: [{ label: 'Started in the background: asking Grok 4.6 (xhigh)', at: now - 90000 }],
    now
  })
  assert.equal(idle.show, true)
  if (idle.show) {
    assert.equal(idle.label, 'In the background: asking Grok 4.6 (xhigh)')
    assert.equal(idle.seconds, 90)
  }
  const none = skinActivity({ busy: false, waitLabel: 'Working', waitSec: 0, bgTasks: [], now })
  assert.equal(none.show, false)
})

function headerIsIfBusy(src: string, braceAt: number): boolean {
  let j = braceAt - 1
  while (j >= 0 && /\s/.test(src[j])) j--
  const header = src.slice(Math.max(0, j - 40), j + 1)
  return /if\s*\(\s*busy\s*\)$/.test(header)
}

function enclosesIfBusy(src: string, call: number): boolean {
  let depth = 0
  for (let i = call - 1; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth > 0) depth--
      else if (headerIsIfBusy(src, i)) return true
    }
  }
  return false
}

function pulseGatedByBusy(src: string): boolean {
  let from = 0
  let seen = 0
  const needle = 'skinActivity('
  while (from <= src.length) {
    const call = src.indexOf(needle, from)
    if (call < 0) break
    seen++
    if (enclosesIfBusy(src, call)) return true
    from = call + needle.length
  }
  return seen !== 1
}

const wrap = `if (busy) {
  const activity = skinActivity({ busy, waitLabel, waitSec, bgTasks, now: bgNow })
  if (activity.show) { specs.push({ spec: s }) }
}`

const snippet = `const activity = skinActivity({ busy, waitLabel, waitSec, bgTasks, now: bgNow })
if (activity.show) {
  const s = specFromStreamEvent({ kind: 'status', data: 'work:' + activity.label })
  if (s) {
    s.props.seconds = activity.seconds
    specs.push({ spec: s })
  }
}`

const closedEarlier = `if (busy) { doOther() }
const activity = skinActivity({ busy, waitLabel, waitSec, bgTasks, now: bgNow })
if (activity.show) { specs.push({ spec: s }) }`

test('the skin pulse is not wrapped in if (busy)', () => {
  assert.equal(pulseGatedByBusy(wrap), true)
  assert.equal(pulseGatedByBusy(snippet), false)
  assert.equal(pulseGatedByBusy(closedEarlier), false)
  const skin = readFileSync(new URL('../renderer/src/skin/SkinPane.tsx', import.meta.url), 'utf8')
  assert.equal(pulseGatedByBusy(skin), false)
  assert.match(skin, /skinActivity\(/)
  const call = skin.indexOf('skinActivity(')
  const args = skin.slice(call, skin.indexOf(')', call))
  assert.match(args, /bgTasks/)
  assert.match(args, /now:/)
  assert.equal(skin.includes('function busyLabel'), false)
  assert.equal(skin.includes('props.seconds = waitSec'), false)
  assert.match(skin, /s\.props\.seconds = activity\.seconds/)
  const workspace = readFileSync(new URL('../renderer/src/TerminalWorkspace.tsx', import.meta.url), 'utf8')
  const workAt = workspace.indexOf("startsWith('work:')")
  const workEnd = workspace.indexOf('if (ev.kind', workAt + 10)
  assert.equal(workspace.slice(workAt, workEnd).includes('skinOnRef'), false)
  assert.match(workspace, /bgTasks=\{bgTasks\}/)
  assert.match(workspace, /bgNow=\{bgNow\}/)
})
