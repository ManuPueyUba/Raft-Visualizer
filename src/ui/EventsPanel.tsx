import { useState } from 'react'
import type { SimEvent } from '../sim/types'
import { useSim } from '../store/simStore'
import { MSG_STYLE } from './theme'

const KIND_COLOR: Record<SimEvent['kind'], string> = {
  deliver: '#60a5fa',
  drop: '#f87171',
  timer: '#fbbf24',
  action: '#7c9cff',
  client: '#facc15',
}

export function EventsPanel() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const selected = useSim((x) => x.selectedEvent)
  const [filter, setFilter] = useState<'all' | 'node' | 'important'>('all')
  const [hideHeartbeats, setHideHeartbeats] = useState(true)
  const upTo = st.viewIndex !== null ? (st.sim.history[st.viewIndex]?.eventCount ?? Infinity) : Infinity

  let evs = st.sim.events.filter((e) => e.id < upTo)
  if (hideHeartbeats) evs = evs.filter((e) => !isHeartbeat(e))
  if (filter === 'node' && st.selectedNode) evs = evs.filter((e) => e.nodeId === st.selectedNode || e.msg?.from === st.selectedNode)
  if (filter === 'important') evs = evs.filter((e) => e.kind === 'action' || e.kind === 'timer' || e.trace.some((t) => t.kind === 'set' && /state|commitIndex|log/.test(t.text ?? '')))
  const shown = evs.slice(-300).reverse()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1">
        {(['all', 'important', 'node'] as const).map((f) => (
          <button key={f} className={`tab text-[11.5px] ${filter === f ? 'tab-active' : ''}`} onClick={() => setFilter(f)} disabled={f === 'node' && !st.selectedNode}>
            {f === 'node' ? (st.selectedNode ? `only ${st.selectedNode}` : 'by server') : f}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-[var(--text-dim)]">
          <input type="checkbox" checked={hideHeartbeats} onChange={(e) => setHideHeartbeats(e.target.checked)} />
          hide heartbeats
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {shown.map((e) => (
          <button
            key={e.id}
            onClick={() => {
              st.selectEvent(e.id)
              st.setPanel('code')
            }}
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#1a1f2a] ${selected === e.id ? 'bg-[#7c9cff]/15' : ''}`}
          >
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.msg ? MSG_STYLE[e.msg.type].color : KIND_COLOR[e.kind] }} />
            <span className="mono w-14 shrink-0 pt-[1px] text-[10.5px] text-[var(--text-faint)]">{e.time.toFixed(0)}ms</span>
            <span className={`text-[12px] ${e.kind === 'drop' ? 'text-[#f87171]/80' : e.kind === 'action' ? 'text-[#c7d4ff]' : ''}`}>{e.title}</span>
          </button>
        ))}
        {shown.length === 0 && <div className="p-4 text-[var(--text-faint)]">No events.</div>}
      </div>
    </div>
  )
}

function isHeartbeat(e: SimEvent) {
  if (!e.msg) return e.title.endsWith('heartbeat timer')
  if (e.msg.type === 'AppendEntries') return e.msg.body.entries.length === 0 && !e.trace.some((t) => t.kind === 'set' && /commitIndex|state|currentTerm/.test(t.text ?? ''))
  if (e.msg.type === 'AppendEntriesReply') return e.msg.body.success && !e.trace.some((t) => t.kind === 'set' && /commitIndex|state/.test(t.text ?? ''))
  return false
}
