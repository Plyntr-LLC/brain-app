import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentInCommand,
  handoffFromTitle,
  handoffLabel,
  nextReviewTasks,
  skinActivity,
  skinPulseLabel,
  visibleBgLine
} from '../shared/agent-label.ts'

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

test('an Opus review stays named until that tool call finishes', () => {
  const cmd = 'command claude -p --model opus --effort high --permission-mode plan "review this plan"'
  assert.equal(handoffLabel('Bash', { command: cmd }), 'Opus is reviewing')
  assert.equal(handoffLabel('Bash', { command: cmd, run_in_background: true }), 'Started in the background: Opus is reviewing')
  assert.equal(handoffFromTitle(cmd), 'Opus is reviewing')
  assert.equal(handoffFromTitle('Start Claude CLI Opus high plan review'), 'Opus is reviewing')
  assert.equal(handoffLabel('Bash', { command: 'command claude -p --model opus --effort high "what is 2+2"' }), 'Asking Claude Opus (high)')
  assert.equal(
    handoffLabel('Bash', { command: 'command claude -p --model opus --permission-mode plan "what is 2+2"' }),
    'Asking Claude Opus'
  )
  assert.equal(handoffFromTitle('Read the Opus review notes'), null)
  assert.equal(handoffFromTitle("Read Claude's Opus review notes"), null)
  assert.equal(handoffFromTitle('Read plans/Claude-Opus-Review.md'), null)
  assert.equal(handoffFromTitle('Start Claude Opus review of plans/diff.md'), null)
  assert.equal(skinPulseLabel('Opus is reviewing'), 'Opus is reviewing')
  assert.equal(visibleBgLine([{ label: 'Opus is reviewing' }, { label: 'Started in the background: a command' }]), 'Opus is reviewing (+1 more)')
  const started = nextReviewTasks([], { kind: 'tool_call', id: 'call-1', title: 'Start Claude CLI Opus high plan review', command: cmd, status: '' }, 50)
  assert.deepEqual(started, [{ id: 'call-1', label: 'Opus is reviewing', at: 50 }])
  assert.equal(nextReviewTasks(started || [], { kind: 'tool_call_update', id: 'call-1', title: '', command: '', status: 'in_progress' }, 60), null)
  assert.deepEqual(nextReviewTasks(started || [], { kind: 'tool_call_update', id: 'call-1', title: '', command: '', status: 'completed' }, 70), [])
  assert.equal(
    nextReviewTasks([], { kind: 'tool_call', id: 'call-2', title: 'Start Claude CLI Opus high plan review', command: cmd, status: 'completed' }, 80),
    null
  )
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
  const review = skinActivity({
    busy: false,
    waitLabel: 'Working',
    waitSec: 0,
    bgTasks: [{ label: 'Opus is reviewing', at: now - 4000 }],
    now
  })
  assert.equal(review.show, true)
  if (review.show) assert.equal(review.label, 'Opus is reviewing')
  const none = skinActivity({ busy: false, waitLabel: 'Working', waitSec: 0, bgTasks: [], now })
  assert.equal(none.show, false)
})
