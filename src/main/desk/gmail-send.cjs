#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')

/** Account the way auth.cjs does. GOOGLE_ACCOUNT, else GMAIL_ACCOUNT, else plyntr. */
function accountName(env = process.env) {
  return env.GOOGLE_ACCOUNT || env.GMAIL_ACCOUNT || 'plyntr'
}

/**
 * Token and credentials. Secrets dir first, then <brain>/auth/google/.
 * Missing either file is no-token. This does not call authorize().
 */
function resolveAuthFiles(brain, env = process.env, home = os.homedir()) {
  const account = accountName(env)
  const tokenFile = `token-${account}.json`
  const secrets = path.join(home, '.brain-secrets', 'google')
  const legacy = path.join(brain, 'auth', 'google')
  const token = fs.existsSync(path.join(secrets, tokenFile))
    ? path.join(secrets, tokenFile)
    : path.join(legacy, tokenFile)
  const credentials = fs.existsSync(path.join(secrets, 'credentials.json'))
    ? path.join(secrets, 'credentials.json')
    : path.join(legacy, 'credentials.json')
  if (!fs.existsSync(token) || !fs.existsSync(credentials)) return { ok: false }
  return { ok: true, token, credentials, account }
}

function printNoToken() {
  process.stdout.write('no-token\n')
  process.exit(2)
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    process.stdin.on('error', reject)
  })
}

async function main() {
  const [, , mode, brain, messageId] = process.argv
  if (!mode || !brain) {
    process.stderr.write('usage: gmail-send.cjs <from|check|send> <brain> [messageId]\n')
    process.exit(2)
  }
  const gate = resolveAuthFiles(brain)
  if (!gate.ok) printNoToken()

  const auth = require(path.join(brain, '.claude', 'skills', 'gmail', 'scripts', 'auth.cjs'))
  const requireFromBrain = createRequire(path.join(brain, 'package.json'))
  const { google } = requireFromBrain('googleapis')
  const client = await auth.authorize()
  const gmail = google.gmail({ version: 'v1', auth: client })

  if (mode === 'from') {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    process.stdout.write(String(profile.data.emailAddress || '') + '\n')
    return
  }

  if (mode === 'check') {
    try {
      await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'minimal' })
      process.stdout.write('ok\n')
    } catch {
      process.stdout.write('missing\n')
    }
    return
  }

  if (mode === 'send') {
    const tile = await readStdin()
    const to = String(tile.to || '')
    const cc = String(tile.cc || '')
    const subject = String(tile.subject || '')
    const body = String(tile.body || '')
    const replyTo = String(tile.replyTo || tile.reply || '')
    let raw
    if (!replyTo) {
      const headers = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body]
      if (cc) headers.splice(1, 0, `Cc: ${cc}`)
      raw = Buffer.from(headers.join('\r\n')).toString('base64url')
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    } else {
      const prev = await gmail.users.messages.get({ userId: 'me', id: replyTo, format: 'metadata', metadataHeaders: ['Message-ID', 'References'] })
      const headers = prev.data.payload?.headers || []
      const pick = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || ''
      const messageIdHeader = pick('Message-ID')
      const references = [pick('References'), messageIdHeader].filter(Boolean).join(' ')
      const lines = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8']
      if (cc) lines.splice(1, 0, `Cc: ${cc}`)
      if (messageIdHeader) lines.push(`In-Reply-To: ${messageIdHeader}`)
      if (references) lines.push(`References: ${references}`)
      lines.push('', body)
      raw = Buffer.from(lines.join('\r\n')).toString('base64url')
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: prev.data.threadId } })
    }
    process.stdout.write('ok\n')
    return
  }

  process.stderr.write(`unknown mode ${mode}\n`)
  process.exit(2)
}

module.exports = { accountName, resolveAuthFiles }

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err && err.message ? err.message : err).split('\n')[0] + '\n')
    process.exit(1)
  })
}
