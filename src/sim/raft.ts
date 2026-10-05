import {
  configAt,
  describeConfig,
  entriesFrom,
  entryAt,
  hasQuorum,
  isJoint,
  isVoter,
  lastLogIndex,
  lastLogTerm,
  latestConfig,
  latestConfigIndex,
  members,
  termAt,
  truncateFrom,
} from './log'
import { recordApply } from './invariants'
import { fmt, type Tracer } from './trace'
import {
  CLIENT_ID,
  type ClientReplyArgs,
  type ClientRequestArgs,
  type ClusterConfig,
  type LogEntry,
  type Message,
  type NodeId,
  type Payload,
  type RaftNode,
  type SimState,
} from './types'

export interface Ctx {
  s: SimState
  tr: Tracer
  send(from: NodeId, to: NodeId, p: Payload, reason: string): void
  random(): number
}

type Msg<T extends Payload['type']> = Extract<Message, { type: T }>

export function createNode(id: NodeId, config: ClusterConfig): RaftNode {
  return {
    id,
    alive: true,
    currentTerm: 0,
    votedFor: null,
    log: [],
    snapshot: { lastIndex: 0, lastTerm: 0, kv: {}, sessions: {}, config },
    role: 'follower',
    leaderId: null,
    commitIndex: 0,
    lastApplied: 0,
    kv: {},
    sessions: {},
    votesGranted: [],
    electionTimeout: 0,
    electionDeadline: Infinity,
    lastHeardFromLeader: -Infinity,
    nextIndex: {},
    matchIndex: {},
    heartbeatDeadline: Infinity,
    lastAck: {},
    ackSentAt: {},
    ackedReadSeq: {},
    readSeq: 0,
    pendingReads: [],
    pendingClient: [],
    learners: [],
    pendingChange: null,
    transfer: null,
    lastQuorumCheck: 0,
  }
}

/** Loses all volatile state; keeps currentTerm, votedFor, log, snapshot. */
export function resetVolatile(n: RaftNode) {
  n.role = 'follower'
  n.leaderId = null
  n.commitIndex = n.snapshot.lastIndex
  n.lastApplied = n.snapshot.lastIndex
  n.kv = { ...n.snapshot.kv }
  n.sessions = structuredClone(n.snapshot.sessions)
  n.votesGranted = []
  n.lastHeardFromLeader = -Infinity
  clearLeaderState(n)
}

function clearLeaderState(n: RaftNode) {
  n.nextIndex = {}
  n.matchIndex = {}
  n.heartbeatDeadline = Infinity
  n.lastAck = {}
  n.ackSentAt = {}
  n.ackedReadSeq = {}
  n.readSeq = 0
  n.pendingReads = []
  n.pendingClient = []
  n.learners = []
  n.pendingChange = null
  n.transfer = null
}

export function resetElectionTimer(ctx: Ctx, n: RaftNode) {
  const st = ctx.s.settings
  n.electionTimeout = Math.round(st.electionTimeoutMin + ctx.random() * (st.electionTimeoutMax - st.electionTimeoutMin))
  n.electionDeadline = ctx.s.now + n.electionTimeout
}

const peersOf = (n: RaftNode) => members(latestConfig(n)).filter((p) => p !== n.id)

export function replicationTargets(n: RaftNode): NodeId[] {
  const s = new Set(peersOf(n))
  for (const l of n.learners) if (l !== n.id) s.add(l)
  return [...s]
}

function becomeFollower(ctx: Ctx, n: RaftNode, term: number, line: string) {
  const wasLeader = n.role === 'leader'
  if (term > n.currentTerm) {
    n.currentTerm = term
    n.votedFor = null
    ctx.tr.set(line, 'currentTerm', term)
    ctx.tr.set(line, 'votedFor', null)
  }
  if (n.role !== 'follower') {
    n.role = 'follower'
    ctx.tr.set(line, 'state', 'follower')
  }
  n.votesGranted = []
  if (wasLeader) {
    n.leaderId = null
    clearLeaderState(n)
    resetElectionTimer(ctx, n)
  }
}

function append(n: RaftNode, e: Omit<LogEntry, 'index' | 'term'>): LogEntry {
  const entry: LogEntry = { ...e, index: lastLogIndex(n) + 1, term: n.currentTerm }
  n.log.push(entry)
  return entry
}

/** Scenario helper: a leader appends a command that did not come from the
 *  client (no session), as if a request had just arrived. */
export function propose(ctx: Ctx, n: RaftNode, command: LogEntry['command']) {
  const { tr, s } = ctx
  tr.line('cl.1')
  const e = append(n, { kind: 'command', command })
  tr.set('cl.6', `log[${e.index}]`, `term ${e.term}`)
  if (s.settings.replicateImmediately) {
    tr.line('cl.7', 'replicating now')
    broadcastAppend(ctx, n, `New entry ${e.index}`)
  } else tr.note('cl.7', 'will be sent with the next heartbeat')
  advanceCommitIndex(ctx, n)
}

// ------------------------------------------------------------------ elections

export function onElectionTimeout(ctx: Ctx, n: RaftNode) {
  const { tr } = ctx
  tr.line('t.1')
  const cfg = latestConfig(n)
  if (tr.cond('t.2', 'self ∉ configuration', `${n.id} ∉ ${describeConfig(cfg)}`, !isVoter(cfg, n.id))) {
    n.electionDeadline = Infinity
    tr.note('t.2', 'not a voting member: never starts elections')
    return
  }
  if (tr.cond('t.3', 'preVote enabled', String(ctx.s.settings.preVote), ctx.s.settings.preVote)) {
    startPreVote(ctx, n)
    return
  }
  startElection(ctx, n, false)
}

export function startElection(ctx: Ctx, n: RaftNode, transfer: boolean) {
  const { tr } = ctx
  n.currentTerm += 1
  tr.set('t.4', 'currentTerm', n.currentTerm)
  n.role = 'candidate'
  n.leaderId = null
  tr.set('t.5', 'state', 'candidate')
  n.votedFor = n.id
  n.votesGranted = [n.id]
  tr.set('t.6', 'votedFor', n.id)
  resetElectionTimer(ctx, n)
  tr.set('t.7', 'election timeout', `${n.electionTimeout}ms`)
  const peers = peersOf(n)
  tr.line('t.8', peers.length ? `→ ${peers.join(', ')}` : 'no other servers')
  for (const p of peers) {
    ctx.send(
      n.id,
      p,
      {
        type: 'RequestVote',
        body: {
          term: n.currentTerm,
          candidateId: n.id,
          lastLogIndex: lastLogIndex(n),
          lastLogTerm: lastLogTerm(n),
          preVote: false,
          transfer,
        },
      },
      transfer ? 'Leadership transfer: TimeoutNow received, election starts immediately' : `Election timeout: ${n.id} starts an election for term ${n.currentTerm}`,
    )
  }
  if (tr.cond('t.9', 'votes form a majority', `{${n.votesGranted.join(',')}} of ${describeConfig(latestConfig(n))}`, hasQuorum(latestConfig(n), n.votesGranted)))
    becomeLeader(ctx, n)
}

function startPreVote(ctx: Ctx, n: RaftNode) {
  const { tr } = ctx
  tr.line('pv.1')
  n.role = 'precandidate'
  n.leaderId = null
  n.votesGranted = [n.id]
  tr.set('pv.2', 'state', 'pre-candidate')
  resetElectionTimer(ctx, n)
  const peers = peersOf(n)
  tr.line('pv.3', `term ${n.currentTerm + 1} → ${peers.join(', ')}`)
  for (const p of peers) {
    ctx.send(
      n.id,
      p,
      {
        type: 'RequestVote',
        body: { term: n.currentTerm + 1, candidateId: n.id, lastLogIndex: lastLogIndex(n), lastLogTerm: lastLogTerm(n), preVote: true, transfer: false },
      },
      `Pre-Vote: would you vote for ${n.id} in term ${n.currentTerm + 1}? (no state changes)`,
    )
  }
  if (hasQuorum(latestConfig(n), n.votesGranted)) {
    tr.line('pv.5')
    startElection(ctx, n, false)
  }
}

function logUpToDate(ctx: Ctx, n: RaftNode, lastIdx: number, lastTrm: number, line: string): boolean {
  const myI = lastLogIndex(n)
  const myT = lastLogTerm(n)
  const real = lastTrm > myT || (lastTrm === myT && lastIdx >= myI)
  const result = ctx.s.settings.unsafeNoElectionRestriction ? true : real
  ctx.tr.cond(
    line,
    'candidate log at least as up-to-date',
    `${lastTrm} > ${myT} ∨ (${lastTrm} = ${myT} ∧ ${lastIdx} ≥ ${myI})${ctx.s.settings.unsafeNoElectionRestriction ? ' [check DISABLED]' : ''}`,
    result,
  )
  return result
}

function leaderRecentlyHeard(ctx: Ctx, n: RaftNode) {
  return n.role === 'leader' || (n.leaderId !== null && ctx.s.now - n.lastHeardFromLeader < ctx.s.settings.electionTimeoutMin)
}

export function handleRequestVote(ctx: Ctx, n: RaftNode, m: Msg<'RequestVote'>) {
  const { tr } = ctx
  const a = m.body
  const reply = (granted: boolean, why: string) =>
    ctx.send(n.id, m.from, { type: 'RequestVoteReply', body: { term: n.currentTerm, voteGranted: granted, preVote: a.preVote } }, why)

  if (a.preVote) {
    tr.line('pv.4')
    const recent = leaderRecentlyHeard(ctx, n)
    const termOk = a.term > n.currentTerm
    tr.cond('pv.4', 'proposed term > currentTerm', `${a.term} > ${n.currentTerm}`, termOk)
    tr.cond('pv.4', 'no leader heard recently', recent ? 'heard from leader recently' : 'no recent leader', !recent)
    const upToDate = logUpToDate(ctx, n, a.lastLogIndex, a.lastLogTerm, 'pv.4')
    const grant = termOk && !recent && upToDate
    tr.note('pv.4', grant ? 'pre-vote granted (term and votedFor untouched)' : 'pre-vote denied')
    reply(grant, grant ? `Pre-vote granted to ${a.candidateId}` : `Pre-vote denied to ${a.candidateId}`)
    return
  }

  tr.line('rv.1')
  if (ctx.s.settings.disruptionGuard && !a.transfer) {
    const since = ctx.s.now - n.lastHeardFromLeader
    const recent = leaderRecentlyHeard(ctx, n)
    if (tr.cond('rv.2', 'heard from leader < min election timeout ago', n.role === 'leader' ? 'I am the leader' : `${fmt(Math.round(since))}ms < ${ctx.s.settings.electionTimeoutMin}ms`, recent)) {
      tr.note('rv.2', 'request ignored: a leader is believed to exist')
      return
    }
  }
  if (tr.cond('rv.3', 'term > currentTerm', `${a.term} > ${n.currentTerm}`, a.term > n.currentTerm)) becomeFollower(ctx, n, a.term, 'rv.3')
  if (tr.cond('rv.4', 'term < currentTerm', `${a.term} < ${n.currentTerm}`, a.term < n.currentTerm)) {
    reply(false, `Vote denied: ${a.candidateId}'s term ${a.term} is stale (mine is ${n.currentTerm})`)
    return
  }
  const upToDate = logUpToDate(ctx, n, a.lastLogIndex, a.lastLogTerm, 'rv.5')
  const canVote = n.votedFor === null || n.votedFor === a.candidateId
  if (tr.cond('rv.6', '(votedFor = null ∨ votedFor = candidateId) ∧ upToDate', `(votedFor = ${fmt(n.votedFor)}) ∧ ${upToDate}`, canVote && upToDate)) {
    n.votedFor = a.candidateId
    tr.set('rv.7', 'votedFor', a.candidateId)
    resetElectionTimer(ctx, n)
    tr.line('rv.8')
    reply(true, `Vote granted to ${a.candidateId} for term ${a.term}`)
  } else {
    tr.line('rv.9')
    reply(false, !canVote ? `Vote denied: already voted for ${n.votedFor} in term ${n.currentTerm}` : `Vote denied: ${a.candidateId}'s log is not up-to-date`)
  }
}

export function handleVoteReply(ctx: Ctx, n: RaftNode, m: Msg<'RequestVoteReply'>) {
  const { tr } = ctx
  const r = m.body
  if (r.preVote) {
    tr.line('pv.5')
    if (!r.voteGranted && r.term > n.currentTerm) {
      becomeFollower(ctx, n, r.term, 'vr.2')
      return
    }
    if (n.role !== 'precandidate') {
      tr.note('pv.5', 'no longer a pre-candidate: ignore')
      return
    }
    if (r.voteGranted && !n.votesGranted.includes(m.from)) n.votesGranted.push(m.from)
    if (tr.cond('pv.5', 'pre-votes form a majority', `{${n.votesGranted.join(',')}}`, hasQuorum(latestConfig(n), n.votesGranted))) startElection(ctx, n, false)
    return
  }
  tr.line('vr.1')
  if (tr.cond('vr.2', 'term > currentTerm', `${r.term} > ${n.currentTerm}`, r.term > n.currentTerm)) {
    becomeFollower(ctx, n, r.term, 'vr.2')
    return
  }
  if (tr.cond('vr.3', 'state ≠ candidate ∨ term ≠ currentTerm', `${n.role} ≠ candidate ∨ ${r.term} ≠ ${n.currentTerm}`, n.role !== 'candidate' || r.term !== n.currentTerm)) return
  if (r.voteGranted && !n.votesGranted.includes(m.from)) {
    n.votesGranted.push(m.from)
    tr.set('vr.4', 'votes', n.votesGranted)
  } else tr.note('vr.4', 'vote not granted')
  const cfg = latestConfig(n)
  if (tr.cond('vr.5', 'votes form a majority', `{${n.votesGranted.join(',')}} of ${describeConfig(cfg)}`, hasQuorum(cfg, n.votesGranted))) becomeLeader(ctx, n)
}

export function becomeLeader(ctx: Ctx, n: RaftNode) {
  const { tr, s } = ctx
  tr.line('bl.1')
  n.role = 'leader'
  n.leaderId = n.id
  n.votesGranted = []
  clearLeaderState(n)
  n.lastQuorumCheck = s.now
  resetElectionTimer(ctx, n)
  for (const p of replicationTargets(n)) {
    n.nextIndex[p] = lastLogIndex(n) + 1
    n.matchIndex[p] = 0
  }
  tr.set('bl.2', 'nextIndex[*]', lastLogIndex(n) + 1)
  if (s.settings.noopOnElection) {
    const e = append(n, { kind: 'noop' })
    tr.set('bl.3', `log[${e.index}]`, `no-op (term ${e.term})`)
  } else tr.note('bl.3', 'no-op disabled in settings')
  tr.line('bl.4')
  broadcastAppend(ctx, n, `Initial heartbeat: ${n.id} announces it is leader of term ${n.currentTerm}`)
  advanceCommitIndex(ctx, n)
}

// ------------------------------------------------------------------ replication

export function broadcastAppend(ctx: Ctx, n: RaftNode, reason: string) {
  ctx.tr.line('rp.1')
  for (const p of replicationTargets(n)) sendAppend(ctx, n, p, reason)
  n.heartbeatDeadline = ctx.s.now + ctx.s.settings.heartbeatInterval
  ctx.tr.line('rp.7')
}

function sendAppend(ctx: Ctx, n: RaftNode, p: NodeId, reason: string) {
  const { tr, s } = ctx
  tr.line('rp.2', `follower ${p}`)
  if (n.nextIndex[p] === undefined) {
    n.nextIndex[p] = lastLogIndex(n) + 1
    n.matchIndex[p] = 0
  }
  const ni = n.nextIndex[p]
  if (tr.cond('rp.3', 'nextIndex[f] ≤ snapshot.lastIndex', `${p}: ${ni} ≤ ${n.snapshot.lastIndex}`, ni <= n.snapshot.lastIndex)) {
    ctx.send(
      n.id,
      p,
      { type: 'InstallSnapshot', body: { term: n.currentTerm, leaderId: n.id, snapshot: structuredClone(n.snapshot) } },
      `${p} needs entries already compacted into the snapshot (up to ${n.snapshot.lastIndex})`,
    )
    return
  }
  const prev = ni - 1
  const prevTerm = termAt(n, prev) ?? 0
  const entries = entriesFrom(n, ni, s.settings.batchSize)
  tr.set('rp.4', `prevLogIndex, prevLogTerm (${p})`, `${prev}, ${prevTerm}`)
  tr.set('rp.5', `entries (${p})`, entries.length ? `[${entries[0].index}..${entries[entries.length - 1].index}]` : '[] (heartbeat)')
  tr.line('rp.6', `→ ${p}`)
  ctx.send(
    n.id,
    p,
    {
      type: 'AppendEntries',
      body: {
        term: n.currentTerm,
        leaderId: n.id,
        prevLogIndex: prev,
        prevLogTerm: prevTerm,
        entries: structuredClone(entries),
        leaderCommit: n.commitIndex,
        readSeq: n.readSeq,
        sentAt: s.now,
      },
    },
    entries.length ? `${reason} · replicating ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : reason,
  )
}

export function handleAppendEntries(ctx: Ctx, n: RaftNode, m: Msg<'AppendEntries'>) {
  const { tr, s } = ctx
  const a = m.body
  const reply = (success: boolean, matchIndex: number, why: string, conflict?: { rejectedPrev?: number; conflictIndex?: number; conflictTerm?: number }) =>
    ctx.send(
      n.id,
      m.from,
      { type: 'AppendEntriesReply', body: { term: n.currentTerm, success, matchIndex, readSeq: a.readSeq, sentAt: a.sentAt, ...conflict } },
      why,
    )

  tr.line('ae.1')
  if (tr.cond('ae.2', 'term > currentTerm', `${a.term} > ${n.currentTerm}`, a.term > n.currentTerm)) becomeFollower(ctx, n, a.term, 'ae.2')
  if (tr.cond('ae.3', 'term < currentTerm', `${a.term} < ${n.currentTerm}`, a.term < n.currentTerm)) {
    reply(false, 0, `Rejected: ${m.from} is a stale leader (term ${a.term} < ${n.currentTerm})`)
    return
  }
  if (n.role !== 'follower') {
    n.role = 'follower'
    n.votesGranted = []
    tr.set('ae.4', 'state', 'follower')
  }
  n.leaderId = a.leaderId
  n.lastHeardFromLeader = s.now
  resetElectionTimer(ctx, n)
  tr.line('ae.4', `leader = ${a.leaderId}, timer reset (${n.electionTimeout}ms)`)

  // 2. consistency check
  const myPrevTerm = termAt(n, a.prevLogIndex)
  const compacted = a.prevLogIndex < n.snapshot.lastIndex
  const mismatch = !compacted && myPrevTerm !== a.prevLogTerm
  if (
    tr.cond(
      'ae.5',
      'log[prevLogIndex].term ≠ prevLogTerm',
      compacted ? `index ${a.prevLogIndex} is inside my snapshot (committed, matches)` : `log[${a.prevLogIndex}].term = ${myPrevTerm ?? 'missing'} ≠ ${a.prevLogTerm}`,
      mismatch,
    )
  ) {
    let conflict: { conflictIndex: number; conflictTerm?: number } | undefined
    if (s.settings.fastBackup) {
      if (myPrevTerm === null) conflict = { conflictIndex: lastLogIndex(n) + 1 }
      else {
        let ci = a.prevLogIndex
        while (ci - 1 > n.snapshot.lastIndex && termAt(n, ci - 1) === myPrevTerm) ci--
        conflict = { conflictIndex: ci, conflictTerm: myPrevTerm }
      }
      tr.note('ae.5', `fast backup hint: conflictIndex=${conflict.conflictIndex}, conflictTerm=${fmt(conflict.conflictTerm)}`)
    }
    reply(false, 0, `Consistency check failed at index ${a.prevLogIndex}: leader must back up`, { rejectedPrev: a.prevLogIndex, ...conflict })
    return
  }

  // 3 & 4. delete conflicts, append new entries
  let appended = 0
  for (const e of a.entries) {
    if (e.index <= n.snapshot.lastIndex) continue
    const existing = termAt(n, e.index)
    if (existing !== null && existing !== e.term) {
      tr.cond('ae.6', 'existing entry conflicts', `log[${e.index}].term = ${existing} ≠ ${e.term}`, true)
      tr.set('ae.6', 'log', `truncated from index ${e.index}`)
      truncateFrom(n, e.index)
    }
    if (termAt(n, e.index) === null) {
      n.log.push(structuredClone(e))
      appended++
    }
  }
  if (a.entries.length) tr.set('ae.7', 'appended', appended ? `${appended} new entr${appended === 1 ? 'y' : 'ies'}` : 'none (already present)')
  const lastNew = a.prevLogIndex + a.entries.length

  // 5. commit index
  if (tr.cond('ae.8', 'leaderCommit > commitIndex', `${a.leaderCommit} > ${n.commitIndex}`, a.leaderCommit > n.commitIndex)) {
    const nc = Math.max(n.commitIndex, Math.min(a.leaderCommit, lastNew))
    if (nc !== n.commitIndex) {
      n.commitIndex = nc
      tr.set('ae.8', 'commitIndex', `min(${a.leaderCommit}, ${lastNew}) = ${nc}`)
    }
  }
  tr.line('ae.9')
  reply(true, lastNew, a.entries.length ? `Accepted entries up to index ${lastNew}` : `Heartbeat ack (log matches up to ${lastNew})`)
  applyCommitted(ctx, n)
}

export function handleAppendReply(ctx: Ctx, n: RaftNode, m: Msg<'AppendEntriesReply'>) {
  const { tr, s } = ctx
  const r = m.body
  const f = m.from
  tr.line('ar.1')
  if (tr.cond('ar.2', 'term > currentTerm', `${r.term} > ${n.currentTerm}`, r.term > n.currentTerm)) {
    becomeFollower(ctx, n, r.term, 'ar.2')
    return
  }
  if (tr.cond('ar.3', 'state ≠ leader ∨ term ≠ currentTerm', `${n.role} ≠ leader ∨ ${r.term} ≠ ${n.currentTerm}`, n.role !== 'leader' || r.term !== n.currentTerm)) return
  n.lastAck[f] = s.now
  n.ackSentAt[f] = Math.max(n.ackSentAt[f] ?? -Infinity, r.sentAt)
  n.ackedReadSeq[f] = Math.max(n.ackedReadSeq[f] ?? 0, r.readSeq)
  if (r.success) {
    const before = n.matchIndex[f] ?? 0
    n.matchIndex[f] = Math.max(before, r.matchIndex)
    n.nextIndex[f] = n.matchIndex[f] + 1
    tr.set('ar.4', `matchIndex[${f}], nextIndex[${f}]`, `${n.matchIndex[f]}, ${n.nextIndex[f]}`)
    advanceCommitIndex(ctx, n)
    if (n.role !== 'leader') return
    // only the reply that made progress continues the catch-up (avoids parallel duplicate streams)
    if (r.matchIndex > before && n.matchIndex[f] < lastLogIndex(n)) sendAppend(ctx, n, f, `${f} is still behind: sending the next batch`)
  } else if (r.rejectedPrev !== undefined && r.rejectedPrev !== (n.nextIndex[f] ?? 0) - 1) {
    tr.note('ar.6', `stale rejection (prevLogIndex ${r.rejectedPrev}, nextIndex already ${n.nextIndex[f]}): ignored`)
  } else {
    const old = n.nextIndex[f] ?? lastLogIndex(n) + 1
    let ni: number
    if (s.settings.fastBackup && r.conflictIndex !== undefined) {
      ni = r.conflictIndex
      if (r.conflictTerm !== undefined) {
        for (let k = n.log.length - 1; k >= 0; k--)
          if (n.log[k].term === r.conflictTerm) {
            ni = n.log[k].index + 1
            break
          }
      }
      tr.set('ar.5', `nextIndex[${f}]`, `${old} → ${ni} (conflictTerm=${fmt(r.conflictTerm)}, conflictIndex=${r.conflictIndex})`)
    } else {
      ni = old - 1
      tr.set('ar.6', `nextIndex[${f}]`, `${old} − 1 = ${ni}`)
    }
    n.nextIndex[f] = Math.max(1, (n.matchIndex[f] ?? 0) + 1, Math.min(ni, lastLogIndex(n) + 1))
    tr.line('ar.7')
    sendAppend(ctx, n, f, `Retry: backing up nextIndex[${f}] to ${n.nextIndex[f]}`)
  }
  checkTransfer(ctx, n)
  maybeAdvanceConfig(ctx, n)
  processReads(ctx, n)
}

export function advanceCommitIndex(ctx: Ctx, n: RaftNode) {
  const { tr, s } = ctx
  if (n.role !== 'leader') return
  const cfg = latestConfig(n)
  const last = lastLogIndex(n)
  if (last <= n.commitIndex) return
  tr.line('cm.1')
  const agreeing = (N: number) => [n.id, ...Object.keys(n.matchIndex).filter((p) => n.matchIndex[p] >= N)]
  let blockedOld: number | null = null
  for (let N = last; N > n.commitIndex; N--) {
    const agree = agreeing(N)
    if (!hasQuorum(cfg, agree)) continue
    const t = termAt(n, N)
    const ok = t === n.currentTerm || s.settings.unsafeCommitOldTerms
    if (!ok) {
      if (blockedOld === null) blockedOld = N
      continue
    }
    tr.line('cm.2')
    tr.cond('cm.3', 'majority has matchIndex ≥ N', `N=${N}: {${agree.filter((x) => isVoter(cfg, x)).join(',')}}`, true)
    tr.cond('cm.4', 'log[N].term = currentTerm', `${t} = ${n.currentTerm}${s.settings.unsafeCommitOldTerms ? ' [check DISABLED]' : ''}`, true)
    n.commitIndex = N
    tr.set('cm.5', 'commitIndex', N)
    applyCommitted(ctx, n)
    maybeAdvanceConfig(ctx, n)
    return
  }
  if (blockedOld !== null)
    tr.cond('cm.4', 'log[N].term = currentTerm', `N=${blockedOld}: ${termAt(n, blockedOld)} ≠ ${n.currentTerm} (replicated on a majority but from an older term!)`, false)
  else tr.cond('cm.3', 'majority has matchIndex ≥ N', `N=${n.commitIndex + 1}: only {${agreeing(n.commitIndex + 1).join(',')}}`, false)
}

export function applyCommitted(ctx: Ctx, n: RaftNode) {
  const { tr } = ctx
  if (n.lastApplied >= n.commitIndex) return
  tr.line('ap.1')
  while (n.lastApplied < n.commitIndex) {
    n.lastApplied++
    const e = entryAt(n, n.lastApplied)
    if (!e) continue
    tr.set('ap.2', 'lastApplied', n.lastApplied)
    let result: string | null = null
    if (e.kind === 'command' && e.command) {
      const sess = e.clientId !== undefined ? n.sessions[e.clientId] : undefined
      if (e.clientId !== undefined && e.seq !== undefined && tr.cond('ap.3', '(clientId, seq) already applied', `seq ${e.seq} ≤ last applied ${sess?.seq ?? '—'}`, !!sess && sess.seq >= e.seq)) {
        result = sess!.seq === e.seq ? sess!.result : null
      } else {
        if (e.command.op === 'set') {
          n.kv[e.command.key] = e.command.value
          result = e.command.value
          tr.set('ap.4', `kv[${e.command.key}]`, e.command.value)
        } else {
          result = n.kv[e.command.key] ?? null
          tr.set('ap.4', `read ${e.command.key}`, result)
        }
        if (e.clientId !== undefined && e.seq !== undefined) n.sessions[e.clientId] = { seq: e.seq, result }
      }
    } else tr.note('ap.4', e.kind === 'noop' ? 'no-op: nothing to apply' : 'configuration entry (already in effect)')
    recordApply(ctx.s, n, e)
    if (n.role === 'leader') {
      const i = n.pendingClient.findIndex((p) => p.index === e.index)
      if (i >= 0) {
        const p = n.pendingClient[i]
        n.pendingClient.splice(i, 1)
        if (p.clientId === e.clientId && p.seq === e.seq) {
          tr.line('ap.5', `reply to client (seq ${p.seq})`)
          sendClientReply(ctx, n, { seq: p.seq, ok: true, leaderHint: n.id, value: result }, `Entry ${e.index} committed and applied: reply to client`)
        }
      }
    }
  }
  maybeSnapshot(ctx, n)
  processReads(ctx, n)
}

// ------------------------------------------------------------------ snapshots

export function maybeSnapshot(ctx: Ctx, n: RaftNode, force = false) {
  const th = ctx.s.settings.snapshotThreshold
  const since = n.lastApplied - n.snapshot.lastIndex
  if (!force && (th <= 0 || since < th)) return
  if (since <= 0) return
  const { tr } = ctx
  tr.cond('sn.1', 'lastApplied − snapshot.lastIndex ≥ threshold', force ? 'forced by user' : `${n.lastApplied} − ${n.snapshot.lastIndex} ≥ ${th}`, true)
  const idx = n.lastApplied
  n.snapshot = {
    lastIndex: idx,
    lastTerm: termAt(n, idx) ?? n.snapshot.lastTerm,
    kv: { ...n.kv },
    sessions: structuredClone(n.sessions),
    config: structuredClone(configAt(n, idx)),
  }
  tr.set('sn.2', 'snapshot', `lastIncludedIndex=${idx}, lastIncludedTerm=${n.snapshot.lastTerm}`)
  n.log = n.log.filter((e) => e.index > idx)
  tr.set('sn.3', 'log', `entries ≤ ${idx} discarded`)
}

export function handleInstallSnapshot(ctx: Ctx, n: RaftNode, m: Msg<'InstallSnapshot'>) {
  const { tr, s } = ctx
  const a = m.body
  const snap = a.snapshot
  const reply = (why: string) =>
    ctx.send(n.id, m.from, { type: 'InstallSnapshotReply', body: { term: n.currentTerm, lastIncludedIndex: snap.lastIndex } }, why)
  tr.line('is.1')
  if (tr.cond('is.2', 'term < currentTerm', `${a.term} < ${n.currentTerm}`, a.term < n.currentTerm)) {
    reply('Snapshot rejected: stale leader')
    return
  }
  if (a.term > n.currentTerm) becomeFollower(ctx, n, a.term, 'is.3')
  if (n.role !== 'follower') n.role = 'follower'
  n.leaderId = a.leaderId
  n.lastHeardFromLeader = s.now
  resetElectionTimer(ctx, n)
  tr.line('is.3')
  if (tr.cond('is.4', 'lastIncludedIndex ≤ snapshot.lastIndex', `${snap.lastIndex} ≤ ${n.snapshot.lastIndex}`, snap.lastIndex <= n.snapshot.lastIndex)) {
    reply('Already have this snapshot')
    return
  }
  const t = termAt(n, snap.lastIndex)
  if (tr.cond('is.5', 'log[lastIncludedIndex].term = lastIncludedTerm', `${t ?? 'missing'} = ${snap.lastTerm}`, t === snap.lastTerm)) {
    n.log = n.log.filter((e) => e.index > snap.lastIndex)
    n.snapshot = structuredClone(snap)
    tr.set('is.5', 'log', `kept entries after ${snap.lastIndex}`)
  } else {
    n.log = []
    tr.set('is.6', 'log', '[] (discarded)')
    n.snapshot = structuredClone(snap)
  }
  n.commitIndex = Math.max(n.commitIndex, snap.lastIndex)
  if (n.lastApplied < snap.lastIndex) {
    n.kv = { ...snap.kv }
    n.sessions = structuredClone(snap.sessions)
    n.lastApplied = snap.lastIndex
    tr.set('is.7', 'state machine', `restored from snapshot (lastApplied=${snap.lastIndex})`)
  }
  tr.line('is.8')
  reply(`Installed snapshot up to index ${snap.lastIndex}`)
  applyCommitted(ctx, n)
}

export function handleSnapshotReply(ctx: Ctx, n: RaftNode, m: Msg<'InstallSnapshotReply'>) {
  const { tr, s } = ctx
  const r = m.body
  const f = m.from
  tr.line('sr.1')
  if (tr.cond('sr.2', 'term > currentTerm', `${r.term} > ${n.currentTerm}`, r.term > n.currentTerm)) {
    becomeFollower(ctx, n, r.term, 'sr.2')
    return
  }
  if (n.role !== 'leader' || r.term !== n.currentTerm) return
  n.lastAck[f] = s.now
  n.matchIndex[f] = Math.max(n.matchIndex[f] ?? 0, r.lastIncludedIndex)
  n.nextIndex[f] = n.matchIndex[f] + 1
  tr.set('sr.3', `matchIndex[${f}], nextIndex[${f}]`, `${n.matchIndex[f]}, ${n.nextIndex[f]}`)
  advanceCommitIndex(ctx, n)
  if (n.role === 'leader' && n.matchIndex[f] < lastLogIndex(n)) sendAppend(ctx, n, f, `${f} installed the snapshot: continue with the log`)
  checkTransfer(ctx, n)
  maybeAdvanceConfig(ctx, n)
}

// ------------------------------------------------------------------ clients & reads

function sendClientReply(ctx: Ctx, n: RaftNode, body: ClientReplyArgs, why: string) {
  ctx.send(n.id, CLIENT_ID, { type: 'ClientReply', body }, why)
}

export function handleClientRequest(ctx: Ctx, n: RaftNode, m: Msg<'ClientRequest'>) {
  const { tr, s } = ctx
  const a: ClientRequestArgs = m.body
  tr.line('cl.1')
  if (tr.cond('cl.2', 'state ≠ leader', `${n.role} ≠ leader`, n.role !== 'leader')) {
    sendClientReply(ctx, n, { seq: a.seq, ok: false, leaderHint: n.leaderId }, n.leaderId ? `Not the leader: try ${n.leaderId}` : 'Not the leader, and no leader known')
    return
  }
  if (tr.cond('cl.3', 'transfer in progress', n.transfer ? `→ ${n.transfer.target}` : 'no', !!n.transfer)) {
    sendClientReply(ctx, n, { seq: a.seq, ok: false, leaderHint: n.transfer!.target, error: 'leadership transfer in progress' }, 'Rejected: leadership transfer in progress')
    return
  }
  const sess = n.sessions[a.clientId]
  if (tr.cond('cl.4', 'seq already applied', `${a.seq} ≤ ${sess?.seq ?? '—'}`, !!sess && sess.seq >= a.seq)) {
    sendClientReply(ctx, n, { seq: a.seq, ok: true, leaderHint: n.id, value: sess.seq === a.seq ? sess.result : null }, 'Duplicate request: replying with cached result')
    return
  }
  if (n.pendingClient.some((p) => p.clientId === a.clientId && p.seq === a.seq) || n.pendingReads.some((p) => p.clientId === a.clientId && p.seq === a.seq)) {
    tr.note('cl.4', 'already in progress: will reply when done')
    return
  }
  if (tr.cond('cl.5', 'read-only ∧ readMode ≠ log', `${a.command.op} ∧ ${s.settings.readMode}`, a.command.op === 'get' && s.settings.readMode !== 'log')) {
    tr.line('rd.1')
    n.pendingReads.push({ clientId: a.clientId, seq: a.seq, key: a.command.key, readIndex: null, readSeq: 0, confirmed: false })
    processReads(ctx, n)
    return
  }
  const e = append(n, { kind: 'command', command: a.command, clientId: a.clientId, seq: a.seq })
  n.pendingClient.push({ index: e.index, clientId: a.clientId, seq: a.seq })
  tr.set('cl.6', `log[${e.index}]`, `term ${e.term}`)
  if (s.settings.replicateImmediately) {
    tr.line('cl.7', 'replicating now')
    broadcastAppend(ctx, n, `New client entry ${e.index}`)
  } else tr.note('cl.7', 'will be sent with the next heartbeat')
  advanceCommitIndex(ctx, n)
  tr.line('cl.8')
}

function leaseExpiry(ctx: Ctx, n: RaftNode): number {
  const cfg = latestConfig(n)
  const times: Record<NodeId, number> = { ...n.ackSentAt, [n.id]: ctx.s.now }
  const candidates = [...new Set(Object.values(times))].sort((a, b) => b - a)
  for (const t of candidates) {
    if (hasQuorum(cfg, Object.keys(times).filter((id) => times[id] >= t))) return t + ctx.s.settings.electionTimeoutMin * 0.9
  }
  return -Infinity
}

export function processReads(ctx: Ctx, n: RaftNode) {
  if (n.role !== 'leader' || n.pendingReads.length === 0) return
  const { tr, s } = ctx
  const cfg = latestConfig(n)
  let needRound = false
  for (const r of n.pendingReads) {
    if (r.readIndex === null) {
      const committedOwnTerm = termAt(n, n.commitIndex) === n.currentTerm
      if (!tr.cond('rd.2', 'entry of currentTerm committed', `term(log[${n.commitIndex}]) = ${termAt(n, n.commitIndex)} = ${n.currentTerm}`, committedOwnTerm)) continue
      r.readIndex = n.commitIndex
      tr.set('rd.3', 'readIndex', r.readIndex)
      const exp = leaseExpiry(ctx, n)
      if (s.settings.readMode === 'lease' && tr.cond('rd.5', 'lease still valid', `now ${Math.round(s.now)} < ${Math.round(exp)}`, s.now < exp)) r.confirmed = true
      else {
        n.readSeq++
        r.readSeq = n.readSeq
        needRound = true
      }
    }
    if (!r.confirmed && r.readSeq > 0) {
      const acks = [n.id, ...Object.keys(n.ackedReadSeq).filter((p) => n.ackedReadSeq[p] >= r.readSeq)]
      if (hasQuorum(cfg, acks)) {
        r.confirmed = true
        tr.cond('rd.4', 'majority acked heartbeat round', `{${acks.join(',')}}`, true)
      }
    }
  }
  if (needRound) {
    tr.line('rd.4', 'start a heartbeat round to confirm leadership')
    broadcastAppend(ctx, n, 'ReadIndex: confirming I am still leader with a majority')
  }
  const done = n.pendingReads.filter((r) => r.confirmed && r.readIndex !== null && n.lastApplied >= r.readIndex)
  for (const r of done) {
    tr.cond('rd.6', 'lastApplied ≥ readIndex', `${n.lastApplied} ≥ ${r.readIndex}`, true)
    const value = n.kv[r.key] ?? null
    tr.line('rd.7', `${r.key} = ${fmt(value)}`)
    sendClientReply(ctx, n, { seq: r.seq, ok: true, leaderHint: n.id, value }, `Linearizable read (${s.settings.readMode}) of ${r.key}`)
  }
  n.pendingReads = n.pendingReads.filter((r) => !done.includes(r))
}

// ------------------------------------------------------------------ leader timers & optimizations

export function checkQuorum(ctx: Ctx, n: RaftNode) {
  const { tr, s } = ctx
  tr.line('cq.1')
  const cfg = latestConfig(n)
  const active = [n.id, ...Object.keys(n.lastAck).filter((p) => n.lastAck[p] > n.lastQuorumCheck)]
  const ok = hasQuorum(cfg, active)
  n.lastQuorumCheck = s.now
  resetElectionTimer(ctx, n)
  if (tr.cond('cq.2', 'majority has NOT responded', `active {${active.join(',')}} of ${describeConfig(cfg)}`, !ok)) becomeFollower(ctx, n, n.currentTerm, 'cq.2')
}

export function startTransfer(ctx: Ctx, n: RaftNode, target: NodeId) {
  const { tr, s } = ctx
  tr.line('tr.1', `target ${target}`)
  n.transfer = { target, deadline: s.now + s.settings.electionTimeoutMax, sent: false }
  tr.line('tr.2')
  tr.line('tr.3', `matchIndex[${target}] = ${n.matchIndex[target] ?? 0}, lastLogIndex = ${lastLogIndex(n)}`)
  if (!checkTransfer(ctx, n)) sendAppend(ctx, n, target, 'Leadership transfer: bring target up to date')
}

function checkTransfer(ctx: Ctx, n: RaftNode): boolean {
  const t = n.transfer
  if (!t || t.sent || n.role !== 'leader') return false
  if ((n.matchIndex[t.target] ?? 0) < lastLogIndex(n)) return false
  t.sent = true
  ctx.tr.line('tr.4', `→ ${t.target}`)
  ctx.send(n.id, t.target, { type: 'TimeoutNow', body: { term: n.currentTerm } }, `Leadership transfer: ${t.target} is up to date, tell it to start an election now`)
  return true
}

export function abortTransfer(ctx: Ctx, n: RaftNode) {
  ctx.tr.line('tr.6')
  n.transfer = null
}

export function handleTimeoutNow(ctx: Ctx, n: RaftNode, m: Msg<'TimeoutNow'>) {
  const { tr } = ctx
  tr.line('tr.5')
  if (m.body.term < n.currentTerm || !isVoter(latestConfig(n), n.id)) {
    tr.note('tr.5', 'stale or not a voter: ignored')
    return
  }
  startElection(ctx, n, true)
}

// ------------------------------------------------------------------ membership

export function maybeAdvanceConfig(ctx: Ctx, n: RaftNode) {
  if (n.role !== 'leader') return
  const { tr } = ctx
  const cfg = latestConfig(n)
  const committed = latestConfigIndex(n) <= n.commitIndex
  if (isJoint(cfg)) {
    if (!committed) return
    tr.line('cf.4')
    const e = append(n, { kind: 'config', config: { voters: [...cfg.newVoters!] } })
    tr.set('cf.4', `log[${e.index}]`, `C_new ${describeConfig(e.config!)}`)
    broadcastAppend(ctx, n, 'C_old,new committed: replicate C_new')
    advanceCommitIndex(ctx, n)
    return
  }
  if (!committed) return
  if (!isVoter(cfg, n.id)) {
    tr.line('cf.6')
    tr.line('cf.5')
    becomeFollower(ctx, n, n.currentTerm, 'cf.6')
    return
  }
  const pc = n.pendingChange
  if (!pc) return
  if (pc.type === 'add') {
    if (isVoter(cfg, pc.id)) {
      n.pendingChange = null
      return
    }
    if ((n.matchIndex[pc.id] ?? 0) < n.commitIndex) {
      tr.note('cf.2', `learner ${pc.id} catching up (matchIndex ${n.matchIndex[pc.id] ?? 0} < commitIndex ${n.commitIndex})`)
      return
    }
    tr.line('cf.2', `${pc.id} caught up`)
    n.learners = n.learners.filter((l) => l !== pc.id)
    const e = append(n, { kind: 'config', config: { voters: [...cfg.voters], newVoters: [...cfg.voters, pc.id] } })
    tr.set('cf.3', `log[${e.index}]`, describeConfig(e.config!))
  } else {
    if (!isVoter(cfg, pc.id)) {
      n.pendingChange = null
      return
    }
    const e = append(n, { kind: 'config', config: { voters: [...cfg.voters], newVoters: cfg.voters.filter((v) => v !== pc.id) } })
    tr.set('cf.3', `log[${e.index}]`, describeConfig(e.config!))
  }
  n.pendingChange = null
  broadcastAppend(ctx, n, 'Replicate joint configuration C_old,new')
  advanceCommitIndex(ctx, n)
}

export function requestMembershipChange(ctx: Ctx, n: RaftNode, change: { type: 'add' | 'remove'; id: NodeId }) {
  const { tr } = ctx
  tr.line('cf.1', `${change.type} ${change.id}`)
  n.pendingChange = change
  if (change.type === 'add') {
    if (!n.learners.includes(change.id)) n.learners.push(change.id)
    n.nextIndex[change.id] = lastLogIndex(n) + 1
    n.matchIndex[change.id] = 0
    tr.line('cf.2', `${change.id} joins as non-voting learner`)
    sendAppend(ctx, n, change.id, `Catch up new server ${change.id} (non-voting)`)
  }
  maybeAdvanceConfig(ctx, n)
}
