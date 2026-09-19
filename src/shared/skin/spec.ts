import type { SkinActionId, SkinComponentId, SkinRisk } from './catalog'

export type SkinAction = { id: SkinActionId; label: string; risk: SkinRisk }

export type SkinSpec = {
  id: string
  component: SkinComponentId
  props: Record<string, unknown>
  actions: SkinAction[]
  source: string
}

export type SkinInEvent = {
  kind: string
  data?: string
  path?: string
  tool?: string
  commands?: { name: string; description?: string; hint?: string }[]
  used?: number
  total?: number
  percent?: number
  title?: string
  options?: { id: string; label: string }[]
  requestId?: string
  steps?: { title: string; status?: string }[]
}
