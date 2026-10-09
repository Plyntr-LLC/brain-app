import type { ReactNode } from 'react'
import { BrowserPicture } from './BrowserPicture'

export type PageView = 'small' | 'wide' | 'large' | 'note'
const SIZES: { view: Exclude<PageView, 'note'>; label: string }[] = [
  { view: 'small', label: 'Small' },
  { view: 'wide', label: 'Wide' },
  { view: 'large', label: 'Large' }
]

/** The shared page, inside the chat turn that opened it (or docked above the conversation when large). */
export function ChatPageTurn(props: {
  mode: PageView
  src: string | null
  signIn: boolean
  owner: string
  active: boolean
  onToggle: () => void
  onHide: () => void
  onShow: () => void
  onWiden: () => void
  onSize: (view: Exclude<PageView, 'note'>) => void
}): ReactNode {
  // Open browser does what Wide does, so Wide is left out while it shows.
  const opener = props.signIn && props.mode !== 'note'
  const sizes = SIZES.filter((s) => s.view !== props.mode && !(opener && s.view === 'wide'))
  return (
    <div className="thread page-turn">
      {props.signIn ? <p>Sign in, in the browser.</p> : null}
      <BrowserPicture
        mode={props.mode}
        src={props.src}
        owner={props.owner}
        active={props.active}
        onToggle={props.onToggle}
        onShow={props.onShow}
      />
      {props.mode === 'note' && !props.signIn ? null : (
        <div className="page-turn-actions">
          {props.signIn ? (
            <button type="button" className="ghost" onClick={props.onWiden}>
              Open browser
            </button>
          ) : (
            <button type="button" className="ghost" onClick={props.onHide}>
              Hide
            </button>
          )}
          {props.mode === 'note'
            ? null
            : sizes.map((s) => (
                <button type="button" className="ghost" key={s.view} onClick={() => props.onSize(s.view)}>
                  {s.label}
                </button>
              ))}
        </div>
      )}
    </div>
  )
}
