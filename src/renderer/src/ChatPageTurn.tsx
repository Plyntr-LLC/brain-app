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
  onShowWindow: () => void
}): ReactNode {
  let body: ReactNode
  if (props.signIn) {
    body = (
      <>
        <p>Sign in, in the browser.</p>
        <button type="button" className="ghost" onClick={props.onShowWindow}>
          Open browser
        </button>
      </>
    )
  } else {
    body = (
      <>
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
        {props.mode === 'note' ? null : (
          <button type="button" className="ghost" onClick={props.onHide}>
            Hide
          </button>
        )}
      </>
    )
  }
  return <div className="thread page-turn">{body}</div>
}
