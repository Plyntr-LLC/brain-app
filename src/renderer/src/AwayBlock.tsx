import { useState } from 'react'
import { outsideProject, rel, type FileHit } from './ptyChat'

function repoName(root: string): string {
  return root.split('/').filter(Boolean).pop() || root
}

/**
 * "Also touching": repos outside the open folder that this chat or run touched. Folded it is one line with the
 * repo count (and a live dot while a file there is live); open it lists every repo, and a repo's files show
 * only after a click on its line.
 */
export function AwayBlock({ cwd, hits }: { cwd: string; hits: FileHit[] }) {
  const [shown, setShown] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const awayGroups = new Map<string, FileHit[]>()
  for (const h of hits) {
    const root = outsideProject(cwd, h.path)
    if (!root) continue
    awayGroups.set(root, [...(awayGroups.get(root) || []), h])
  }
  if (!awayGroups.size) return null
  const groups = [...awayGroups.entries()]
  const live = hits.some((h) => h.live && outsideProject(cwd, h.path))
  const toggle = (root: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  return (
    <div className={`away${shown ? ' open' : ''}`}>
      <button type="button" className={`away-head${live ? ' live' : ''}`} aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        <span className="away-chev" aria-hidden="true">
          {shown ? '▾' : '▸'}
        </span>
        <span className="away-title">Also touching</span>
        <span className="away-count">{groups.length}</span>
      </button>
      {shown
        ? groups.map(([root, files]) => (
            <div key={root} className="away-repo">
              <button type="button" className={`away-line${files.some((f) => f.live) ? ' live' : ''}`} title={root} aria-expanded={open.has(root)} onClick={() => toggle(root)}>
                <span className="away-name">{repoName(root)}</span>
                <span className="away-count">{files.length}</span>
              </button>
              {open.has(root)
                ? files.map((h) => (
                    <span key={h.path} className={`flink turn${h.live ? ' live' : ''}`}>
                      {rel(root, h.path)}
                    </span>
                  ))
                : null}
            </div>
          ))
        : null}
    </div>
  )
}
