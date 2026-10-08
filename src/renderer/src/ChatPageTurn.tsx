import type { ReactNode } from 'react'
import { BrowserPicture } from './BrowserPicture'

/** The shared page, inside the chat turn that opened it. */
export function ChatPageTurn(props: {
  mode: 'small' | 'wide' | 'note'
  src: string | null
  signIn: boolean
  onToggle: () => void
  onHide: () => void
  onShow: () => void
  onClickAt: (x: number, y: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: string) => void
  onWheel: (deltaY: number) => void
  onWiden: () => void
}): ReactNode {
  return (
    <div className="thread page-turn">
      {props.signIn ? <p>Sign in, in the browser.</p> : null}
      <BrowserPicture
        mode={props.mode}
        src={props.src}
        onToggle={props.onToggle}
        onShow={props.onShow}
        onClickAt={props.onClickAt}
        onTypeText={props.onTypeText}
        onPressKey={props.onPressKey}
        onWheel={props.onWheel}
      />
      {props.signIn ? (
        <button type="button" className="ghost" onClick={props.onWiden}>
          Open browser
        </button>
      ) : props.mode === 'note' ? null : (
        <button type="button" className="ghost" onClick={props.onHide}>
          Hide
        </button>
      )}
    </div>
  )
}
