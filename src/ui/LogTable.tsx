import { describeConfig, lastLogIndex } from '../sim/log'
import type { LogEntry, RaftNode } from '../sim/types'
import { useSim, viewState } from '../store/simStore'
import { ROLE_COLOR, termColor } from './theme'

const MAX_COLS = 28

function entryLabel(e: LogEntry): string {
  if (e.kind === 'noop') return 'no-op'
  if (e.kind === 'config') return e.config?.newVoters ? 'C old,new' : 'C new'
  const c = e.command!
  return c.op === 'set' ? `${c.key}=${c.value}` : `get ${c.key}`
}

function entryTitle(e: LogEntry): string {
  const base = `#${e.index} · term ${e.term}\n`
  if (e.kind === 'config') return base + describeConfig(e.config!)
  if (e.kind === 'noop') return base + 'no-op (appended when a leader takes office)'
  return base + entryLabel(e) + (e.clientId ? `\nclient seq ${e.seq}` : '')
}

export function LogTable() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const s = viewState(st)
  const selectedNode = useSim((x) => x.selectedNode)
  const nodes = s.nodeOrder.map((id) => s.nodes[id])
  const leader = nodes.find((n) => n.alive && n.role === 'leader')
  const maxIdx = Math.max(1, ...nodes.map(lastLogIndex))
  const first = Math.max(1, maxIdx - MAX_COLS + 1)
  const cols = Array.from({ length: maxIdx - first + 1 }, (_, i) => first + i)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="label">Logs</span>
        <div className="flex items-center gap-3 text-[10.5px] text-[var(--text-dim)]">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-sm border border-white/70" /> committed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-sm border border-dashed border-white/40" /> uncommitted
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[#34d399]">▾</span> leader's matchIndex
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[#7c9cff]">▸</span> nextIndex
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        <table className="border-separate border-spacing-[3px]">
          <thead>
            <tr>
              <th className="w-24" />
              {cols.map((i) => (
                <th key={i} className="mono min-w-[42px] text-[10px] font-normal text-[var(--text-faint)]">
                  {i}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <Row key={n.id} n={n} cols={cols} leader={leader} selected={selectedNode === n.id} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row({ n, cols, leader, selected }: { n: RaftNode; cols: number[]; leader?: RaftNode; selected: boolean }) {
  const isLeader = leader?.id === n.id
  const match = leader && !isLeader ? leader.matchIndex[n.id] : undefined
  const next = leader && !isLeader ? leader.nextIndex[n.id] : undefined
  return (
    <tr className={selected ? 'bg-[#7c9cff]/[0.06]' : undefined}>
      <td className="pr-2">
        <button onClick={() => useSim.getState().selectNode(n.id)} className="flex items-center gap-2 text-left">
          <span className="h-2 w-2 rounded-full" style={{ background: n.alive ? ROLE_COLOR[n.role] : '#3b4252' }} />
          <span className={`font-semibold ${n.alive ? '' : 'text-[var(--text-faint)] line-through'}`}>{n.id}</span>
          <span className="mono text-[10px] text-[var(--text-faint)]">T{n.currentTerm}</span>
        </button>
      </td>
      {cols.map((i) => {
        const inSnap = i <= n.snapshot.lastIndex
        const e = inSnap ? undefined : n.log[i - n.snapshot.lastIndex - 1]
        const committed = i <= n.commitIndex
        const applied = i <= n.lastApplied
        const marks = (
          <>
            {match === i && <span className="absolute -top-[9px] left-1/2 -translate-x-1/2 text-[9px] leading-none text-[#34d399]">▾</span>}
            {next === i && <span className="absolute -left-[7px] top-1/2 -translate-y-1/2 text-[9px] leading-none text-[#7c9cff]">▸</span>}
          </>
        )
        if (inSnap)
          return (
            <td key={i} className="relative">
              {marks}
              <div
                title={`compacted into snapshot (up to index ${n.snapshot.lastIndex}, term ${n.snapshot.lastTerm})`}
                className="mono flex h-[30px] items-center justify-center rounded-md border border-[#2f3646] bg-[repeating-linear-gradient(135deg,#1a1f2a_0_4px,#141821_4px_8px)] text-[9px] text-[var(--text-faint)]"
              >
                {i === n.snapshot.lastIndex ? 'snap' : ''}
              </div>
            </td>
          )
        if (!e)
          return (
            <td key={i} className="relative">
              {marks}
              <div className="h-[30px] rounded-md border border-dashed border-[#1f2430]" />
            </td>
          )
        return (
          <td key={i} className="relative">
            {marks}
            <div
              title={entryTitle(e) + (committed ? '\ncommitted' : '\nnot committed') + (applied ? ', applied' : '')}
              className="mono flex h-[30px] flex-col items-center justify-center rounded-md px-1 leading-tight"
              style={{
                background: termColor(e.term, committed ? 0.22 : 0.08),
                border: `1px ${committed ? 'solid' : 'dashed'} ${termColor(e.term, committed ? 0.85 : 0.5)}`,
                opacity: n.alive ? 1 : 0.6,
              }}
            >
              <span className="text-[10px] font-semibold" style={{ color: termColor(e.term) }}>
                {e.term}
              </span>
              <span className="max-w-[52px] truncate text-[8.5px] text-[var(--text-dim)]">{entryLabel(e)}</span>
            </div>
          </td>
        )
      })}
    </tr>
  )
}
