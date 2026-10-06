import { useState } from 'react'
import { outsideProject, rel, type FileHit } from './ptyChat'

const SHOWN = 3

function repoName(root: string): string {
  return root.split('/').filter(Boolean).pop() || root
}

/**
 * "Also touching": one line per repo outside the open folder that this chat or run touched. Three repos
 * show, the rest behind "N more". A repo's files show only after a click on its line.
 */
export function AwayBlock({ cwd, hits }: { cwd: string; hits: FileHit[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [all, setAll] = useState(false)
  const awayGroups = new Map<string, FileHit[]>()
  for (const h of hits) {
    const root = outsideProject(cwd, h.path)
    if (!root) continue
    awayGroups.set(root, [...(awayGroups.get(root) || []), h])
  }
  if (!awayGroups.size) return null
  const groups = [...awayGroups.entries()]
  const shown = all ? groups : groups.slice(0, SHOWN)
  const toggle = (root: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  return (
    <div className="away">
      <h3>Also touching</h3>
      {shown.map(([root, files]) => (
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
      ))}
      {!all && groups.length > SHOWN ? (
        <button type="button" className="away-line away-more" onClick={() => setAll(true)}>
          {groups.length - SHOWN} more
        </button>
      ) : null}
    </div>
  )
}
