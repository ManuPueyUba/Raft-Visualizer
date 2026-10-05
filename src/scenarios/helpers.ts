import { lastLogIndex, termAt } from '../sim/log'
import type { Simulation } from '../sim/simulation'
import type { NodeId } from '../sim/types'
import { fastForward } from './runner'

export const node = (sim: Simulation, id: NodeId) => sim.s.nodes[id]
export const leaderId = (sim: Simulation) => sim.leader()?.id ?? null
export const isLeader = (sim: Simulation, id: NodeId) => node(sim, id).alive && node(sim, id).role === 'leader'
export const lastIndex = (sim: Simulation, id: NodeId) => lastLogIndex(node(sim, id))
export const termOf = (sim: Simulation, id: NodeId, index: number) => termAt(node(sim, id), index)
/** No message from `id` is still on the wire (so crashing it now leaves nothing behind). */
export const quiet = (sim: Simulation, id: NodeId) => !sim.s.messages.some((m) => m.from === id && !m.dropped)
export const inFlight = (sim: Simulation, type?: string) => sim.s.messages.some((m) => !type || m.type === type)

/** Timers for every node except `except`. */
export function timersExcept(sim: Simulation, except: NodeId[], ms: number): Record<NodeId, number> {
  return Object.fromEntries(sim.s.nodeOrder.filter((x) => !except.includes(x)).map((x) => [x, ms]))
}

/** Every live member has the leader's whole log and commit index. */
export function settled(sim: Simulation): boolean {
  const l = sim.leader()
  if (!l || l.commitIndex < lastLogIndex(l)) return false
  return sim.s.nodeOrder.every((id) => {
    const n = node(sim, id)
    return !n.alive || (lastLogIndex(n) === lastLogIndex(l) && n.commitIndex === l.commitIndex)
  })
}

/** Instantly makes `id` win an election and waits until everyone has caught up. */
export function elect(sim: Simulation, id: NodeId) {
  sim.setTimers({ ...timersExcept(sim, [id], 5000), [id]: 5 })
  fastForward(sim, () => isLeader(sim, id) && settled(sim))
}

/** Instantly commits a few SETs through the current leader. */
export function commitWrites(sim: Simulation, writes: [string, string][]) {
  const l = leaderId(sim)
  if (!l) throw new Error('no leader')
  for (const [key, value] of writes) sim.propose(l, { op: 'set', key, value })
  fastForward(sim, () => settled(sim))
}
