import { cloneState } from './clone'
import { checkInvariants } from './invariants'
import { isVoter, lastLogIndex, latestConfig } from './log'
import {
  abortTransfer,
  becomeLeader,
  broadcastAppend,
  checkQuorum,
  createNode,
  handleAppendEntries,
  handleAppendReply,
  handleClientRequest,
  handleInstallSnapshot,
  handleRequestVote,
  handleSnapshotReply,
  handleTimeoutNow,
  handleVoteReply,
  maybeSnapshot,
  onElectionTimeout,
  propose,
  requestMembershipChange,
  resetElectionTimer,
  resetVolatile,
  startTransfer,
  type Ctx,
} from './raft'
import { Tracer } from './trace'
import {
  CLIENT_ID,
  DEFAULT_SETTINGS,
  type ClientOp,
  type Command,
  type Message,
  type NodeId,
  type Payload,
  type RaftNode,
  type Settings,
  type SimEvent,
  type SimState,
} from './types'

type Next =
  | { time: number; kind: 'msg'; msg: Message }
  | { time: number; kind: 'election' | 'heartbeat' | 'checkQuorum' | 'transferAbort'; node: RaftNode }
  | { time: number; kind: 'clientRetry' | 'clientAuto' }
  | { time: number; kind: 'none' }

export interface SimOptions {
  nodes: number
  seed: number
  settings?: Partial<Settings>
}

const linkKey = (a: NodeId, b: NodeId) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class Simulation {
  s: SimState
  events: SimEvent[] = []
  history: SimState[] = []
  maxHistory = 2500
  maxEvents = 4000

  constructor(opts: SimOptions) {
    const ids = Array.from({ length: opts.nodes }, (_, i) => `S${i + 1}`)
    const config = { voters: [...ids] }
    this.s = {
      now: 0,
      seed: opts.seed,
      rng: opts.seed >>> 0 || 1,
      nextMsgId: 1,
      nextNodeNum: opts.nodes + 1,
      nodes: Object.fromEntries(ids.map((id) => [id, createNode(id, structuredClone(config))])),
      nodeOrder: ids,
      messages: [],
      client: { seq: 0, leaderGuess: null, ops: [], retryAt: Infinity, nextAutoAt: Infinity },
      settings: { ...DEFAULT_SETTINGS, ...opts.settings },
      partition: null,
      blockedLinks: [],
      eventCount: 0,
      oracle: { leadersByTerm: {}, committed: {}, applied: {}, leaderLast: {}, violations: [] },
    }
    const ctx = this.ctx(new Tracer())
    for (const id of ids) resetElectionTimer(ctx, this.s.nodes[id])
    if (this.s.settings.autoClientInterval > 0) this.s.client.nextAutoAt = this.s.settings.autoClientInterval
    this.record({ kind: 'action', nodeId: null, title: `Cluster of ${opts.nodes} servers created (seed ${opts.seed})` }, new Tracer())
  }

  // ---------------------------------------------------------------- plumbing

  random(): number {
    // mulberry32
    let t = (this.s.rng = (this.s.rng + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private ctx(tr: Tracer): Ctx {
    return { s: this.s, tr, send: (f, t, p, r) => this.send(f, t, p, r), random: () => this.random() }
  }

  canTalk(a: NodeId, b: NodeId): boolean {
    if (a === CLIENT_ID || b === CLIENT_ID) return true
    if (this.s.blockedLinks.includes(linkKey(a, b))) return false
    const p = this.s.partition
    if (!p) return true
    const ga = p.findIndex((g) => g.includes(a))
    const gb = p.findIndex((g) => g.includes(b))
    return ga === gb
  }

  private send(from: NodeId, to: NodeId, payload: Payload, reason: string) {
    const st = this.s.settings
    if (from !== CLIENT_ID && !this.s.nodes[from]?.alive) return
    const latency = st.latencyMin + this.random() * Math.max(0, st.latencyMax - st.latencyMin)
    let dropped = false
    let dropReason: string | undefined
    if (!this.canTalk(from, to)) {
      dropped = true
      dropReason = 'network partition'
    } else if (st.dropRate > 0 && this.random() < st.dropRate) {
      dropped = true
      dropReason = 'random message loss'
    }
    this.s.messages.push({
      ...payload,
      id: this.s.nextMsgId++,
      from,
      to,
      sendTime: this.s.now,
      deliverTime: this.s.now + latency,
      dropped,
      dropReason,
      reason,
    } as Message)
  }

  private record(e: Omit<SimEvent, 'id' | 'time' | 'trace'>, tr: Tracer) {
    checkInvariants(this.s)
    this.events.push({ ...e, id: this.s.eventCount++, time: this.s.now, trace: tr.steps })
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
    this.history.push(cloneState(this.s))
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory)
  }

  // ---------------------------------------------------------------- event loop

  nextEvent(): Next {
    let best: Next = { time: Infinity, kind: 'none' }
    for (const m of this.s.messages) if (m.deliverTime < best.time) best = { time: m.deliverTime, kind: 'msg', msg: m }
    for (const id of this.s.nodeOrder) {
      const n = this.s.nodes[id]
      if (!n.alive) continue
      if (n.role === 'leader') {
        if (n.heartbeatDeadline < best.time) best = { time: n.heartbeatDeadline, kind: 'heartbeat', node: n }
        if (this.s.settings.checkQuorum && n.electionDeadline < best.time) best = { time: n.electionDeadline, kind: 'checkQuorum', node: n }
        if (n.transfer && n.transfer.deadline < best.time) best = { time: n.transfer.deadline, kind: 'transferAbort', node: n }
      } else if (n.electionDeadline < best.time) best = { time: n.electionDeadline, kind: 'election', node: n }
    }
    const c = this.s.client
    if (c.retryAt < best.time) best = { time: c.retryAt, kind: 'clientRetry' }
    if (this.s.settings.autoClientInterval > 0 && c.nextAutoAt < best.time) best = { time: c.nextAutoAt, kind: 'clientAuto' }
    return best
  }

  nextEventTime() {
    return this.nextEvent().time
  }

  /** Processes the next event. Returns false if there is nothing to do. */
  step(): boolean {
    const ev = this.nextEvent()
    if (ev.kind === 'none' || !Number.isFinite(ev.time)) return false
    this.s.now = Math.max(this.s.now, ev.time)
    const tr = new Tracer()
    const ctx = this.ctx(tr)
    switch (ev.kind) {
      case 'msg':
        this.deliver(ev.msg, ctx)
        return true
      case 'election':
        onElectionTimeout(ctx, ev.node)
        this.record({ kind: 'timer', nodeId: ev.node.id, title: `${ev.node.id}: election timeout` }, tr)
        return true
      case 'heartbeat':
        broadcastAppend(ctx, ev.node, `Heartbeat from leader ${ev.node.id}`)
        this.record({ kind: 'timer', nodeId: ev.node.id, title: `${ev.node.id}: heartbeat timer` }, tr)
        return true
      case 'checkQuorum':
        checkQuorum(ctx, ev.node)
        this.record({ kind: 'timer', nodeId: ev.node.id, title: `${ev.node.id}: CheckQuorum` }, tr)
        return true
      case 'transferAbort':
        abortTransfer(ctx, ev.node)
        this.record({ kind: 'timer', nodeId: ev.node.id, title: `${ev.node.id}: leadership transfer timed out` }, tr)
        return true
      case 'clientRetry':
        this.clientRetry()
        return true
      case 'clientAuto':
        this.clientAuto()
        return true
    }
  }

  /** Runs every event up to time t (inclusive) and moves the clock to t. */
  advanceTo(t: number, maxEvents = 2000): number {
    let count = 0
    while (count < maxEvents && this.nextEventTime() <= t) {
      if (!this.step()) break
      count++
    }
    if (count < maxEvents) this.s.now = Math.max(this.s.now, t)
    return count
  }

  private deliver(m: Message, ctx: Ctx) {
    this.s.messages = this.s.messages.filter((x) => x.id !== m.id)
    const to = m.to === CLIENT_ID ? null : this.s.nodes[m.to]
    let lost: string | null = null
    if (m.dropped) lost = m.dropReason ?? 'dropped'
    else if (!this.canTalk(m.from, m.to)) lost = 'network partition'
    else if (to && !to.alive) lost = `${m.to} is down`
    if (lost) {
      this.record({ kind: 'drop', nodeId: m.to === CLIENT_ID ? null : m.to, title: `${m.type} ${m.from}→${m.to} lost (${lost})`, msg: m }, ctx.tr)
      return
    }
    if (m.type === 'ClientReply') {
      this.clientReceive(m)
      return
    }
    const n = to!
    switch (m.type) {
      case 'RequestVote':
        handleRequestVote(ctx, n, m)
        break
      case 'RequestVoteReply':
        handleVoteReply(ctx, n, m)
        break
      case 'AppendEntries':
        handleAppendEntries(ctx, n, m)
        break
      case 'AppendEntriesReply':
        handleAppendReply(ctx, n, m)
        break
      case 'InstallSnapshot':
        handleInstallSnapshot(ctx, n, m)
        break
      case 'InstallSnapshotReply':
        handleSnapshotReply(ctx, n, m)
        break
      case 'TimeoutNow':
        handleTimeoutNow(ctx, n, m)
        break
      case 'ClientRequest':
        handleClientRequest(ctx, n, m)
        break
    }
    this.record({ kind: 'deliver', nodeId: n.id, title: `${m.from} → ${m.to}: ${m.type}`, msg: m }, ctx.tr)
  }

  // ---------------------------------------------------------------- client

  private pickServer(exclude?: NodeId): NodeId {
    const opts = this.s.nodeOrder.filter((id) => id !== exclude)
    return opts[Math.floor(this.random() * opts.length)] ?? this.s.nodeOrder[0]
  }

  private clientSendOp(op: ClientOp) {
    const c = this.s.client
    const chosen = op.attempts === 0 && op.target && this.s.nodes[op.target] ? op.target : null
    const target = chosen ?? c.leaderGuess ?? this.pickServer()
    op.status = 'pending'
    op.attempts++
    op.sentTo = target
    op.sentAt = this.s.now
    c.retryAt = this.s.now + this.s.settings.clientTimeout
    this.send(CLIENT_ID, target, { type: 'ClientRequest', body: { clientId: CLIENT_ID, seq: op.seq, command: op.command } }, `Client request #${op.seq}${op.attempts > 1 ? ` (attempt ${op.attempts})` : ''}`)
  }

  private clientPump() {
    const c = this.s.client
    if (c.ops.some((o) => o.status === 'pending')) return
    const next = c.ops.find((o) => o.status === 'queued')
    if (next) this.clientSendOp(next)
    else c.retryAt = Infinity
  }

  private clientReceive(m: Extract<Message, { type: 'ClientReply' }>) {
    const c = this.s.client
    const r = m.body
    const op = c.ops.find((o) => o.seq === r.seq && o.status === 'pending')
    let title = `${m.from} → client: reply #${r.seq} (stale, ignored)`
    if (op) {
      if (r.ok) {
        op.status = 'ok'
        op.result = r.value
        op.doneAt = this.s.now
        c.leaderGuess = m.from
        title = `${m.from} → client: #${r.seq} OK${op.command.op === 'get' ? ` (${op.command.key} = ${r.value ?? 'null'})` : ''}`
        this.clientPump()
      } else {
        c.leaderGuess = r.leaderHint && r.leaderHint !== m.from ? r.leaderHint : null
        title = `${m.from} → client: #${r.seq} rejected${r.leaderHint ? `, try ${r.leaderHint}` : ''}`
        if (c.leaderGuess) this.clientSendOp(op)
        else c.retryAt = this.s.now + Math.max(this.s.settings.heartbeatInterval, this.s.settings.latencyMax * 2)
      }
    }
    this.record({ kind: 'client', nodeId: null, title, msg: m }, new Tracer())
  }

  private clientRetry() {
    const c = this.s.client
    const op = c.ops.find((o) => o.status === 'pending')
    if (!op) {
      c.retryAt = Infinity
      return
    }
    c.leaderGuess = this.pickServer(op.sentTo)
    this.clientSendOp(op)
    this.record({ kind: 'client', nodeId: null, title: `Client: no answer for #${op.seq}, retrying with ${op.sentTo}` }, new Tracer())
  }

  private clientAuto() {
    const keys = ['x', 'y', 'z']
    const key = keys[Math.floor(this.random() * keys.length)]
    const value = String(1 + Math.floor(this.random() * 9))
    this.s.client.nextAutoAt = this.s.now + this.s.settings.autoClientInterval
    if (this.s.client.ops.filter((o) => o.status === 'queued').length < 3) this.enqueue({ op: 'set', key, value }, 'auto')
    else this.record({ kind: 'client', nodeId: null, title: 'Client: queue full, skipping auto request' }, new Tracer())
  }

  private enqueue(command: Command, origin: string, target?: NodeId) {
    const c = this.s.client
    const op: ClientOp = { seq: ++c.seq, command, status: 'queued', attempts: 0, target }
    c.ops.push(op)
    if (c.ops.length > 60) c.ops.splice(0, c.ops.length - 60)
    this.clientPump()
    const desc = command.op === 'set' ? `SET ${command.key}=${command.value}` : `GET ${command.key}`
    this.record({ kind: 'client', nodeId: target ?? null, title: `Client${origin === 'auto' ? ' (auto)' : ''}: ${desc} (#${op.seq})${target ? ` → ${target}` : ''}` }, new Tracer())
  }

  // ---------------------------------------------------------------- user actions

  leader(): RaftNode | null {
    // the alive leader with the highest term
    let best: RaftNode | null = null
    for (const id of this.s.nodeOrder) {
      const n = this.s.nodes[id]
      if (n.alive && n.role === 'leader' && (!best || n.currentTerm > best.currentTerm)) best = n
    }
    return best
  }

  private action(title: string, nodeId: NodeId | null, fn: (ctx: Ctx) => void) {
    const tr = new Tracer()
    fn(this.ctx(tr))
    this.record({ kind: 'action', nodeId, title }, tr)
  }

  /** Queues a client command; `target` picks the server for the first attempt. */
  clientRequest(command: Command, target?: NodeId) {
    this.enqueue(command, 'user', target)
  }

  crash(id: NodeId) {
    const n = this.s.nodes[id]
    if (!n?.alive) return
    this.action(`${id} crashed (keeps currentTerm, votedFor, log on disk)`, id, () => {
      n.alive = false
      resetVolatile(n)
      n.electionDeadline = Infinity
    })
  }

  restart(id: NodeId) {
    const n = this.s.nodes[id]
    if (!n || n.alive) return
    this.action(`${id} restarted as follower (volatile state lost)`, id, (ctx) => {
      n.alive = true
      resetVolatile(n)
      resetElectionTimer(ctx, n)
    })
  }

  forceTimeout(id: NodeId) {
    const n = this.s.nodes[id]
    if (!n?.alive || n.role === 'leader') return
    this.action(`${id}: election timeout forced by user`, id, (ctx) => onElectionTimeout(ctx, n))
  }

  forceSnapshot(id: NodeId) {
    const n = this.s.nodes[id]
    if (!n?.alive) return
    this.action(`${id}: snapshot taken by user`, id, (ctx) => maybeSnapshot(ctx, n, true))
  }

  dropMessage(msgId: number) {
    const m = this.s.messages.find((x) => x.id === msgId)
    if (!m || m.dropped) return
    this.action(`${m.type} ${m.from}→${m.to} dropped by user`, null, () => {
      m.dropped = true
      m.dropReason = 'dropped by user'
    })
  }

  setPartition(groups: NodeId[][] | null) {
    this.action(groups ? `Network partitioned: ${groups.map((g) => `{${g.join(',')}}`).join(' | ')}` : 'Network healed', null, () => {
      this.s.partition = groups && groups.length > 1 ? groups : null
    })
  }

  toggleLink(a: NodeId, b: NodeId) {
    const k = linkKey(a, b)
    const blocked = this.s.blockedLinks.includes(k)
    this.action(`Link ${a}↔${b} ${blocked ? 'restored' : 'cut'}`, null, () => {
      this.s.blockedLinks = blocked ? this.s.blockedLinks.filter((x) => x !== k) : [...this.s.blockedLinks, k]
    })
  }

  updateSettings(patch: Partial<Settings>) {
    const keys = Object.keys(patch) as (keyof Settings)[]
    if (keys.every((k) => this.s.settings[k] === patch[k])) return
    this.action(`Settings: ${keys.map((k) => `${k}=${patch[k]}`).join(', ')}`, null, () => {
      this.s.settings = { ...this.s.settings, ...patch }
      if (patch.autoClientInterval !== undefined) this.s.client.nextAutoAt = patch.autoClientInterval > 0 ? this.s.now + patch.autoClientInterval : Infinity
    })
  }

  /** Adds a new, empty server and asks the leader to add it (§6). */
  addServer(): string | null {
    const l = this.leader()
    if (!l) return 'Membership changes go through the leader: wait until there is one.'
    if (l.pendingChange || latestConfig(l).newVoters) return 'Another membership change is in progress.'
    const id = `S${this.s.nextNodeNum++}`
    this.action(`New server ${id} started; ${l.id} adds it to the cluster`, id, (ctx) => {
      const n = createNode(id, { voters: [] })
      this.s.nodes[id] = n
      this.s.nodeOrder = [...this.s.nodeOrder, id]
      if (this.s.partition) this.s.partition[0].push(id)
      requestMembershipChange(ctx, l, { type: 'add', id })
    })
    return null
  }

  removeServer(id: NodeId): string | null {
    const l = this.leader()
    if (!l) return 'Membership changes go through the leader: wait until there is one.'
    if (l.pendingChange || latestConfig(l).newVoters) return 'Another membership change is in progress.'
    const cfg = latestConfig(l)
    if (!isVoter(cfg, id)) return `${id} is not a member of the configuration.`
    if (cfg.voters.length <= 1) return 'Cannot remove the last server.'
    this.action(`${l.id} starts removing ${id} from the cluster`, id, (ctx) => requestMembershipChange(ctx, l, { type: 'remove', id }))
    return null
  }

  /** Removes a server that is no longer part of any configuration from the view. */
  forget(id: NodeId): string | null {
    const inUse = this.s.nodeOrder.some((x) => x !== id && isVoter(latestConfig(this.s.nodes[x]), id))
    if (inUse) return `${id} is still in some server's configuration.`
    this.action(`${id} decommissioned`, null, () => {
      delete this.s.nodes[id]
      this.s.nodeOrder = this.s.nodeOrder.filter((x) => x !== id)
      this.s.messages = this.s.messages.filter((m) => m.from !== id && m.to !== id)
      if (this.s.partition) this.s.partition = this.s.partition.map((g) => g.filter((x) => x !== id))
    })
    return null
  }

  transferLeadership(target: NodeId): string | null {
    const l = this.leader()
    if (!l) return 'There is no leader.'
    if (l.id === target) return `${target} is already the leader.`
    if (!isVoter(latestConfig(l), target)) return `${target} is not a voting member.`
    this.action(`${l.id} transfers leadership to ${target}`, l.id, (ctx) => startTransfer(ctx, l, target))
    return null
  }

  /** Testing/scenario helper: make a node leader immediately. */
  forceLeader(id: NodeId) {
    const n = this.s.nodes[id]
    this.action(`${id} becomes leader (scenario)`, id, (ctx) => becomeLeader(ctx, n))
  }

  // ---------------------------------------------------------------- scenario helpers

  /** Runs arbitrary code as one recorded event (used by guided scenarios). */
  scripted(title: string, nodeId: NodeId | null, fn: (ctx: Ctx) => void) {
    this.action(title, nodeId, fn)
  }

  /** A leader appends a command without going through the client. */
  propose(id: NodeId, command: Command): string | null {
    const n = this.s.nodes[id]
    if (!n?.alive || n.role !== 'leader') return `${id} is not the leader.`
    const desc = command.op === 'set' ? `SET ${command.key}=${command.value}` : `GET ${command.key}`
    this.action(`${id} receives ${desc}`, id, (ctx) => propose(ctx, n, command))
    return null
  }

  /** Sets the election deadline of each node to now + ms (Infinity = never). */
  setTimers(timers: Record<NodeId, number>) {
    for (const [id, ms] of Object.entries(timers)) {
      const n = this.s.nodes[id]
      if (!n?.alive || n.role === 'leader') continue
      n.electionDeadline = this.s.now + ms
      if (Number.isFinite(ms)) n.electionTimeout = ms
    }
  }

  /** Forgets the events and checkpoints so far: the current state becomes the start. */
  markStart(title: string) {
    this.events = []
    this.history = []
    this.record({ kind: 'action', nodeId: null, title }, new Tracer())
  }

  // ---------------------------------------------------------------- time travel

  restore(historyIndex: number) {
    const snap = this.history[historyIndex]
    if (!snap) return
    this.s = cloneState(snap)
    this.history.length = historyIndex + 1
    this.events = this.events.filter((e) => e.id < this.s.eventCount)
  }

  /** Restores a state saved earlier with cloneState (e.g. the end of a scenario step). */
  restoreState(snap: SimState) {
    this.s = cloneState(snap)
    this.history = this.history.filter((h) => h.eventCount <= snap.eventCount)
    if (this.history.length === 0 || this.history[this.history.length - 1].eventCount !== snap.eventCount) this.history.push(cloneState(snap))
    this.events = this.events.filter((e) => e.id < this.s.eventCount)
  }

  /** Inspection helpers */
  lastLogIndexOf(id: NodeId) {
    return lastLogIndex(this.s.nodes[id])
  }
}
