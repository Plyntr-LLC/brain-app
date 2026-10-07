import { useState } from 'react'
import type { JSX } from 'react'
import { CLI_LABEL, CONDUCTOR, DESCRIPTION_MAX, botSlug, descriptionError, type DeskBot, type DeskCli } from '@shared/desk'

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
  const { bot, bots, installed, models, efforts, busy, onSave, onRemove, onOpenFile, onCancel } = props
  const firstCli = installed[0] || bot?.cli || 'grok'
  const [name, setName] = useState(bot?.name || '')
  const [description, setDescription] = useState(bot?.description || '')
  const [cli, setCli] = useState<DeskCli>(bot?.cli && installed.includes(bot.cli) ? bot.cli : firstCli)
  const [model, setModel] = useState(bot?.model || 'default')
  const [effort, setEffort] = useState(bot?.effort || '')
  const [error, setError] = useState('')
  const [askRemove, setAskRemove] = useState(false)

  const modelList = models[cli] || []
  const shownModels = model && !modelList.some((m) => m.id === model) ? [...modelList, { id: model, label: model }] : modelList
  const effortList = efforts[cli] || []
  const count = description.trim().length

  function pickCli(next: DeskCli) {
    setCli(next)
    const ms = models[next] || []
    setModel(ms[0]?.id || 'default')
    const es = efforts[next] || []
    setEffort(es[0]?.id || '')
  }

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give them a name.')
      return
    }
    const over = descriptionError(description)
    if (over) {
      setError(over)
      return
    }
    const slug = botSlug(trimmed)
    const self = bot?.id
    const taken = bots.some((b) => b.id !== self && (b.name.trim().toLowerCase() === trimmed.toLowerCase() || b.id === slug))
    if (taken) {
      setError('That name is taken.')
      return
    }
    const err = await onSave({
      id: self || slug,
      name: trimmed,
      cli,
      model: model || 'default',
      effort: effortList.length ? effort || effortList[0].id : effort,
      description: description.trim()
    })
    setError(err || '')
  }

  return (
    <form
      className="desk-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        What do they do, and what won't they do?
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
      </label>
      <p className="tiny">{count}/{DESCRIPTION_MAX}</p>
      {installed.length ? (
        <label className="field">
          App
          <select value={cli} onChange={(e) => pickCli(e.target.value as DeskCli)}>
            {installed.map((c) => (
              <option key={c} value={c}>{CLI_LABEL[c]}</option>
            ))}
          </select>
        </label>
      ) : null}
      {shownModels.length ? (
        <label className="field">
          Model
          <select value={model || shownModels[0].id} onChange={(e) => setModel(e.target.value)}>
            {shownModels.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      {effortList.length ? (
        <label className="field">
          Effort
          <select value={effort || effortList[0].id} onChange={(e) => setEffort(e.target.value)}>
            {effortList.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      {error ? <p className="tiny">{error}</p> : null}
      <div className="actions">
        <button className="primary" type="submit">Save</button>
        <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
        {onOpenFile ? <button className="ghost" type="button" onClick={onOpenFile}>Open file</button> : null}
        {onRemove && bot?.id !== CONDUCTOR ? (
          <button className="ghost" type="button" disabled={busy} onClick={() => setAskRemove(true)}>Remove</button>
        ) : null}
      </div>
      {askRemove ? (
        <div>
          <p>Remove {bot?.name}?</p>
          <div className="actions">
            <button className="primary" type="button" onClick={() => onRemove?.()}>Remove</button>
            <button className="ghost" type="button" onClick={() => setAskRemove(false)}>Keep it</button>
          </div>
        </div>
      ) : null}
    </form>
  )
}
