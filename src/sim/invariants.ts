import { describeEntry, lastLogIndex, termAt } from './log'
import type { LogEntry, RaftNode, SimState } from './types'

export const PROPERTIES = [
  { id: 'Election Safety', text: 'At most one leader can be elected in a given term.' },
  { id: 'Leader Append-Only', text: 'A leader never overwrites or deletes entries in its log; it only appends new entries.' },
  { id: 'Log Matching', text: 'If two logs contain an entry with the same index and term, then the logs are identical in all entries up through that index.' },
  { id: 'Leader Completeness', text: 'If a log entry is committed in a given term, then that entry will be present in the logs of the leaders for all higher-numbered terms.' },
  { id: 'State Machine Safety', text: 'If a server has applied a log entry at a given index to its state machine, no other server will ever apply a different log entry for the same index.' },
] as const

function violate(s: SimState, property: string, detail: string) {
  const o = s.oracle
  if (o.violations.some((v) => v.property === property && v.detail === detail)) return
  if (o.violations.length < 50) o.violations.push({ time: s.now, property, detail })
}

const signature = (e: LogEntry) => `${e.term}:${describeEntry(e)}:${e.clientId ?? ''}:${e.seq ?? ''}`

export function recordApply(s: SimState, n: RaftNode, e: LogEntry) {
  const sig = signature(e)
  const prev = s.oracle.applied[e.index]
  if (prev === undefined) s.oracle.applied[e.index] = sig
  else if (prev !== sig) violate(s, 'State Machine Safety', `${n.id} applied "${sig}" at index ${e.index}, but another server applied "${prev}"`)
}

/** Checks the properties of Figure 3 against the global state. */
export function checkInvariants(s: SimState) {
  const o = s.oracle
  const nodes = s.nodeOrder.map((id) => s.nodes[id])

  for (const n of nodes) {
    // Election Safety
    if (n.role === 'leader') {
      const prev = o.leadersByTerm[n.currentTerm]
      if (prev === undefined) o.leadersByTerm[n.currentTerm] = n.id
      else if (prev !== n.id) violate(s, 'Election Safety', `${prev} and ${n.id} were both leaders of term ${n.currentTerm}`)

      // Leader Append-Only
      const ll = o.leaderLast[n.id]
      if (ll && ll.term === n.currentTerm) {
        const t = termAt(n, ll.index)
        if (lastLogIndex(n) < ll.index || (t !== null && t !== ll.entryTerm))
          violate(s, 'Leader Append-Only', `leader ${n.id} lost or overwrote entry ${ll.index} during term ${n.currentTerm}`)
      }
      o.leaderLast[n.id] = { term: n.currentTerm, index: lastLogIndex(n), entryTerm: termAt(n, lastLogIndex(n)) ?? 0 }
    } else delete o.leaderLast[n.id]

    // record commits
    for (let i = n.snapshot.lastIndex + 1; i <= n.commitIndex; i++) {
      const t = termAt(n, i)
      if (t === null) continue
      const c = o.committed[i]
      if (!c) o.committed[i] = { term: t, inTerm: n.currentTerm }
      else if (c.term !== t) violate(s, 'State Machine Safety', `index ${i} committed with term ${c.term}, but ${n.id} considers term ${t} committed there`)
    }
  }

  // Leader Completeness
  for (const n of nodes) {
    if (n.role !== 'leader') continue
    for (const k of Object.keys(o.committed)) {
      const i = Number(k)
      const c = o.committed[i]
      if (n.currentTerm <= c.inTerm || i <= n.snapshot.lastIndex) continue
      const t = termAt(n, i)
      if (t !== c.term) violate(s, 'Leader Completeness', `leader ${n.id} (term ${n.currentTerm}) is missing entry ${i} (term ${c.term}) committed in term ${c.inTerm}`)
    }
  }

  // Log Matching
  for (let x = 0; x < nodes.length; x++)
    for (let y = x + 1; y < nodes.length; y++) {
      const a = nodes[x]
      const b = nodes[y]
      const lo = Math.max(a.snapshot.lastIndex, b.snapshot.lastIndex) + 1
      for (let i = Math.min(lastLogIndex(a), lastLogIndex(b)); i >= lo; i--) {
        const ta = termAt(a, i)
        if (ta === null || ta !== termAt(b, i)) continue
        for (let j = i - 1; j >= lo; j--)
          if (termAt(a, j) !== termAt(b, j)) {
            violate(s, 'Log Matching', `${a.id} and ${b.id} agree at index ${i} but differ at index ${j}`)
            break
          }
        break
      }
    }
}
