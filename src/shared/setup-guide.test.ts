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
    'Still missing: Cloudflare Tunnel. Click Start setup to install it.'
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
    'Next, sign in to Grok. A browser opens.'
  )
})
