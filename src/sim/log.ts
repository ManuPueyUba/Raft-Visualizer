import type { ClusterConfig, LogEntry, NodeId, RaftNode } from './types'

export const lastLogIndex = (n: RaftNode) =>
  n.log.length ? n.log[n.log.length - 1].index : n.snapshot.lastIndex

export const lastLogTerm = (n: RaftNode) =>
  n.log.length ? n.log[n.log.length - 1].term : n.snapshot.lastTerm

/** Term of the entry at `i`; null if absent, and also null if compacted
 *  into the snapshot (except the snapshot's last index itself). */
export function termAt(n: RaftNode, i: number): number | null {
  if (i === n.snapshot.lastIndex) return n.snapshot.lastTerm
  if (i < n.snapshot.lastIndex) return null
  const e = n.log[i - n.snapshot.lastIndex - 1]
  return e ? e.term : null
}

export function entryAt(n: RaftNode, i: number): LogEntry | undefined {
  if (i <= n.snapshot.lastIndex) return undefined
  return n.log[i - n.snapshot.lastIndex - 1]
}

export function entriesFrom(n: RaftNode, from: number, max: number): LogEntry[] {
  const start = from - n.snapshot.lastIndex - 1
  return n.log.slice(Math.max(0, start), Math.max(0, start) + max)
}

export function truncateFrom(n: RaftNode, i: number) {
  n.log = n.log.slice(0, Math.max(0, i - n.snapshot.lastIndex - 1))
}

/** Raft servers always use the latest configuration in their log,
 *  committed or not (§6). */
export function latestConfig(n: RaftNode): ClusterConfig {
  return configAt(n, Infinity)
}

export function latestConfigIndex(n: RaftNode): number {
  for (let k = n.log.length - 1; k >= 0; k--) if (n.log[k].kind === 'config') return n.log[k].index
  return n.snapshot.lastIndex
}

export function configAt(n: RaftNode, upTo: number): ClusterConfig {
  for (let k = n.log.length - 1; k >= 0; k--) {
    const e = n.log[k]
    if (e.index <= upTo && e.kind === 'config' && e.config) return e.config
  }
  return n.snapshot.config
}

export const isJoint = (c: ClusterConfig) => c.newVoters !== undefined

export function members(c: ClusterConfig): NodeId[] {
  const s = new Set(c.voters)
  for (const v of c.newVoters ?? []) s.add(v)
  return [...s]
}

export const isVoter = (c: ClusterConfig, id: NodeId) =>
  c.voters.includes(id) || (c.newVoters?.includes(id) ?? false)

const majorityOf = (set: NodeId[], granted: Set<NodeId>) =>
  set.length === 0 ? false : set.filter((v) => granted.has(v)).length * 2 > set.length

/** True if `granted` is a majority of the configuration. In joint consensus
 *  it must be a majority of C_old AND a majority of C_new. */
export function hasQuorum(c: ClusterConfig, granted: Iterable<NodeId>): boolean {
  const g = new Set(granted)
  if (!majorityOf(c.voters, g)) return false
  if (c.newVoters && !majorityOf(c.newVoters, g)) return false
  return true
}

export function describeConfig(c: ClusterConfig): string {
  return c.newVoters ? `C_old,new {${c.voters.join(',')}} + {${c.newVoters.join(',')}}` : `{${c.voters.join(',')}}`
}

export function describeEntry(e: LogEntry): string {
  if (e.kind === 'noop') return 'no-op'
  if (e.kind === 'config' && e.config) return describeConfig(e.config)
  if (e.command?.op === 'set') return `${e.command.key}←${e.command.value}`
  if (e.command?.op === 'get') return `get ${e.command.key}`
  return '?'
}
