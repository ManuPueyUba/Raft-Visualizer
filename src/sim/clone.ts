import type { RaftNode, SimState } from './types'

/** Copies the simulation state for checkpoints, sharing the parts that are
 *  never mutated after creation (log entries, message bodies, snapshots,
 *  session records). Much cheaper than structuredClone for long logs. */
export function cloneState(s: SimState): SimState {
  const nodes: Record<string, RaftNode> = {}
  for (const id of Object.keys(s.nodes)) {
    const n = s.nodes[id]
    nodes[id] = {
      ...n,
      log: n.log.slice(),
      kv: { ...n.kv },
      sessions: { ...n.sessions },
      votesGranted: n.votesGranted.slice(),
      nextIndex: { ...n.nextIndex },
      matchIndex: { ...n.matchIndex },
      lastAck: { ...n.lastAck },
      ackSentAt: { ...n.ackSentAt },
      ackedReadSeq: { ...n.ackedReadSeq },
      pendingReads: n.pendingReads.map((r) => ({ ...r })),
      pendingClient: n.pendingClient.slice(),
      learners: n.learners.slice(),
      transfer: n.transfer && { ...n.transfer },
    }
  }
  return {
    ...s,
    nodes,
    nodeOrder: s.nodeOrder.slice(),
    messages: s.messages.map((m) => ({ ...m })),
    client: { ...s.client, ops: s.client.ops.map((o) => ({ ...o })) },
    settings: { ...s.settings },
    partition: s.partition && s.partition.map((g) => g.slice()),
    blockedLinks: s.blockedLinks.slice(),
    oracle: {
      leadersByTerm: { ...s.oracle.leadersByTerm },
      committed: { ...s.oracle.committed },
      applied: { ...s.oracle.applied },
      leaderLast: { ...s.oracle.leaderLast },
      violations: s.oracle.violations.slice(),
    },
  }
}
