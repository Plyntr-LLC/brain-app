import { Fragment } from 'react'
import { WorldClocks } from './WorldClocks'

export type SessionChoice = { id: string; label: string; on: boolean }

/** One label and value. A row with choices (or an extra action) is a button that opens its picker above the card. */
export type SessionRow = {
  key: string
  label: string
  value: string
  title?: string
  choices?: SessionChoice[]
  onChoose?: (id: string) => void
  /** Shown in the picker when choices is empty. */
  empty?: string
  extra?: { label: string; onClick: () => void }
}

/** The bottom of the right rail: Model, Effort and the rest of this session as label and value rows, then Times. */
export function SessionCard({ rows, open, setOpen }: { rows: SessionRow[]; open: string | null; setOpen: (key: string | null) => void }) {
  const picking = rows.find((r) => r.key === open && (r.choices || r.extra))
  return (
    <div className="runmeta" onMouseDown={(e) => e.stopPropagation()}>
      {picking ? (
        <div className="runpick">
          {picking.choices?.length
            ? picking.choices.map((c) => (
                <button type="button" key={c.id} className={c.on ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => picking.onChoose?.(c.id)}>
                  {c.label}
                </button>
              ))
            : picking.empty
              ? <div className="tiny runpick-empty">{picking.empty}</div>
              : null}
          {picking.extra ? (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={picking.extra.onClick}>
              {picking.extra.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <h5>Session</h5>
      <div className="runmeta-grid">
        {rows.map((r) => (
          <Fragment key={r.key}>
            <div className="runmeta-k">{r.label}</div>
            {r.choices || r.extra ? (
              <button type="button" className="runmeta-v" title={r.title} onClick={() => setOpen(open === r.key ? null : r.key)}>
                {r.value}
              </button>
            ) : (
              <div className="runmeta-v" title={r.title}>
                {r.value}
              </div>
            )}
          </Fragment>
        ))}
        <WorldClocks />
      </div>
    </div>
  )
}
