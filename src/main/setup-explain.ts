import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AiKind } from '../shared/contracts'
import { setupPrompt } from '../shared/setup-guide'
import { acpPrompt } from './acp-session'
import { claudePrompt } from './claude-stream'
import { cliSignedIn } from './cli-auth'
import { codexPrompt } from './codex-app'
import { setupTrace } from './setup-trace'

export async function explainSetup(
  opts: {
    heading: string
    kinds: AiKind[]
    strip?: boolean
    cwd?: string
    token?: number
  },
  win?: BrowserWindow | null
): Promise<{ ok: boolean; cwd: string; skipped?: boolean }> {
  const cwd = String(opts.cwd || '').trim() || mkdtempSync(join(tmpdir(), 'brain-explain-'))
  const heading = String(opts.heading || '').trim()
  const kinds = opts.kinds.filter((kind) => cliSignedIn(kind))
  if (!kinds.length) return { ok: false, cwd, skipped: true }
  if (opts.strip) setupTrace({ event: 'strip', heading })
  const text = setupPrompt(heading)
  const onEvent = (ev: { kind: string; data?: string }) => {
    if (ev.kind === 'text' && ev.data && win && !win.isDestroyed()) {
      win.webContents.send('setup:explain-text', { text: ev.data, token: opts.token })
    }
  }
  for (const kind of kinds) {
    setupTrace({ event: 'warm', kind, appTools: [], cwd })
    if (kind === 'grok' || kind === 'cursor') {
      await acpPrompt({ kind, tabId: `setup-${kind}`, cwd, text, onEvent })
    } else if (kind === 'claude') {
      await claudePrompt({ tabId: 'setup-claude', cwd, text, onEvent })
    } else {
      await codexPrompt({ tabId: 'setup-gpt', cwd, text, onEvent })
    }
  }
  return { ok: true, cwd }
}
