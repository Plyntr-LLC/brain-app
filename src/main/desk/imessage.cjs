#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** A name is letters, with no @ and no +. A phone, email, or guid is not a name. */
function isName(to) {
  const s = String(to || '')
  return /[a-z]/i.test(s) && !s.includes('@') && !s.includes('+')
}

/**
 * Match display_name only, exact after trim, case-insensitive.
 * Zero and many are not sendable. One stores the guid and a label.
 */
function matchName(chats, to) {
  const shown = String(to || '').trim()
  const want = shown.toLowerCase()
  const hits = (chats || []).filter((c) => String(c.display_name || '').trim().toLowerCase() === want)
  if (hits.length === 0) return { sendable: false, note: `No existing iMessage thread for ${shown}.` }
  if (hits.length > 1) return { sendable: false, note: `More than one iMessage chat matches ${shown}.` }
  const chat = hits[0]
  const handle = Array.isArray(chat.handles) ? chat.handles.find(Boolean) || '' : ''
  const label = [chat.display_name, handle].filter(Boolean).join(' ')
  return { sendable: true, guid: chat.guid, label }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function brainLib(brain) {
  return path.join(brain, 'code', 'imessage', 'lib')
}

async function main() {
  const [, , mode, brain, arg] = process.argv
  try {
    if (mode === 'lookup') {
      const db = require(path.join(brainLib(brain), 'db.cjs'))
      let result
      if (isName(arg)) {
        const chats = db.listChats({ limit: 200 })
        result = matchName(chats, arg)
      } else {
        const chat = db.findExistingChat(arg)
        result = chat
          ? { sendable: true, guid: chat.guid, label: chat.display_name || chat.chat_identifier || arg }
          : { sendable: false, note: `No existing iMessage thread for ${String(arg || '').trim()}.` }
      }
      process.stdout.write(JSON.stringify(result) + '\n')
      return
    }
    if (mode === 'send') {
      const body = await readStdin()
      const send = require(path.join(brainLib(brain), 'send.cjs'))
      const result = send.sendToExistingChat(arg, body)
      process.stdout.write(JSON.stringify(result) + '\n')
      return
    }
    process.stderr.write(`unknown mode ${mode}\n`)
    process.exit(2)
  } catch (err) {
    const message = String(err && err.message ? err.message : err).split('\n')[0]
    process.stdout.write(JSON.stringify({ error: message || "Messages isn't available on this Mac." }) + '\n')
    process.exit(1)
  }
}

module.exports = { isName, matchName }

if (require.main === module) {
  main()
}
