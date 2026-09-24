export type ShownSettings<TBusiness> = {
  name: string
  businesses: TBusiness[]
}

export function startSettingsLoad<TSettings, TBusiness, TSlow>(
  io: {
    get: () => Promise<TSettings>
    list: () => Promise<TBusiness[]>
    slow: (signal: AbortSignal, shown: ShownSettings<TBusiness>) => Promise<TSlow>
  },
  onShow: (view: ShownSettings<TBusiness> & { settings: TSettings }) => void,
  onSlow: (value: TSlow) => void
): { cancel: () => void } {
  let cancelled = false
  const slowAbort = new AbortController()
  void (async () => {
    const settingsP = io.get()
    const listP = io.list()
    const settings = await settingsP
    if (cancelled) return
    const businesses = await listP
    if (cancelled) return
    const shown = { name: String((settings as { name?: string }).name || ''), businesses }
    onShow({ ...shown, settings })
    if (cancelled) return
    try {
      const value = await io.slow(slowAbort.signal, shown)
      if (cancelled || slowAbort.signal.aborted || value == null) return
      onSlow(value)
    } catch {
      if (cancelled || slowAbort.signal.aborted) return
    }
  })()
  return {
    cancel() {
      cancelled = true
      slowAbort.abort()
    }
  }
}
