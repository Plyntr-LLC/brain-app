import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { draftFileAction } from '../shared/setup-guide'
import { fixtureBrainRoot } from './plyntr-sync'
import { setupTrace } from './setup-trace'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs))
    else if (st.isFile()) out.push(abs)
  }
  return out
}

export function mergeDraftContext(draft: string, clone: string): { copied: string[]; left: string[] } {
  const fixture = fixtureBrainRoot()
  const copied: string[] = []
  const left: string[] = []
  if (!draft || !existsSync(draft) || !clone || !existsSync(clone)) return { copied, left }
  for (const abs of walk(draft)) {
    const rel = relative(draft, abs).replace(/\\/g, '/')
    const draftBuf = readFileSync(abs)
    const fixPath = join(fixture, rel)
    const clonePath = join(clone, rel)
    const fixtureBuf = existsSync(fixPath) && statSync(fixPath).isFile() ? readFileSync(fixPath) : null
    const cloneBuf = existsSync(clonePath) && statSync(clonePath).isFile() ? readFileSync(clonePath) : null
    const action = draftFileAction(rel, draftBuf, fixtureBuf, cloneBuf)
    if (action === 'copy') {
      mkdirSync(dirname(clonePath), { recursive: true })
      writeFileSync(clonePath, draftBuf)
      copied.push(rel)
    } else left.push(rel)
  }
  setupTrace({ event: 'draft-copy', copied, left })
  return { copied, left }
}
