import type { JSX } from 'react'
import type { DeskMessage } from '@shared/desk'

export function DeskCard(props: {
  msg: DeskMessage
  names: Record<string, string>
  onOpenFile: (path: string) => void
  onHoldAnswer: (msgId: string, answer: 'yes' | 'no') => void
  onSend: (msgId: string, sent: 'yes' | 'no') => void
  onRetry: (msgId: string) => void
  onKeepWaiting: (botId: string) => void
  onStop: (botId: string) => void
  onContinueJob: (job: string) => void
  onStopJob: (job: string) => void
  onTalk: (botId: string) => void
  onOpenLog: () => void
  onOpenMemory: (botId: string) => void
  onOpenBrowser: () => void
  onRemoveHire: (msgId: string) => void
  busy: boolean
}): JSX.Element {
  void props
  return <></>
}
