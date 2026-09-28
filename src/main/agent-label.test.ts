import assert from 'node:assert/strict'
import test from 'node:test'
import { agentInCommand, handoffFromTitle, handoffLabel } from '../shared/agent-label.ts'

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
