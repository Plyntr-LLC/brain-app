// After `npm run pack:mac`: start the browser MCP server exactly as the packed app would hand it to a chat CLI
// (same path builder, same spec builder, the packed Brain executable), then require initialize and the 9 tools.
// node --experimental-strip-types scripts/check-packaged-browser-mcp.ts
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeScriptPath, serverSpec } from '../src/main/browser-bridge.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contents = join(root, 'dist', 'mac-arm64', 'Brain.app', 'Contents')
const resourcesPath = join(contents, 'Resources')
const script = bridgeScriptPath({ resourcesPath, appPath: join(resourcesPath, 'app.asar') })
const spec = serverSpec({ exec: join(contents, 'MacOS', 'Brain'), script, sock: join(root, 'no-such.sock'), token: 'packaged-check', owner: 'chat:packaged' })

function fail(why: string): never {
  console.log(`PACKAGED_BROWSER_MCP_FAIL ${why}`)
  process.exit(1)
}
if (!script.startsWith(resourcesPath)) fail(`the path builder did not pick the packed file: ${script}`)

const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] })
const timer = setTimeout(() => {
  child.kill()
  fail('no answer in 20 s')
}, 20_000)
let buf = ''
const got = new Map<number, any>()
child.stdout.on('data', (d) => {
  buf += d
  let n
  while ((n = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, n))
    buf = buf.slice(n + 1)
    got.set(m.id, m)
    if (m.id === 2) {
      clearTimeout(timer)
      child.kill()
      const init = got.get(1)
      const tools = (m.result?.tools || []).map((t: { name: string }) => t.name)
      if (init?.result?.serverInfo?.name !== 'brain-browser') fail(`initialize: ${JSON.stringify(init)}`)
      if (tools.length !== 9 || !tools.includes('whatsapp_send')) fail(`tools: ${tools.join(',')}`)
      console.log(`${spec.command} ${script}\ntools: ${tools.join(', ')}\nPACKAGED_BROWSER_MCP_PASS`)
      process.exit(0)
    }
  }
})
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-check', version: '1' } } }) + '\n')
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
