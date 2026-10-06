// Resolves a Factory run's task and Guide sentences against the real ~/Projects, the way Start and
// Guide notes do, and lists the folder titles the resolver knows. Read-only.
// node --experimental-strip-types scripts/factory-repo-probe.ts run-ae98e1f8-9ca
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setUserDataDir } from '../src/main/factory/run-store.ts'
import { folderTitles, resolveWorkRepo } from '../src/main/factory/resolve-repo.ts'

setUserDataDir(() => join(tmpdir(), 'factory-repo-probe'))
const id = process.argv[2] || 'run-ae98e1f8-9ca'
const file = join(homedir(), 'Library/Application Support/brain-app/factory/runs', `${id}.json`)
const run = JSON.parse(readFileSync(file, 'utf8')) as { task: string; brainPath: string; repos?: { repo: string }[]; guide?: { text: string }[] }
const projects = join(homedir(), 'Projects')
const first = run.repos?.[0]?.repo || ''

console.log(`run ${id}`)
console.log(`task -> ${JSON.stringify(resolveWorkRepo({ task: run.task, brainPath: run.brainPath, lastRepo: first }))}`)
for (const g of run.guide || []) {
  const note = resolveWorkRepo({ task: g.text, brainPath: run.brainPath, ignore: [first], aliases: 'title' })
  console.log(`note ${JSON.stringify(g.text.slice(0, 90))} -> ${JSON.stringify(note)}`)
}
console.log('titles:')
for (const [name, titles] of Object.entries(folderTitles(projects, run.brainPath))) console.log(`  ${name}: ${titles.join(', ')}`)
