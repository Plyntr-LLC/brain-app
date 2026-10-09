import { useEffect, useState, type ReactNode } from 'react'
import { BrowserPicture } from './BrowserPicture'

export type PageView = 'small' | 'wide' | 'large' | 'note'
const SIZES: { view: Exclude<PageView, 'note'>; label: string }[] = [
  { view: 'small', label: 'Small' },
  { view: 'wide', label: 'Wide' },
  { view: 'large', label: 'Large' }
]

/** Where the page is and which ways it can go. `shared` is a WhatsApp window every chat uses: no Back or Forward. */
export type PageNav = { url: string; canGoBack: boolean; canGoForward: boolean; shared: boolean }
export type PageDownload = { id: string; name: string; state: 'completed' | 'interrupted' | 'cancelled' }

/** The shared page, inside the chat turn that opened it (or docked above the conversation when large). */
export function ChatPageTurn(props: {
  mode: PageView
  src: string | null
  signIn: boolean
  owner: string
  active: boolean
  nav?: PageNav
  downloads?: PageDownload[]
  onToggle: () => void
  onHide: () => void
  onShow: () => void
  onWiden: () => void
  onSize: (view: Exclude<PageView, 'note'>) => void
  onNav?: (action: 'back' | 'forward' | 'reload') => void
  onGo?: (text: string) => void
  onPrint?: () => void
  onDownload?: (id: string, how: 'open' | 'show') => void
}): ReactNode {
  // Open browser does what Wide does, so Wide is left out while it shows.
  const opener = props.signIn && props.mode !== 'note'
  const sizes = SIZES.filter((s) => s.view !== props.mode && !(opener && s.view === 'wide'))
  const nav = props.nav
  const [typed, setTyped] = useState<string | null>(null)
  useEffect(() => setTyped(null), [nav?.url])
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
        onPrint={props.onPrint}
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
          {props.mode === 'note' || !props.onNav ? null : (
            <>
              <button type="button" className="ghost page-nav" aria-label="Back" title="Back" disabled={!nav?.canGoBack || nav.shared} onClick={() => props.onNav?.('back')}>
                ‹
              </button>
              <button type="button" className="ghost page-nav" aria-label="Forward" title="Forward" disabled={!nav?.canGoForward || nav.shared} onClick={() => props.onNav?.('forward')}>
                ›
              </button>
              <button type="button" className="ghost page-nav" aria-label="Reload" title="Reload" onClick={() => props.onNav?.('reload')}>
                ↻
              </button>
              <input
                className="page-address"
                aria-label="Address"
                spellCheck={false}
                value={typed ?? nav?.url ?? ''}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setTyped(null)
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  const text = (typed ?? nav?.url ?? '').trim()
                  if (text) props.onGo?.(text)
                  setTyped(null)
                }}
              />
            </>
          )}
        </div>
      )}
      {props.downloads?.length ? (
        <div className="page-downloads">
          {props.downloads.map((d) => (
            <div className="page-download tiny" key={d.id}>
              {d.state === 'completed' ? (
                <>
                  <span>Downloaded {d.name}</span>
                  <button type="button" className="linkish" onClick={() => props.onDownload?.(d.id, 'open')}>
                    Open
                  </button>
                  <button type="button" className="linkish" onClick={() => props.onDownload?.(d.id, 'show')}>
                    Show in Finder
                  </button>
                </>
              ) : (
                <span>{d.name} did not finish downloading.</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
