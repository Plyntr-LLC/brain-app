'use strict'
// The `open` command inside a Brain chat. Web pages belong in Brain's own browser; files, apps and
// command-line sign-in links go to the real `open`. Run by the chat-shims `open` script with Brain's
// executable and ELECTRON_RUN_AS_NODE=1.
const { spawnSync } = require('node:child_process')

const REFUSAL =
  'Brain chats do not open web pages in Chrome. Use the browser_open tool (brain-browser): it opens the page inside Brain and shows it in this chat. If this is a sign-in link for a command-line tool, ask the person to open it.'
const SIGN_IN_HOSTS = new Set([
  'github.com', 'vercel.com', 'dashboard.doppler.com', 'supabase.com', 'railway.com', 'railway.app', 'cursor.com', 'claude.ai',
  'console.anthropic.com', 'accounts.google.com', 'dash.cloudflare.com', 'accounts.x.ai', 'auth.x.ai', 'auth.openai.com',
  'login.microsoftonline.com', 'app.netlify.com'
])
const LOGIN_PATHS = new Set(['/login/device', '/oauth/device', '/oauth2/device', '/device', '/cli/login', '/cli-login', '/dashboard/cli/login', '/logindeepcontrol'])

function webAddress(arg) {
  if (!/^https?:\/\//i.test(arg)) return null
  try {
    return new URL(arg)
  } catch {
    return null
  }
}

/** A link a command-line tool opens for its own sign-in: a known sign-in host, and an OAuth request or a CLI login page there. */
function signInLink(url) {
  if (!SIGN_IN_HOSTS.has(url.hostname.toLowerCase())) return false
  const q = url.searchParams
  if (q.has('client_id') && (q.has('response_type') || q.has('redirect_uri'))) return true
  const path = url.pathname.replace(/\/+$/, '').toLowerCase() || '/'
  return LOGIN_PATHS.has(path) || path.startsWith('/workplace/auth/cli/')
}

function decide(args) {
  const urls = args.map(webAddress).filter(Boolean)
  if (!urls.length) return 'pass'
  return urls.every(signInLink) ? 'pass' : 'refuse'
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (decide(args) === 'refuse') {
    process.stderr.write(REFUSAL + '\n')
    process.exit(1)
  }
  const real = process.env.BRAIN_OPEN_BIN || '/usr/bin/open'
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const ran = spawnSync(real, args, { stdio: 'inherit', env })
  process.exit(ran.status === null ? 1 : ran.status)
}

module.exports = { decide, signInLink, REFUSAL }
