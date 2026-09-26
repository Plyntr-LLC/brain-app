import assert from 'node:assert/strict'
import test from 'node:test'
import { recheckMissingLine } from './setup-guide.ts'

test('recheck names the missing tool instead of a phantom installer', () => {
  assert.equal(
    recheckMissingLine(
      [
        { id: 'git', label: 'Git', present: true },
        { id: 'cloudflared', label: 'Cloudflare Tunnel', present: false }
      ],
      { grok: true }
    ),
    'Cloudflare Tunnel is still missing. If no installer window opened, click Start setup again.'
  )
  assert.equal(
    recheckMissingLine(
      [
        { id: 'git', label: 'Git', present: true },
        { id: 'cloudflared', label: 'Cloudflare Tunnel', present: true },
        { id: 'grok', label: 'Grok CLI', present: true }
      ],
      { grok: true }
    ),
    'Chat is not ready yet. Sign in to the AI you picked, then Recheck.'
  )
})
