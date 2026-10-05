export type NodeId = string

export type Role = 'follower' | 'precandidate' | 'candidate' | 'leader'

/** A cluster configuration. When `newVoters` is present the cluster is in
 *  joint consensus (C_old,new): decisions need a majority of BOTH sets. */
export interface ClusterConfig {
  voters: NodeId[]
  newVoters?: NodeId[]
}

export type Command =
  | { op: 'set'; key: string; value: string }
  | { op: 'get'; key: string }

export interface LogEntry {
  index: number
  term: number
  kind: 'command' | 'noop' | 'config'
  command?: Command
  config?: ClusterConfig
  clientId?: string
  seq?: number
}

export interface Session {
  seq: number
  result: string | null
}

export interface Snapshot {
  lastIndex: number
  lastTerm: number
  kv: Record<string, string>
  sessions: Record<string, Session>
  config: ClusterConfig
}

export interface PendingRead {
  clientId: string
  seq: number
  key: string
  readIndex: number | null
  readSeq: number
  confirmed: boolean
}

export interface PendingClient {
  index: number
  clientId: string
  seq: number
}

export interface RaftNode {
  id: NodeId
  alive: boolean
  // ---- persistent state (survives crashes) ----
  currentTerm: number
  votedFor: NodeId | null
  log: LogEntry[] // entries with index > snapshot.lastIndex
  snapshot: Snapshot
  // ---- volatile state ----
  role: Role
  leaderId: NodeId | null
  commitIndex: number
  lastApplied: number
  kv: Record<string, string>
  sessions: Record<string, Session>
  votesGranted: NodeId[]
  electionTimeout: number
  electionDeadline: number
  lastHeardFromLeader: number
  // ---- volatile state on leaders (reinitialized after election) ----
  nextIndex: Record<NodeId, number>
  matchIndex: Record<NodeId, number>
  heartbeatDeadline: number
  lastAck: Record<NodeId, number>
  ackSentAt: Record<NodeId, number>
  ackedReadSeq: Record<NodeId, number>
  readSeq: number
  pendingReads: PendingRead[]
  pendingClient: PendingClient[]
  learners: NodeId[]
  pendingChange: { type: 'add' | 'remove'; id: NodeId } | null
  transfer: { target: NodeId; deadline: number; sent: boolean } | null
  lastQuorumCheck: number
}

// ---------------------------------------------------------------- messages

export interface RequestVoteArgs {
  term: number
  candidateId: NodeId
  lastLogIndex: number
  lastLogTerm: number
  preVote: boolean
  transfer: boolean
}
export interface RequestVoteReply {
  term: number
  voteGranted: boolean
  preVote: boolean
}
export interface AppendEntriesArgs {
  term: number
  leaderId: NodeId
  prevLogIndex: number
  prevLogTerm: number
  entries: LogEntry[]
  leaderCommit: number
  readSeq: number
  sentAt: number
}
export interface AppendEntriesReply {
  term: number
  success: boolean
  matchIndex: number
  /** prevLogIndex of the rejected request, so the leader can ignore stale rejections */
  rejectedPrev?: number
  conflictIndex?: number
  conflictTerm?: number
  readSeq: number
  sentAt: number
}
export interface InstallSnapshotArgs {
  term: number
  leaderId: NodeId
  snapshot: Snapshot
}
export interface InstallSnapshotReply {
  term: number
  lastIncludedIndex: number
}
export interface TimeoutNowArgs {
  term: number
}
export interface ClientRequestArgs {
  clientId: string
  seq: number
  command: Command
}
export interface ClientReplyArgs {
  seq: number
  ok: boolean
  leaderHint: NodeId | null
  value?: string | null
  error?: string
}

export type Payload =
  | { type: 'RequestVote'; body: RequestVoteArgs }
  | { type: 'RequestVoteReply'; body: RequestVoteReply }
  | { type: 'AppendEntries'; body: AppendEntriesArgs }
  | { type: 'AppendEntriesReply'; body: AppendEntriesReply }
  | { type: 'InstallSnapshot'; body: InstallSnapshotArgs }
  | { type: 'InstallSnapshotReply'; body: InstallSnapshotReply }
  | { type: 'TimeoutNow'; body: TimeoutNowArgs }
  | { type: 'ClientRequest'; body: ClientRequestArgs }
  | { type: 'ClientReply'; body: ClientReplyArgs }

export type MessageType = Payload['type']

export type Message = Payload & {
  id: number
  from: NodeId
  to: NodeId
  sendTime: number
  deliverTime: number
  dropped: boolean
  dropReason?: string
  reason: string
}

// ---------------------------------------------------------------- client

export const CLIENT_ID = 'client'

export interface ClientOp {
  seq: number
  command: Command
  status: 'queued' | 'pending' | 'ok' | 'failed'
  result?: string | null
  attempts: number
  /** server chosen by the user for the first attempt (otherwise the client's leader guess) */
  target?: NodeId
  sentTo?: NodeId
  sentAt?: number
  doneAt?: number
}

export interface ClientState {
  seq: number
  leaderGuess: NodeId | null
  ops: ClientOp[]
  retryAt: number
  nextAutoAt: number
}

// ---------------------------------------------------------------- settings

export type ReadMode = 'log' | 'readIndex' | 'lease'

export interface Settings {
  electionTimeoutMin: number
  electionTimeoutMax: number
  heartbeatInterval: number
  latencyMin: number
  latencyMax: number
  dropRate: number
  batchSize: number
  replicateImmediately: boolean
  snapshotThreshold: number // 0 = never
  noopOnElection: boolean
  preVote: boolean
  checkQuorum: boolean
  fastBackup: boolean
  disruptionGuard: boolean
  readMode: ReadMode
  clientTimeout: number
  autoClientInterval: number // 0 = off
  // deliberately unsafe switches, to see why the rules exist
  unsafeNoElectionRestriction: boolean
  unsafeCommitOldTerms: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  electionTimeoutMin: 300,
  electionTimeoutMax: 600,
  heartbeatInterval: 100,
  latencyMin: 40,
  latencyMax: 60,
  dropRate: 0,
  batchSize: 5,
  replicateImmediately: true,
  snapshotThreshold: 0,
  noopOnElection: true,
  preVote: false,
  checkQuorum: false,
  fastBackup: false,
  disruptionGuard: true,
  readMode: 'log',
  clientTimeout: 1200,
  autoClientInterval: 0,
  unsafeNoElectionRestriction: false,
  unsafeCommitOldTerms: false,
}

// ---------------------------------------------------------------- tracing

export interface TraceStep {
  line: string
  kind: 'line' | 'cond' | 'set' | 'note'
  expr?: string
  values?: string
  result?: boolean
  text?: string
}

export interface SimEvent {
  id: number
  time: number
  kind: 'deliver' | 'drop' | 'timer' | 'action' | 'client'
  nodeId: NodeId | null
  title: string
  msg?: Message
  trace: TraceStep[]
}

// ---------------------------------------------------------------- oracle

/** Global knowledge that no real node has, used only to check the safety
 *  properties of Figure 3 while the simulation runs. */
export interface Oracle {
  leadersByTerm: Record<number, NodeId>
  committed: Record<number, { term: number; inTerm: number }> // index -> entry term, term when first seen committed
  applied: Record<number, string> // index -> entry signature
  leaderLast: Record<NodeId, { term: number; index: number; entryTerm: number }>
  violations: { time: number; property: string; detail: string }[]
}

export interface SimState {
  now: number
  seed: number
  rng: number
  nextMsgId: number
  nextNodeNum: number
  nodes: Record<NodeId, RaftNode>
  nodeOrder: NodeId[]
  messages: Message[]
  client: ClientState
  settings: Settings
  partition: NodeId[][] | null
  blockedLinks: string[]
  eventCount: number
  oracle: Oracle
}
