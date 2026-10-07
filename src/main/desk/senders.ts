import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { DeskSendResult } from '../../shared/desk.ts'

/**
 * The only Desk code that spawns a send. It does not import electron, and it does not append mail.
 * `getAppPath` is passed in by ipc, the same way `resolveBin` is.
 */

export type DeskSpawn = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcess

export type SendersOpts = {
  spawn?: DeskSpawn
  getAppPath?: () => string
  dryRun?: boolean
  emailKillMs?: number
  textKillMs?: number
}

const EMAIL_KILL_MS = 15_000
const TEXT_KILL_MS = 25_000

const GMAIL_SIGNED_OUT = "Gmail isn't signed in on this Mac."
const GMAIL_MAY_HAVE_GONE = 'This may have gone. Check Sent in Gmail before trying again.'
const TEXT_MAY_HAVE_GONE = 'This may have gone. Check Messages before trying again.'
const DRY_NOTE = 'Dry run. Nothing left this Mac.'

export type EmailTile = { to: string; cc?: string; subject: string; body: string; replyTo?: string }
export type TextLookup = { sendable: boolean; note?: string; guid?: string; label?: string }

function scriptPath(name: string, getAppPath?: () => string): string {
  const here = join(dirname(fileURLToPath(import.meta.url)), name)
  if (existsSync(here)) return here
  if (getAppPath) {
    const packed = join(getAppPath(), 'src', 'main', 'desk', name)
    if (existsSync(packed)) return packed
  }
  return here
}

type Ran = { code: number | null; stdout: string; stderr: string; killed: boolean }

function runChild(
  spawn: DeskSpawn,
  script: string,
  args: string[],
  stdin: string | null,
  killMs: number
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null, killed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, killed })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(null, true)
    }, killMs)
    child.stdout?.on('data', (b) => {
      stdout += String(b)
    })
    child.stderr?.on('data', (b) => {
      stderr += String(b)
    })
    child.on('error', (err) => finish(1, false) || void err)
    child.on('close', (code) => finish(code, false))
    if (stdin != null) child.stdin?.end(stdin)
    else child.stdin?.end()
  })
}

export function createSenders(opts: SendersOpts = {}) {
  const spawn = opts.spawn
  const emailKillMs = opts.emailKillMs ?? EMAIL_KILL_MS
  const textKillMs = opts.textKillMs ?? TEXT_KILL_MS
  const gmailScript = () => scriptPath('gmail-send.cjs', opts.getAppPath)
  const textScript = () => scriptPath('imessage.cjs', opts.getAppPath)

  async function gmailFrom(brain: string): Promise<string | null> {
    if (!spawn) return null
    const ran = await runChild(spawn, gmailScript(), ['from', brain], null, emailKillMs)
    if (ran.killed || ran.code !== 0) return null
    const line = ran.stdout.trim()
    if (!line || line === 'no-token') return null
    return line
  }

  async function check(brain: string, messageId: string): Promise<'ok' | 'missing' | 'no-token'> {
    if (!spawn) return 'no-token'
    const ran = await runChild(spawn, gmailScript(), ['check', brain, messageId], null, emailKillMs)
    const out = ran.stdout.trim()
    if (out === 'ok') return 'ok'
    if (out === 'missing') return 'missing'
    return 'no-token'
  }

  async function sendEmail(brain: string, tile: EmailTile): Promise<DeskSendResult> {
    if (opts.dryRun) return { ok: true, dryRun: true, note: DRY_NOTE }
    if (!spawn) return { ok: false, sendable: false, note: GMAIL_SIGNED_OUT }
    const ran = await runChild(spawn, gmailScript(), ['send', brain], JSON.stringify(tile), emailKillMs)
    if (ran.killed) return { ok: false, killed: true, sendable: false, note: GMAIL_MAY_HAVE_GONE }
    if (ran.stdout.includes('no-token') || ran.code === 2) return { ok: false, sendable: false, note: GMAIL_SIGNED_OUT }
    if (ran.code === 0) return { ok: true }
    const note = ran.stderr.trim().split('\n')[0] || 'Gmail send failed.'
    return { ok: false, sendable: true, note }
  }

  async function lookupText(brain: string, to: string): Promise<TextLookup> {
    if (!spawn) return { sendable: false, note: "Messages isn't available on this Mac." }
    const ran = await runChild(spawn, textScript(), ['lookup', brain, to], null, textKillMs)
    if (ran.killed) return { sendable: false, note: "Messages isn't available on this Mac." }
    try {
      const parsed = JSON.parse(ran.stdout.trim() || '{}') as TextLookup & { error?: string }
      if (parsed.error) return { sendable: false, note: parsed.error }
      return { sendable: Boolean(parsed.sendable), note: parsed.note, guid: parsed.guid, label: parsed.label }
    } catch {
      return { sendable: false, note: "Messages isn't available on this Mac." }
    }
  }

  async function sendText(brain: string, guid: string, body: string): Promise<DeskSendResult> {
    if (opts.dryRun) return { ok: true, dryRun: true, note: DRY_NOTE }
    if (!spawn) return { ok: false, sendable: false, note: TEXT_MAY_HAVE_GONE }
    const ran = await runChild(spawn, textScript(), ['send', brain, guid], body, textKillMs)
    if (ran.killed) return { ok: false, killed: true, sendable: false, note: TEXT_MAY_HAVE_GONE }
    const text = `${ran.stdout}\n${ran.stderr}`
    if (text.includes('Messages send failed')) return { ok: false, sendable: false, note: TEXT_MAY_HAVE_GONE }
    if (text.includes('No existing iMessage thread')) return { ok: false, sendable: true }
    try {
      const parsed = JSON.parse(ran.stdout.trim() || '{}') as { ok?: boolean; error?: string }
      const error = String(parsed.error || '')
      if (parsed.ok === true) return { ok: true }
      if (error.includes('no matching chat.db row')) return { ok: true }
      if (error.includes('chat.db error=')) return { ok: false, sendable: true, note: error }
      if (error.includes('Messages send failed')) return { ok: false, sendable: false, note: TEXT_MAY_HAVE_GONE }
      if (error) return { ok: false, sendable: true, note: error }
    } catch {
      /* stdout was not JSON */
    }
    if (ran.code === 0) return { ok: true }
    return { ok: false, sendable: true, note: ran.stderr.trim().split('\n')[0] || 'Message was not sent.' }
  }

  function sendWhatsApp(): DeskSendResult {
    return { ok: false, sendable: false }
  }

  return { gmailScript, textScript, gmailFrom, check, sendEmail, lookupText, sendText, sendWhatsApp }
}
