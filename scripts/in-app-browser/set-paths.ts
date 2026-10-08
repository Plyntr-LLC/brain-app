// Imported first, so every module the check loads sees the temp userData and downloads folders, and a Grok
// leader socket of its own. Brain's makeLeader unlinks a socket it did not start; the running app's must stay.
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const userData = process.env.BB_USERDATA
if (userData) {
  app.setPath('userData', userData)
  const downloads = join(userData, 'downloads')
  mkdirSync(downloads, { recursive: true })
  app.setPath('downloads', downloads)
}
process.env.BRAIN_GROK_LEADER_SOCK = join(homedir(), '.grok', `leader-bbcheck-${process.pid}.sock`)
