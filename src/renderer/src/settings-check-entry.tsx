import { createRoot } from 'react-dom/client'
import { SettingsPanel } from './SettingsPanel'

type Slot = { resolve: (value: unknown) => void }

const slots: Record<string, Slot[]> = {}
const entered: string[] = []

function hang(name: string): Promise<unknown> {
  entered.push(name)
  return new Promise((resolve) => {
    const list = slots[name] || []
    list.push({ resolve })
    slots[name] = list
  })
}

function release(name: string, value: unknown) {
  const slot = (slots[name] || []).shift()
  if (!slot) throw new Error('nothing waiting for ' + name)
  slot.resolve(value)
}

function text() {
  return document.getElementById('root')?.textContent || ''
}

function sixEntered() {
  return ['rosterAt', 'companies', 'seats', 'health', 'skin', 'phone'].every((name) => entered.includes(name))
}

const brain = {
  settings: {
    get: () => hang('get'),
    list: () => hang('list'),
    rosterAt: () => hang('rosterAt'),
    roster: () => hang('roster'),
    team: () => hang('team'),
    projects: () => Promise.resolve([])
  },
  brains: {
    list: () => hang('list'),
    switch: () => Promise.resolve({ path: '', name: '' })
  },
  plyntr: {
    companies: () => hang('companies'),
    seats: (id?: string) => {
      seatIds.push(String(id || ''))
      return hang('seats')
    },
    active: () => Promise.resolve(activeNow),
    pending: () => Promise.resolve({ platform: false })
  },
  hqSync: {
    health: () => hang('health'),
    ownerStatus: () => Promise.resolve(bridgeNow),
    watchedRepo: () => watchedNow()
  },
  skin: {
    get: () => hang('skin'),
    list: () => Promise.resolve([]),
    onHealed: () => () => {}
  },
  phone: {
    status: () => hang('phone'),
    onStatus: () => () => {}
  },
  version: () => Promise.resolve('test'),
  onUpdate: () => () => {},
  setup: { onBack: () => () => {} },
  media: {
    status: () => Promise.resolve(mediaNow),
    shouldAsk: () => Promise.resolve(false),
    skip: () => Promise.resolve({ ok: true }),
    enable: () => Promise.resolve({ ok: true, fingerprint: '', detail: '' }),
    setPassphrase: () => Promise.resolve({ ok: true }),
    takePassphrase: () => Promise.resolve(null),
    takeRecoveryKey: () => Promise.resolve(null),
    add: () => Promise.resolve({ ok: false, status: 400, error: 'no', detail: '' }),
    setCap: () => Promise.resolve({ ok: true, capBytes: 0 }),
    turnOnBucket: () => Promise.resolve({ ok: true, bucket: '' }),
    allow: () => Promise.resolve({ ok: true, detail: '' }),
    requestCode: () => Promise.resolve({ ok: true, detail: '' }),
    reclaim: () => Promise.resolve({ ok: true, fingerprint: '', detail: '' }),
    invitePerson: () => Promise.resolve({ ok: true, detail: '' }),
    renameDevice: () => Promise.resolve({ ok: true, detail: '' }),
    revokeDevice: () => Promise.resolve({ ok: true, detail: '', kind: 'blocked' })
  }
}

;(window as unknown as { brain: typeof brain }).brain = brain

const lines: string[] = []
const root = createRoot(document.getElementById('root')!)
const seatIds: string[] = []
let activeNow: { syncMode?: string; brainId?: string; hasSeat?: boolean; role?: string; canMove?: boolean; seatEmail?: string } = {
  syncMode: 'plyntr',
  brainId: 'b1',
  hasSeat: true,
  role: 'owner',
  canMove: false,
  seatEmail: 'joe@plyntr.com'
}
let bridgeNow: {
  signedIn: boolean
  email: string
  kind: string
  hq_repo: string
  brain_label: string
  projects: { slug: string; path: string }[]
  seats: { seat_id: string; email: string; name: string; status: string; roots: string[]; kind: string }[]
  businesses: { id: string; name: string; hq_repo: string; owners: { email: string; name: string; role: string }[] }[]
} | null = null
let watchedNow: () => Promise<string> = () => Promise.resolve('')
let mediaNow = {
  routes: false,
  on: false,
  joining: false,
  hasSeatToken: false,
  fingerprint: '',
  usedBytes: 0,
  capBytes: null as number | null,
  bucketStatus: 'off' as const,
  waiting: [] as { deviceId: string; name: string; label: string; fingerprint: string; project: string; mine?: boolean }[],
  others: [] as { deviceId: string; name: string; label: string; fingerprint: string; project: string; mine?: boolean }[],
  projects: [] as { id: string; name: string; root: string }[],
  detail: ''
}

function mount() {
  entered.length = 0
  root.render(<SettingsPanel role="owner" onClose={() => undefined} />)
}
function show(role: string) {
  root.render(<SettingsPanel role={role} onClose={() => undefined} />)
}
function unmount() {
  root.render(<div />)
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

const teamOnly = [{ name: 'TeamOnly', email: 'team@example.com', role: 'team', brain: 'hq' }]
const rosterWins = [{ name: 'RosterWins', email: 'roster@example.com', role: 'team', brain: 'hq' }]

function hqValue() {
  const input = Array.from(document.querySelectorAll('input')).find(
    (el) => el.getAttribute('placeholder') === 'acme-org/acme-hq-brain'
  )
  return input ? (input as HTMLInputElement).value : ''
}

async function run() {
  const joe = { name: 'Joe', superAdmin: true, email: 'joe@plyntr.com', role: 'owner', brainPath: '/tmp/Rose', brainName: 'Rose' }
  const ada = { name: 'Ada', superAdmin: true, email: 'joe@plyntr.com', role: 'owner', brainPath: '/tmp/Reed', brainName: 'Reed' }
  const bea = { name: 'Bea', superAdmin: true, email: 'joe@plyntr.com', role: 'owner', brainPath: '/tmp/Offmac', brainName: 'Offmac' }
  const rose = [{ path: '/tmp/Rose', name: 'Rose', slug: 'rose', current: true, brainId: 'b1' }]
  const reed = [{ path: '/tmp/Reed', name: 'Reed', slug: 'reed', current: true, brainId: 'b1' }]
  const offmac = [
    { path: '/tmp/Decoy', name: 'Decoy', slug: 'decoy', current: false, brainId: 'b-decoy' },
    { path: '/tmp/Offmac', name: 'Offmac', slug: 'off', current: true, brainId: 'b1' }
  ]

  mount()
  await tick()
  if (!(slots.get || [])[0] || !(slots.list || [])[0]) throw new Error('get and list did not start together')
  release('get', joe)
  await tick()
  if (text().includes('Joe') || text().includes('Rose') || sixEntered()) throw new Error('name shown before the list')
  lines.push('name-alone-hidden')
  unmount()
  await tick()
  await tick()
  release('list', rose)
  await tick()
  if ((slots.rosterAt || []).length) throw new Error('closed load started roster')
  if (text().includes('Joe') || text().includes('Rose')) throw new Error('closed read still painted')
  lines.push('close-cancels')

  mount()
  await tick()
  if (!(slots.get || [])[0] || !(slots.list || [])[0]) throw new Error('get and list did not start together')
  release('get', ada)
  release('list', reed)
  for (let i = 0; i < 40 && !(slots.rosterAt || [])[0]; i += 1) await tick()
  if (!(slots.rosterAt || [])[0]) throw new Error('rosterAt did not start')
  if (text().includes('Ada') || text().includes('Reed') || text().includes('TeamOnly')) throw new Error('painted before rosterAt')
  const rosterWaiting = (slots.roster || []).length
  unmount()
  await tick()
  await tick()
  release('rosterAt', [{ name: 'Poison', email: 'poison@example.com', role: 'team', brain: 'hq' }])
  await tick()
  await tick()
  if ((slots.roster || []).length !== rosterWaiting) throw new Error('cancelled load called roster')
  if ((slots.team || []).length) throw new Error('cancelled load called team')
  if (text().includes('Poison') || text().includes('Ada')) throw new Error('cancelled load painted')
  lines.push('cancel-drops-roster')

  mount()
  await tick()
  release('list', reed)
  await tick()
  if (text().includes('Ada') || text().includes('Reed') || sixEntered()) throw new Error('list shown before the name')
  lines.push('list-alone-hidden')
  release('get', ada)
  for (let i = 0; i < 40 && !(slots.rosterAt || [])[0]; i += 1) await tick()
  if (text().includes('Ada') || text().includes('Reed') || text().includes('TeamOnly')) throw new Error('painted before rosterAt')
  release('rosterAt', [{ name: 'AdaRoster', email: 'ada@example.com', role: 'team', brain: 'hq' }])
  for (let i = 0; i < 40 && !(slots.roster || [])[0]; i += 1) await tick()
  if (!(slots.roster || [])[0]) throw new Error('roster did not start')
  if (text().includes('Ada') || text().includes('TeamOnly')) throw new Error('painted before roster()')
  release('roster', [])
  for (let i = 0; i < 40 && !(slots.team || [])[0]; i += 1) await tick()
  if (!(slots.team || [])[0]) throw new Error('empty roster did not ask team')
  if (text().includes('TeamOnly')) throw new Error('painted before team()')
  release('team', teamOnly)
  for (let i = 0; i < 40 && !(text().includes('Ada') && text().includes('Reed') && text().includes('TeamOnly')); i += 1) await tick()
  if (!text().includes('Ada') || !text().includes('Reed') || !text().includes('TeamOnly')) {
    throw new Error('both reads did not show: ' + text())
  }
  for (let i = 0; i < 40 && !sixEntered(); i += 1) await tick()
  if (!sixEntered()) throw new Error('slow calls did not start')
  lines.push('shown-before-slow Ada Reed TeamOnly')
  const firstSix = {
    companies: slots.companies[0],
    seats: slots.seats[0],
    health: slots.health[0],
    skin: slots.skin[0],
    phone: slots.phone[0]
  }
  unmount()
  await tick()
  lines.push('close-cancels')

  mount()
  await tick()
  release('get', bea)
  await tick()
  if (text().includes('Bea') || text().includes('Offmac')) throw new Error('second name showed early')
  release('list', offmac)
  for (let i = 0; i < 40 && (slots.rosterAt || []).length < 2; i += 1) await tick()
  if ((slots.rosterAt || []).length < 2) throw new Error('expected a rosterAt call per folder')
  if (text().includes('Bea') || text().includes('RosterWins')) throw new Error('painted before rosterAt')
  release('rosterAt', [{ name: 'M2roster', email: 'm2@example.com', role: 'team', brain: 'hq' }])
  release('rosterAt', [])
  for (let i = 0; i < 40 && !(slots.roster || [])[0]; i += 1) await tick()
  const teamBefore = (slots.team || []).length
  release('roster', rosterWins)
  await tick()
  await tick()
  if ((slots.team || []).length !== teamBefore) throw new Error('non-empty roster still asked team')
  for (let i = 0; i < 40 && !(text().includes('Bea') && text().includes('Offmac') && text().includes('RosterWins')); i += 1) await tick()
  if (!text().includes('RosterWins') || text().includes('TeamOnly')) throw new Error('roster row did not win: ' + text())
  lines.push('roster-wins')
  const finishHeld = (name: string, slot: Slot, value: unknown) => {
    slots[name] = (slots[name] || []).filter((item) => item !== slot)
    slot.resolve(value)
  }
  finishHeld('companies', firstSix.companies, [{ brainId: 'b1', label: 'M1company', pack: '' }])
  finishHeld('seats', firstSix.seats, { seats: [{ id: 's', email: 'm1@example.com', name: 'M1seat', role: 'team', status: 'active' }], invites: [], pack: '' })
  finishHeld('health', firstSix.health, { lastSync: 'M1health' })
  finishHeld('skin', firstSix.skin, { joe: true, capture: false, jev: false, jevReady: false, components: [], learned: [{ cli: 'grok', eventKind: 'x', component: 'M1skin', confidence: 1 }] })
  finishHeld('phone', firstSix.phone, { on: false, url: '', origin: '', detail: 'M1phone', platform: '', watching: false, pairPin: '', pairQr: '', pairUntil: 0, devices: [] })
  await tick()
  const stale = text()
  if (['M1roster', 'M1company', 'M1seat', 'M1health', 'M1skin', 'M1phone', 'Ada', 'Reed', 'Joe', 'Rose', 'TeamOnly'].some((word) => stale.includes(word))) {
    throw new Error('stale open painted: ' + stale)
  }
  if (!stale.includes('Bea') || !stale.includes('Offmac') || !stale.includes('RosterWins')) throw new Error('second open lost its name: ' + stale)
  lines.push('stale-open-ignored')
  for (let i = 0; i < 40 && !sixEntered(); i += 1) await tick()
  if (!sixEntered()) throw new Error('slow calls did not start')
  if (seatIds[seatIds.length - 1] !== 'b1') throw new Error('seats used ' + seatIds.join(','))
  lines.push('seats-follow-active')
  release('companies', [{ brainId: 'b1', label: 'M2company', pack: '' }])
  release('seats', { seats: [{ id: 's2', email: 'm2@example.com', name: 'M2seat', role: 'team', status: 'active' }], invites: [], pack: '' })
  release('health', { lastSync: 'M2health' })
  release('skin', { joe: true, capture: false, jev: false, jevReady: false, components: [], learned: [{ cli: 'grok', eventKind: 'x', component: 'M2skin', confidence: 1 }] })
  release('phone', { on: false, url: '', origin: '', detail: 'M2phone', platform: '', watching: false, pairPin: '', pairQr: '', pairUntil: 0, devices: [] })
  for (let i = 0; i < 40; i += 1) {
    const now = text()
    if (['M2roster', 'M2company', 'M2seat', 'M2phone', 'Last sync on this Mac is saved.'].every((word) => now.includes(word))) break
    await tick()
  }
  const catalog = Array.from(document.querySelectorAll('button')).find((button) =>
    (button.textContent || '').includes('Catalog school')
  )
  catalog?.click()
  await tick()
  const done = text()
  for (const word of ['Bea', 'Offmac', 'M2roster', 'M2company', 'M2seat', 'M2skin', 'M2phone', 'Last sync on this Mac is saved.']) {
    if (!done.includes(word)) throw new Error('missing ' + word + ' in ' + done)
  }
  if (done.includes('TeamOnly') || done.includes('RosterWins')) throw new Error('local people still shown in plyntr mode: ' + done)
  if (!done.includes('This brain is signed in as')) throw new Error('plyntr sign-in line missing')
  lines.push('slow-results-applied')

  bridgeNow = {
    signedIn: true,
    email: 'joe@plyntr.com',
    kind: 'owner',
    hq_repo: 'acme/hq',
    brain_label: '',
    projects: [],
    seats: [],
    businesses: []
  }
  watchedNow = () => Promise.resolve('other/brain')
  show('scout')
  await tick()
  await tick()
  release('get', bea)
  release('list', offmac)
  for (let i = 0; i < 40 && (slots.rosterAt || []).length < 2; i += 1) await tick()
  release('rosterAt', [])
  release('rosterAt', [])
  for (let i = 0; i < 40 && !(slots.roster || [])[0]; i += 1) await tick()
  release('roster', [])
  for (let i = 0; i < 40 && !(slots.team || [])[0]; i += 1) await tick()
  release('team', teamOnly)
  for (const name of ['companies', 'seats', 'health', 'skin', 'phone']) {
    for (let i = 0; i < 40 && !(slots[name] || [])[0]; i += 1) await tick()
    release(name, name === 'companies' ? [] : name === 'seats' ? { seats: [], invites: [], pack: '' } : name === 'health' ? { lastSync: '' } : name === 'skin' ? { joe: false, capture: false, jev: false, jevReady: false, components: [], learned: [] } : { on: false, url: '', origin: '', detail: '', platform: '', watching: false, pairPin: '', pairQr: '', pairUntil: 0, devices: [] })
  }
  const projectFoldBtn = Array.from(document.querySelectorAll('button')).find((button) =>
    (button.textContent || '').includes('Project-only people')
  )
  if (projectFoldBtn && !text().includes('This folder is other/brain')) projectFoldBtn.click()
  for (let i = 0; i < 40 && !text().includes('This folder is other/brain'); i += 1) await tick()
  if (!text().includes('This folder is other/brain')) throw new Error('watched repo did not show: ' + text())
  if (!text().includes('This brain is signed in as')) throw new Error('plyntr mode dropped early')
  lines.push('watched-repo-shown')

  activeNow = { syncMode: 'agency-brain' }
  watchedNow = () => Promise.reject(new Error('no repo'))
  const seatsBefore = (slots.seats || []).length
  show('member')
  await tick()
  await tick()
  release('get', bea)
  release('list', offmac)
  for (let i = 0; i < 40 && (slots.rosterAt || []).length < 2; i += 1) await tick()
  release('rosterAt', [])
  release('rosterAt', [])
  for (let i = 0; i < 40 && !(slots.roster || [])[0]; i += 1) await tick()
  release('roster', [])
  for (let i = 0; i < 40 && !(slots.team || [])[0]; i += 1) await tick()
  release('team', teamOnly)
  await tick()
  await tick()
  if ((slots.seats || []).length !== seatsBefore) throw new Error('inactive sync asked for seats')
  for (const name of ['companies', 'health', 'skin', 'phone']) {
    for (let i = 0; i < 40 && !(slots[name] || [])[0]; i += 1) await tick()
    release(name, name === 'companies' ? [] : name === 'health' ? { lastSync: '' } : name === 'skin' ? { joe: false, capture: false, jev: false, jevReady: false, components: [], learned: [] } : { on: false, url: '', origin: '', detail: '', platform: '', watching: false, pairPin: '', pairQr: '', pairUntil: 0, devices: [] })
  }
  for (let i = 0; i < 40; i += 1) {
    const now = text()
    if (now.includes('TeamOnly') && !now.includes('This brain is signed in as') && !now.includes('This folder is other/brain') && hqValue() === 'acme/hq') break
    await tick()
  }
  const cleared = text()
  if (!cleared.includes('TeamOnly')) throw new Error('inactive sync left local people hidden: ' + cleared)
  if (cleared.includes('This brain is signed in as')) throw new Error('inactive sync left plyntr mode on: ' + cleared)
  if (cleared.includes('This folder is other/brain')) throw new Error('watched failure kept the old folder: ' + cleared)
  if (hqValue() !== 'acme/hq') throw new Error('watched failure did not clear the folder repo: ' + hqValue())
  lines.push('inactive-clears-plyntr')
  lines.push('watched-repo-cleared')

  async function fillRosterAndSlow() {
    for (let i = 0; i < 40 && (slots.rosterAt || []).length < 1; i += 1) await tick()
    while ((slots.rosterAt || [])[0]) release('rosterAt', [])
    for (let i = 0; i < 40 && !(slots.roster || [])[0]; i += 1) await tick()
    if ((slots.roster || [])[0]) release('roster', [])
    for (let i = 0; i < 40 && !(slots.team || [])[0]; i += 1) await tick()
    if ((slots.team || [])[0]) release('team', teamOnly)
    for (const name of ['companies', 'seats', 'health', 'skin', 'phone']) {
      for (let i = 0; i < 40 && !(slots[name] || [])[0]; i += 1) await tick()
      if ((slots[name] || [])[0]) {
        release(
          name,
          name === 'companies'
            ? []
            : name === 'seats'
              ? { seats: [], invites: [], pack: '' }
              : name === 'health'
                ? { lastSync: '' }
                : name === 'skin'
                  ? { joe: false, capture: false, jev: false, jevReady: false, components: [], learned: [] }
                  : { on: false, url: '', origin: '', detail: '', platform: '', watching: false, pairPin: '', pairQr: '', pairUntil: 0, devices: [] }
        )
      }
    }
    for (let i = 0; i < 40; i += 1) await tick()
  }

  mediaNow = { ...mediaNow, routes: true, on: false, hasSeatToken: true }
  unmount()
  await tick()
  show('owner')
  await tick()
  release('get', { name: 'Bea', superAdmin: true, email: 'joe@plyntr.com', role: 'owner', brainPath: '/tmp/Offmac', brainName: 'Offmac' })
  release('list', offmac)
  await fillRosterAndSlow()
  {
    const section = document.querySelector('section.biz.current')
    const t = section?.textContent || ''
    for (let i = 0; i < 40 && !section?.querySelector('[data-media-block="1"]'); i += 1) await tick()
    const media = document.querySelector('section.biz.current [data-media-block="1"]')
    const fold = Array.from(document.querySelectorAll('section.biz.current button.set-fold')).find((button) =>
      (button.textContent || '').includes('Project-only people')
    )
    if (!media) throw new Error('owner branch missing media block: ' + t)
    if (!fold) throw new Error('owner branch missing project fold: ' + t)
    if (!(media.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('media block was not between localSyncOffer and Project-only people')
    }
    if (!(media.textContent || '').includes('Use Plyntr storage')) throw new Error('owner branch missing storage switch')
    for (let i = 0; i < 40; i += 1) {
      const live = document.querySelector('section.biz.current')
      const capReady = Array.from(live?.querySelectorAll('label.field') || []).some((el) =>
        (el.textContent || '').includes('Storage limit (GB)')
      )
      if (capReady) break
      await tick()
    }
    const pack = Array.from(section?.querySelectorAll('label.field') || []).find(
      (el) => (el.textContent || '').includes('Plan') && el.querySelector('select')
    )
    const cap = Array.from(section?.querySelectorAll('label.field') || []).find((el) =>
      (el.textContent || '').includes('Storage limit (GB)')
    )
    const turnOn = Array.from(section?.querySelectorAll('button') || []).find((button) =>
      (button.textContent || '').includes('Turn on storage for this brain')
    )
    if (!pack) throw new Error('owner branch missing PackSelect: ' + t)
    if (!cap) throw new Error('owner branch missing storage cap field: ' + t)
    if (!turnOn) throw new Error('owner branch missing turn-on storage button: ' + t)
    if (!(pack.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('storage cap field was not under PackSelect')
    }
    if (!(cap.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('storage cap field was not above the Videos block')
    }
    lines.push('media-block-owner')
    lines.push('storage-cap-under-pack')
  }

  unmount()
  await tick()
  show('team')
  await tick()
  release('get', { name: 'Pat', superAdmin: false, email: 'pat@example.com', role: 'team', brainPath: '/tmp/Offmac', brainName: 'Offmac' })
  release('list', offmac)
  await fillRosterAndSlow()
  {
    const section = document.querySelector('section.biz.current')
    for (let i = 0; i < 40 && !section?.querySelector('[data-media-block="1"]'); i += 1) await tick()
    const current = document.querySelector('section.biz.current')
    const t = current?.textContent || ''
    const media = current?.querySelector('[data-media-block="1"]')
    const you = Array.from(current?.querySelectorAll('p') || []).find((p) => (p.textContent || '').startsWith('You are Team'))
    if (!media) throw new Error('team branch missing media block: ' + t)
    if (!you) throw new Error('team branch missing You are line: ' + t)
    if (!(media.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error('media block was not between localSyncOffer and You are')
    }
    if (current?.querySelector('button.set-fold')) throw new Error('team branch showed add-users fold')
    if ((current?.textContent || '').includes('Storage limit (GB)')) {
      throw new Error('team branch showed the superadmin storage cap')
    }
    if ((current?.textContent || '').includes('Turn on storage for this brain')) {
      throw new Error('team branch showed turn-on storage')
    }
    lines.push('media-block-team')
  }

  mediaNow = { ...mediaNow, routes: false, hasSeatToken: false }
  unmount()
  await tick()
  show('owner')
  await tick()
  release('get', { name: 'Bea', superAdmin: true, email: 'joe@plyntr.com', role: 'owner', brainPath: '/tmp/Offmac', brainName: 'Offmac' })
  release('list', offmac)
  await fillRosterAndSlow()
  if (text().includes('Videos and images')) throw new Error('packed hide failed: media block showed on 404')
  if (text().includes('Storage limit (GB)')) throw new Error('packed hide showed the storage cap')
  if (text().includes('Turn on storage for this brain')) throw new Error('packed hide showed turn-on storage')
  lines.push('media-block-hidden')

  ;(window as unknown as { __settingsResult?: unknown }).__settingsResult = { ok: true, lines }
}

void run().catch((err) => {
  ;(window as unknown as { __settingsResult?: unknown }).__settingsResult = { ok: false, lines, error: String(err && err.message || err) }
})
