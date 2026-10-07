import type { JSX } from 'react'
import type { DeskBot, DeskCli } from '@shared/desk'

export function DeskBotForm(props: {
  bot?: DeskBot
  bots: DeskBot[]
  installed: DeskCli[]
  models: Record<DeskCli, { id: string; label: string }[]>
  efforts: Record<DeskCli, { id: string; label: string }[]>
  busy: boolean
  onSave: (bot: Omit<DeskBot, 'file'>) => Promise<string | null>
  onRemove?: () => void
  onOpenFile?: () => void
  onCancel: () => void
}): JSX.Element {
  void props
  return <></>
}
