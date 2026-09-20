import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'

let cachedKey: string | null = null
let warming: Promise<string | null> | null = null

export function typesafeReady(): boolean {
  return Boolean(cachedKey || (process.env.TYPESAFE_API_KEY || '').trim())
}

export async function warmTypesafeKey(): Promise<string | null> {
  if (cachedKey) return cachedKey
  if (warming) return warming
  warming = loadKey().finally(() => {
    warming = null
  })
  return warming
}

async function loadKey(): Promise<string | null> {
  const env = (process.env.TYPESAFE_API_KEY || '').trim()
  if (env) {
    cachedKey = env
    return cachedKey
  }
  try {
    const path = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`
    const { stdout } = await execFileAsync(
      'doppler',
      ['secrets', 'get', 'TYPESAFE_API_KEY', '-p', 'team-brain', '-c', 'dev', '--plain'],
      { timeout: 8000, env: { ...process.env, PATH: path } }
    )
    const key = String(stdout || '').trim()
    if (key) cachedKey = key
    return cachedKey
  } catch {
    return null
  }
}

export async function askJev(opts: {
  state: unknown
  questions: Record<string, unknown>
}): Promise<{ answers: Record<string, unknown> } | null> {
  const key = await warmTypesafeKey()
  if (!key) return null
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      state: opts.state,
      questions: opts.questions
    })
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`Jev HTTP ${res.status}`)
    return null
  }
  try {
    return JSON.parse(text) as { answers: Record<string, unknown> }
  } catch {
    return null
  }
}
