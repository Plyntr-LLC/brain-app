import { useEffect, useState, type ReactNode } from 'react'
import type { PageCard } from '@shared/desk'
import { BrowserPicture } from './BrowserPicture'

export type PageView = 'small' | 'wide' | 'large' | 'note'
const SIZES: { view: Exclude<PageView, 'note'>; label: string }[] = [
  { view: 'small', label: 'Small' },
  { view: 'wide', label: 'Wide' },
  { view: 'large', label: 'Large' }
]

/** Where the page is and which ways it can go. `shared` is a WhatsApp window every chat uses: no Back or Forward. `popup`: a pop-up is on top. */
export type PageNav = { url: string; canGoBack: boolean; canGoForward: boolean; shared: boolean; popup?: boolean }
export type PageDownload = { id: string; name: string; state: 'completed' | 'interrupted' | 'cancelled' }
/** A card under the picture and where it is: waiting for the person, sent, or done with its last line. */
export type PageCardView = PageCard & { state: 'waiting' | 'answering' | 'ended'; note?: string }

const hostOf = (site: string) => {
  try {
    return new URL(site).host
  } catch {
    return site
  }
}
const usesWords = (uses: string[]) => (uses.length <= 1 ? uses.join('') : `${uses.slice(0, -1).join(', ')} and ${uses[uses.length - 1]}`)

/** One card. Only a person answers it; its buttons go quiet after the first press. */
function PageCardRow(props: { card: PageCardView; onAnswer: (answer: string) => void }): ReactNode {
  const c = props.card
  const host = hostOf(c.site)
  const waiting = c.state === 'waiting'
  const title =
    c.kind === 'site' ? `${host} wants to use your ${usesWords(c.uses)}.` : c.kind === 'passkey' ? `${host} is asking for a passkey.` : `Sign in to ${host} as:`
  return (
    <div className="skin-perm page-card">
      <p className="skin-perm-title">{title}</p>
      {c.kind === 'passkey' && waiting ? <p className="tiny">Brain can use passkeys saved in Brain (Touch ID) and security keys.</p> : null}
      {c.state === 'ended' ? (
        <p className="tiny page-card-note">{c.note}</p>
      ) : (
        <div className="skin-perm-actions">
          {c.kind === 'site' ? (
            <>
              <button type="button" className="primary" disabled={!waiting} onClick={() => props.onAnswer('allow')}>
                Allow
              </button>
              <button type="button" className="ghost" disabled={!waiting} onClick={() => props.onAnswer('deny')}>
                Don't allow
              </button>
            </>
          ) : null}
          {c.kind === 'account'
            ? c.accounts.map((a) => (
                <button type="button" className="ghost" key={a.id} disabled={!waiting} onClick={() => props.onAnswer(a.id)}>
                  {a.name}
                </button>
              ))
            : null}
          {c.kind !== 'site' ? (
            <button type="button" className="ghost" disabled={!waiting} onClick={() => props.onAnswer('cancel')}>
              Cancel
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The shared page, inside the chat turn that opened it (or docked above the conversation when large). */
export function ChatPageTurn(props: {
  mode: PageView
  src: string | null
  signIn: boolean
  owner: string
  active: boolean
  nav?: PageNav
  downloads?: PageDownload[]
  cards?: PageCardView[]
  onCard?: (id: string, answer: string) => void
  onClosePopup?: () => void
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
              {nav?.popup && props.onClosePopup ? (
                <button type="button" className="ghost page-close-popup" onClick={props.onClosePopup}>
                  Close pop-up
                </button>
              ) : null}
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
      {props.cards?.length ? (
        <div className="page-cards">
          {props.cards.map((c) => (
            <PageCardRow key={c.id} card={c} onAnswer={(answer) => props.onCard?.(c.id, answer)} />
          ))}
        </div>
      ) : null}
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
