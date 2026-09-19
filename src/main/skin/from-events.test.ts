import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogIdForEvent, specFromStreamEvent, userMessageSpec } from '../../shared/skin/from-events.ts'

test('maps stream kinds to catalog ids', () => {
  const cases: [string, string | null][] = [
    ['thought', 'Thought'],
    ['text', 'AgentMessage'],
    ['file', 'ToolCard'],
    ['status:compacting', 'CompactNotice'],
    ['status:compacted', 'CompactNotice'],
    ['status:work:Read', 'WorkPulse'],
    ['context', 'ContextMeter'],
    ['commands', 'SlashMenu'],
    ['error', 'ErrorNotice'],
    ['error:sign in', 'LoginNeed'],
    ['permission', 'PermissionAsk'],
    ['plan', 'Plan'],
    ['done', null]
  ]
  for (const [raw, want] of cases) {
    const [kind, extra] = raw.split(':')
    const ev =
      kind === 'file'
        ? { kind, path: 'README.md', tool: 'Read' }
        : kind === 'status'
          ? { kind, data: extra === 'work' ? 'work:Read' : extra }
          : kind === 'commands'
            ? { kind, commands: [{ name: 'compact', description: 'Summarize' }] }
            : kind === 'error'
              ? { kind, data: extra === 'sign in' ? 'Grok Chat needs you to sign in.' : 'boom' }
              : kind === 'permission'
                ? { kind, title: 'Write walk.md', path: 'walk.md', options: [{ id: 'allow_once', label: 'Allow' }] }
                : kind === 'plan'
                  ? { kind, steps: [{ title: 'Read', status: 'pending' }] }
                  : kind === 'context'
                    ? { kind, used: 10, total: 100, percent: 10 }
                    : kind === 'thought' || kind === 'text'
                      ? { kind, data: 'hi' }
                      : { kind }
    const spec = specFromStreamEvent(ev)
    const id = catalogIdForEvent(ev)
    if (want == null) {
      assert.equal(spec, null)
      assert.equal(id, null)
    } else {
      assert.equal(spec?.component, want, raw)
      assert.equal(id, want, raw)
    }
  }
})

test('user send is UserMessage', () => {
  const spec = userMessageSpec('hello')
  assert.equal(spec.component, 'UserMessage')
  assert.equal(spec.props.text, 'hello')
})

test('unknown kind is RawFallback', () => {
  const spec = specFromStreamEvent({ kind: 'waiting_screen', data: 'press y' })
  assert.equal(spec?.component, 'RawFallback')
  assert.equal(catalogIdForEvent({ kind: 'waiting_screen' }), null)
})
