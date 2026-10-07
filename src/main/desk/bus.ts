import { CONDUCTOR, ME, SEND_CAP_PER_JOB, resolveBot } from '../../shared/desk.ts'
import type { DeskKind, DeskMessage } from '../../shared/desk.ts'
import { SENTENCE } from './fences.ts'
import { foldMessages } from './store.ts'
import type { DeskStore, NewDeskMessage } from './store.ts'

/**
 * The local bus: per-bot inboxes, job ids, the loop guard, and the one job close rule.
 * Every message a turn produces goes through `post` so the bus sees it; mail is still written only by
 * the store. The bus never spawns. It calls `wake(turn)` and the controller ends that turn with `endTurn`.
 */

export const LATE_TEXT = 'That handoff arrived after the work was already done.'
export const STOPPED_JOB_TEXT = 'Stopped.'

export type Turn = { id: number; botId: string; job?: string; batch: DeskMessage[] }
export type WakeFn = (turn: Turn) => unknown

export type PostResult =
  | { status: 'queued'; msg: DeskMessage; started: boolean } // in the receiver's inbox; `started` when a turn took it now
  | { status: 'stored'; msg: DeskMessage } // to `me`, or a stamp on a job that already closed: nobody wakes
  | { status: 'late'; msg: DeskMessage } // the late system line; the message was not delivered
  | { status: 'held'; msg: DeskMessage } // the loop system line; the send waits for continueJob or stopJob
  | { status: 'error'; error: string } // nothing written

export type BusState =
  | { state: 'working'; job?: string }
  | { state: 'waiting-you' }
  | { state: 'waiting-bot'; on: string }
  | { state: 'idle' }

export type JobView = {
  running: { botId: string; job?: string }[]
  queued: { job?: string }[] // every inbox message, held sends included
  mail: DeskMessage[] // the whole file, unfolded
  live: string[] // bot ids on the roster; a removed bot's tile holds nothing
}

/** Email and text tiles whose visible copy has no `actedAt` (Not now still counts), and holds with no answer. */
export function unansweredTiles(mail: DeskMessage[], live: string[]): DeskMessage[] {
  const bots = new Set(live)
  return foldMessages(mail).filter((m) => {
    if (!bots.has(m.from)) return false
    if (m.kind === 'email' || m.kind === 'text') return !m.actedAt
    if (m.kind === 'hold') return !m.hold?.answer
    return false
  })
}

/**
 * The one close rule. A job stays open while a bot has a running turn on it, an inbox holds a message
 * for it, or a live bot has an unanswered tile or hold on it. Waiting for a teammate does not hold it.
 */
export function jobIsOpen(job: string, v: JobView): boolean {
  return (
    v.running.some((r) => r.job === job) ||
    v.queued.some((q) => q.job === job) ||
    unansweredTiles(v.mail, v.live).some((t) => t.job === job)
  )
}

type Source = 'person' | 'conductor' | 'worker' | 'answer'
type Item = { msg: DeskMessage; source: Source }
type Held = { input: NewDeskMessage; to: string; job: string }
type Running = { turn: Turn; kinds: DeskKind[]; lastSendTo?: string }

const TILE_KINDS: DeskKind[] = ['email', 'text', 'hold', 'browse', 'report']

export type DeskBus = ReturnType<typeof createDeskBus>

export function createDeskBus(opts: { store: DeskStore; wake: WakeFn }) {
  const { store } = opts
  const inbox = new Map<string, Item[]>()
  const held = new Map<string, Held[]>()
  const running = new Map<string, Running>()
  const openJobs = new Map<string, string>()
  const waitingOn = new Map<string, string>()
  const paused = new Set<string>()
  const closed = new Set<string>()
  const born = new Map<string, { ts: number; seq: number }>()
  const sent = new Map<string, number>()
  const allowance = new Map<string, number>()
  let seq = 0
  let turnSeq = 0
  let draining = false
  let again = false

  const liveIds = () => store.readBots().map((b) => b.id)
  const nameOf = (id: string) => (id === ME ? 'You' : store.names()[id] || id)
  const items = (botId: string) => inbox.get(botId) || []
  const allQueued = (): { job?: string }[] => [
    ...[...inbox.values()].flat().map((i) => ({ job: i.msg.job })),
    ...[...held.values()].flat().map((h) => ({ job: h.job }))
  ]

  function noteBorn(m: DeskMessage) {
    if (!m.job || born.has(m.job)) return
    const ts = Date.parse(m.ts)
    born.set(m.job, { ts: Number.isNaN(ts) ? 0 : ts, seq: seq++ })
  }

  /** Oldest by the `ts` of the first message that carries the job, never by the id's spelling. */
  function oldest(jobs: (string | undefined)[]): string | undefined {
    const rank = (j: string) => born.get(j) || { ts: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER }
    let best: string | undefined
    for (const j of jobs) {
      if (!j) continue
      if (!best) best = j
      else {
        const a = rank(j)
        const b = rank(best)
        if (a.ts < b.ts || (a.ts === b.ts && a.seq < b.seq)) best = j
      }
    }
    return best
  }

  function newJob(): string {
    let id = store.newId('j')
    while (born.has(id) || closed.has(id)) id = store.newId('j')
    return id
  }

  function openTiles(): DeskMessage[] {
    return unansweredTiles(store.readMail(), liveIds()).filter((t) => !t.job || !closed.has(t.job))
  }

  // Restart: a job with an unanswered tile is open and is that bot's open job. Every other job is done.
  {
    const mail = store.readMail()
    for (const m of mail) {
      noteBorn(m)
      if (m.kind === 'send' && m.job) sent.set(m.job, (sent.get(m.job) || 0) + 1)
    }
    const tiles = unansweredTiles(mail, liveIds())
    for (const job of born.keys()) if (!tiles.some((t) => t.job === job)) closed.add(job)
    for (const t of tiles) if (t.job && t.from !== CONDUCTOR) openJobs.set(t.from, t.job)
    for (const [job, n] of sent) allowance.set(job, Math.max(SEND_CAP_PER_JOB, Math.ceil(n / SEND_CAP_PER_JOB) * SEND_CAP_PER_JOB))
  }

  function pickJob(from: string, to: string, kind: DeskKind): string | undefined {
    if (to === ME) return running.get(from)?.turn.job
    if (kind === 'pack') return newJob()
    if (from === ME) return to === CONDUCTOR ? undefined : openJobs.get(to) || newJob()
    if (from === CONDUCTOR) return openJobs.get(to) || running.get(CONDUCTOR)?.turn.job || newJob()
    return running.get(from)?.turn.job || openJobs.get(from) || newJob()
  }

  function sourceOf(from: string): Source {
    return from === ME ? 'person' : from === CONDUCTOR ? 'conductor' : 'worker'
  }

  /**
   * Writes through the store, then tracks job age, the send count, and waiting-for-a-teammate.
   * A tile stamp carries the tile bot's `from` but is not that bot's turn output, so it is not tracked.
   */
  function append(input: NewDeskMessage, track = true): { msg: DeskMessage; error: string | null } {
    const clean = { ...input } as NewDeskMessage
    if (clean.job === undefined) delete clean.job
    const res = store.appendMail(clean)
    if (res.error) return res
    const msg = res.msg
    noteBorn(msg)
    if (!track) return { msg, error: null }
    if (msg.kind === 'send' && msg.job) sent.set(msg.job, (sent.get(msg.job) || 0) + 1)
    const run = running.get(msg.from)
    if (run) {
      run.kinds.push(msg.kind)
      if (msg.kind === 'send') run.lastSendTo = msg.to
    }
    if (msg.kind === 'send' || msg.kind === 'report') {
      waitingOn.delete(msg.from)
      for (const [w, on] of waitingOn) if (on === msg.from) waitingOn.delete(w)
    }
    if (msg.from === ME && msg.to !== ME) waitingOn.delete(msg.to)
    return { msg, error: null }
  }

  function enqueue(botId: string, msg: DeskMessage, source: Source): boolean {
    inbox.set(botId, [...items(botId), { msg, source }])
    drain()
    return Boolean(running.get(botId)?.turn.batch.some((m) => m.id === msg.id))
  }

  /** Starts one turn for this bot when its inbox has something it may take now. */
  function tryWake(botId: string, tiles: DeskMessage[]): Turn | null {
    if (running.has(botId) || paused.has(botId)) return null
    const queue = items(botId)
    if (!queue.length) return null
    let job: string | undefined
    let take: Item[]
    if (botId === CONDUCTOR) {
      // Every person message, plus only the oldest job's worker sends.
      job = oldest(queue.map((i) => i.msg.job))
      take = queue.filter((i) => !i.msg.job || i.msg.job === job)
    } else {
      job = openJobs.get(botId) || oldest(queue.map((i) => i.msg.job))
      // Waiting on you: a person, the conductor, or the tile answer starts a turn. A worker send waits.
      const waitingYou = tiles.some((t) => t.from === botId)
      take = queue.filter((i) => i.msg.job === job && (!waitingYou || i.source !== 'worker'))
      if (take.length && job) openJobs.set(botId, job)
    }
    if (!take.length) return null
    inbox.set(botId, queue.filter((i) => !take.includes(i)))
    const turn: Turn = { id: ++turnSeq, botId, job, batch: take.map((i) => i.msg) }
    running.set(botId, { turn, kinds: [] })
    try {
      const r = opts.wake(turn) as Promise<unknown> | undefined
      if (r && typeof r.then === 'function') r.then(undefined, () => bus.endTurn(botId, turn.id))
    } catch {
      bus.endTurn(botId, turn.id)
    }
    return turn
  }

  /** Force-closes a job: drops its queued and held messages and frees the bots whose open job it was. */
  function forceClose(job: string) {
    held.delete(job)
    for (const [id, queue] of inbox) inbox.set(id, queue.filter((i) => i.msg.job !== job))
    markClosed(job)
  }

  function markClosed(job: string) {
    closed.add(job)
    for (const [id, j] of openJobs) {
      if (j !== job) continue
      openJobs.delete(id)
      waitingOn.delete(id)
    }
  }

  /**
   * Two workers each holding a message for the other's open job, with no running turn and no unanswered
   * tile on either job: the newer job stops. The line is from that job's owner, who is named first.
   */
  function breakDeadlock(): boolean {
    const workers = [...openJobs.keys()].filter((id) => id !== CONDUCTOR)
    let tiles: DeskMessage[] | null = null
    for (const a of workers) {
      for (const b of workers) {
        const ja = openJobs.get(a)
        const jb = openJobs.get(b)
        if (a === b || !ja || !jb || ja === jb) continue
        if (!items(a).some((i) => i.msg.job === jb) || !items(b).some((i) => i.msg.job === ja)) continue
        tiles ??= openTiles()
        const open = tiles
        const busy = (j: string) => [...running.values()].some((r) => r.turn.job === j) || open.some((t) => t.job === j)
        if (busy(ja) || busy(jb)) continue
        const newer = oldest([ja, jb]) === ja ? jb : ja
        const owner = newer === ja ? a : b
        const other = owner === a ? b : a
        forceClose(newer)
        append({
          from: owner,
          to: ME,
          kind: 'stopped',
          job: newer,
          text: `Stopped. ${nameOf(owner)} and ${nameOf(other)} were each waiting on the other.`,
          inputs: []
        })
        return true
      }
    }
    return false
  }

  function drain() {
    if (draining) {
      again = true
      return
    }
    draining = true
    try {
      do {
        again = false
        let tiles = openTiles()
        for (const id of [...inbox.keys()]) {
          if (tryWake(id, tiles)) tiles = openTiles()
        }
        if (!again && breakDeadlock()) again = true
      } while (again)
    } finally {
      draining = false
    }
  }

  function deliver(input: NewDeskMessage, to: string, job: string | undefined): PostResult {
    const { msg, error } = append({ ...input, to, job })
    if (error) return { status: 'error', error }
    return { status: 'queued', msg, started: enqueue(to, msg, sourceOf(msg.from)) }
  }

  const bus = {
    /**
     * Stores a message and, when `to` is a bot, puts it in that bot's inbox and wakes it if it may start.
     * Leave `job` unset and the bus picks it: a pack starts a job; a person message to a worker joins its
     * open job or starts one; to the conductor it has none; a conductor send joins the receiver's open job,
     * else the conductor turn's job, else starts one; a worker send carries the sender's job; anything to
     * `me` from a running bot carries that turn's job.
     */
    post(input: NewDeskMessage): PostResult {
      const bots = store.readBots()
      let to = input.to
      if (to !== ME) {
        const bot = resolveBot(bots, to)
        if (!bot) return { status: 'error', error: SENTENCE.unknownBot(String(to || '').trim()) }
        to = bot.id
      }
      const from = input.from === ME ? ME : resolveBot(bots, input.from)?.id || input.from
      const job = input.job !== undefined ? input.job : pickJob(from, to, input.kind)
      const base = { ...input, from }
      if (to === ME) {
        const { msg, error } = append({ ...base, to, job })
        return error ? { status: 'error', error } : { status: 'stored', msg }
      }
      if (job && closed.has(job)) {
        const { msg, error } = append({ from: ME, to: ME, kind: 'system', system: 'late', job, text: LATE_TEXT })
        return error ? { status: 'error', error } : { status: 'late', msg }
      }
      if (input.kind === 'send' && job) {
        const waiting = held.get(job) || []
        const cap = allowance.get(job) || SEND_CAP_PER_JOB
        if (waiting.length || (sent.get(job) || 0) >= cap) {
          held.set(job, [...waiting, { input: base, to, job }])
          // The line names the two bots on the held send.
          const line = waiting.length
            ? null
            : append({
                from,
                to: ME,
                kind: 'system',
                system: 'loop',
                job,
                text: `${nameOf(from)} and ${nameOf(to)} have passed this back and forth ${SEND_CAP_PER_JOB} times.`
              })
          if (line?.error) {
            held.set(job, waiting)
            return { status: 'error', error: line.error }
          }
          const loop = line?.msg || store.readMail().filter((m) => m.system === 'loop' && m.job === job).pop()
          return { status: 'held', msg: loop as DeskMessage }
        }
      }
      return deliver(base, to, job)
    },

    /**
     * A Send, Approve, or Not now stamp. Stores the replacement (from, to, and job copied from the tile
     * it replaces when unset) and wakes the tile's bot with it. When that job already closed, the stamp
     * is stored and nobody wakes.
     */
    answer(input: NewDeskMessage): PostResult {
      const target = input.replaces ? store.readMail().find((m) => m.id === input.replaces) : undefined
      const from = input.from || target?.from || ME
      const job = input.job !== undefined ? input.job : target?.job
      const { msg, error } = append({ ...input, from, to: input.to || target?.to || ME, job }, false)
      if (error) return { status: 'error', error }
      if (!job || closed.has(job) || from === ME || !liveIds().includes(from)) return { status: 'stored', msg }
      return { status: 'queued', msg, started: enqueue(from, msg, 'answer') }
    },

    /** Tries to start this bot's next turn. An empty inbox, a running turn, or nothing it may take: null. */
    wake(botId: string): Turn | null {
      return tryWake(botId, openTiles())
    },

    /**
     * Ends a running turn (a stale `turnId` does nothing), sets waiting-for-a-teammate when the turn ended
     * on sends with no tile, browse, or report, runs the close rule on its job, and wakes whoever may go.
     * A stopped or error line posted after this has no running turn to take a job from: set `job` from the return.
     */
    endTurn(botId: string, turnId?: number): { job?: string; open: boolean } {
      const run = running.get(botId)
      if (!run || (turnId != null && run.turn.id !== turnId)) return { open: false }
      running.delete(botId)
      const job = run.turn.job
      const onSends = run.lastSendTo && !run.kinds.some((k) => TILE_KINDS.includes(k))
      if (onSends && !(job && closed.has(job))) waitingOn.set(botId, run.lastSendTo as string)
      if (job) bus.checkJob(job)
      drain()
      return { job, open: job ? !closed.has(job) : false }
    },

    /** The close rule through `jobIsOpen`. A job it finds empty closes for good, and queued work may start. */
    checkJob(job: string): { open: boolean } {
      if (closed.has(job)) return { open: false }
      const view: JobView = {
        running: [...running.values()].map((r) => ({ botId: r.turn.botId, job: r.turn.job })),
        queued: allQueued(),
        mail: store.readMail(),
        live: liveIds()
      }
      if (jobIsOpen(job, view)) return { open: true }
      markClosed(job)
      drain()
      return { open: false }
    },

    /** Let them continue: delivers the held sends. The first counts as 1 of the next 10. */
    continueJob(job: string): DeskMessage[] {
      const waiting = held.get(job) || []
      if (!waiting.length || closed.has(job)) return []
      held.delete(job)
      allowance.set(job, (allowance.get(job) || SEND_CAP_PER_JOB) + SEND_CAP_PER_JOB)
      const out: DeskMessage[] = []
      for (const h of waiting) {
        const res = deliver(h.input, h.to, h.job)
        if (res.status === 'queued') out.push(res.msg)
      }
      return out
    },

    /**
     * Stop them: drops the held send and the job's queued messages, closes the job, and posts "Stopped."
     * Returns the bots whose running turn is that job; the controller kills those children.
     */
    stopJob(job: string): { msg: DeskMessage | null; bots: string[] } {
      if (closed.has(job)) return { msg: null, bots: [] }
      const bots = [...running.values()].filter((r) => r.turn.job === job).map((r) => r.turn.botId)
      const from = held.get(job)?.[0]?.input.from || bots[0] || ME
      forceClose(job)
      for (const id of bots) waitingOn.delete(id)
      const { msg } = append({ from, to: ME, kind: 'stopped', job, text: STOPPED_JOB_TEXT, inputs: [] })
      drain()
      return { msg, bots }
    },

    /** Stop on a bot: it is no longer waiting for a teammate. The controller kills the child and ends the turn. */
    stopped(botId: string) {
      waitingOn.delete(botId)
    },

    /** A memory tidy: the bot takes no wake until resume. It is not a running turn for the close rule. */
    pause(botId: string) {
      paused.add(botId)
    },

    resume(botId: string) {
      paused.delete(botId)
      drain()
    },

    /**
     * Remove: drops that bot's queued messages, frees anyone waiting on it, and forgets its open job.
     * Returns the jobs to re-check with checkJob once its files are gone.
     */
    dropBot(botId: string): string[] {
      const jobs = new Set<string>()
      const own = openJobs.get(botId)
      if (own) jobs.add(own)
      for (const i of items(botId)) if (i.msg.job) jobs.add(i.msg.job)
      inbox.delete(botId)
      for (const [job, list] of held) {
        const keep = list.filter((h) => h.to !== botId)
        if (keep.length !== list.length) jobs.add(job)
        if (keep.length) held.set(job, keep)
        else held.delete(job)
      }
      waitingOn.delete(botId)
      for (const [w, on] of waitingOn) if (on === botId) waitingOn.delete(w)
      openJobs.delete(botId)
      paused.delete(botId)
      return [...jobs]
    },

    /** Close-tab and quit: every queued and held message is dropped, not delivered. */
    dropQueues(): DeskMessage[] {
      const dropped = [...inbox.values()].flat().map((i) => i.msg)
      inbox.clear()
      held.clear()
      return dropped
    },

    state(botId: string): BusState {
      const run = running.get(botId)
      if (run) return { state: 'working', job: run.turn.job }
      if (openTiles().some((t) => t.from === botId)) return { state: 'waiting-you' }
      const on = waitingOn.get(botId)
      if (on) return { state: 'waiting-bot', on }
      return { state: 'idle' }
    },

    turnOf(botId: string): Turn | undefined {
      return running.get(botId)?.turn
    },

    running(): Turn[] {
      return [...running.values()].map((r) => r.turn)
    },

    queued(botId: string): DeskMessage[] {
      return items(botId).map((i) => i.msg)
    },

    openJob(botId: string): string | undefined {
      return openJobs.get(botId)
    },

    isClosed(job: string): boolean {
      return closed.has(job)
    },

    sends(job: string): number {
      return sent.get(job) || 0
    },

    /** Unanswered tiles and holds on jobs that are still open, optionally for one job. */
    unanswered(job?: string): DeskMessage[] {
      const tiles = openTiles()
      return job ? tiles.filter((t) => t.job === job) : tiles
    }
  }

  return bus
}
