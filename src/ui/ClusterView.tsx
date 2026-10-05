import { useState } from 'react'
import { isVoter, lastLogIndex, latestConfig, members } from '../sim/log'
import type { Message, NodeId, RaftNode, SimState } from '../sim/types'
import { CLIENT_ID } from '../sim/types'
import { BEAT_MS, BEAT_PRE_MS, beatPos, useSim, viewState } from '../store/simStore'
import { isReply, MSG_STYLE, ROLE_COLOR, ROLE_LABEL, termColor } from './theme'

const W = 920
const H = 520
const CX = W / 2
const CY = H / 2 - 4
const NODE_R = 31

function layout(ids: NodeId[]): Record<string, { x: number; y: number }> {
  const ry = ids.length <= 3 ? 150 : 180
  const rx = ids.length <= 3 ? 190 : ids.length <= 5 ? 270 : 320
  const pos: Record<string, { x: number; y: number }> = {}
  ids.forEach((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / ids.length
    pos[id] = { x: CX + rx * Math.cos(a), y: CY + ry * Math.sin(a) }
  })
  pos[CLIENT_ID] = { x: CX, y: CY }
  return pos
}

const arc = (x: number, y: number, r: number, frac: number) => {
  const f = Math.max(0, Math.min(0.9999, frac))
  const a0 = -Math.PI / 2
  const a1 = a0 + f * 2 * Math.PI
  const large = f > 0.5 ? 1 : 0
  return `M ${x + r * Math.cos(a0)} ${y + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${x + r * Math.cos(a1)} ${y + r * Math.sin(a1)}`
}

function isolatedSet(s: SimState): NodeId[] {
  return s.partition && s.partition.length > 1 ? s.partition[1] : []
}

export function ClusterView() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const s = viewState(st)
  const selectedNode = useSim((x) => x.selectedNode)
  const selectedMsg = useSim((x) => x.selectedMsg)
  const [menu, setMenu] = useState<NodeId | null>(null)
  const pos = layout(s.nodeOrder)
  const isolated = isolatedSet(s)
  const leader = s.nodeOrder.map((id) => s.nodes[id]).find((n) => n.alive && n.role === 'leader')
  const leaderCfg = leader ? latestConfig(leader) : null
  const showLinks = s.nodeOrder.length <= 9
  // scenario actions being shown one at a time
  const beats = useSim((x) => x.beats)
  const pos_ = beats ? beatPos(beats) : -1
  const beatEvent = beats && pos_ >= 0 ? st.sim.events.find((e) => e.id === st.sim.history[beats.list[pos_]]?.eventCount - 1) : undefined
  const beatCaption = beats ? (pos_ < 0 ? beats.preface : beatEvent?.title) : undefined
  const beatNodes = beatEvent ? beatTargets(beatEvent.title, beatEvent.nodeId, s.nodeOrder) : []

  const canTalk = (a: NodeId, b: NodeId) => {
    if (a === CLIENT_ID || b === CLIENT_ID) return true
    const k = a < b ? `${a}|${b}` : `${b}|${a}`
    if (s.blockedLinks.includes(k)) return false
    if (!s.partition) return true
    return s.partition.findIndex((g) => g.includes(a)) === s.partition.findIndex((g) => g.includes(b))
  }

  return (
    <div className="relative h-full w-full" onClick={() => setMenu(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full select-none">
        <defs>
          <radialGradient id="glow">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </radialGradient>
          <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#1b2029" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#dots)" />

        {/* links */}
        {showLinks &&
          s.nodeOrder.map((a, i) =>
            s.nodeOrder.slice(i + 1).map((b) => {
              const ok = canTalk(a, b)
              return (
                <line
                  key={a + b}
                  x1={pos[a].x}
                  y1={pos[a].y}
                  x2={pos[b].x}
                  y2={pos[b].y}
                  stroke={ok ? '#1d222c' : '#5b2a2f'}
                  strokeWidth={ok ? 1 : 1.2}
                  strokeDasharray={ok ? undefined : '4 5'}
                />
              )
            }),
          )}

        {/* client */}
        <ClientGlyph s={s} x={pos[CLIENT_ID].x} y={pos[CLIENT_ID].y} />

        {/* messages */}
        {s.messages.map((m) => (
          <MessageDot key={m.id} m={m} s={s} pos={pos} selected={selectedMsg === m.id} />
        ))}

        {/* highlight of the node an action just touched */}
        {beatNodes.map((id) =>
          pos[id] ? <circle key={`beat-${pos_}-${id}`} className="beat-ring" cx={pos[id].x} cy={pos[id].y} r={NODE_R + 14} fill="none" stroke="#7c9cff" strokeWidth={3} /> : null,
        )}

        {/* nodes */}
        {s.nodeOrder.map((id) => (
          <NodeGlyph
            key={id}
            n={s.nodes[id]}
            s={s}
            x={pos[id].x}
            y={pos[id].y}
            selected={selectedNode === id}
            isolated={isolated.includes(id)}
            learner={!!leaderCfg && !isVoter(leaderCfg, id) && (leader?.learners.includes(id) ?? false)}
            outOfConfig={!!leaderCfg && !members(leaderCfg).includes(id) && !(leader?.learners.includes(id) ?? false)}
            onClick={(e) => {
              e.stopPropagation()
              useSim.getState().selectNode(id)
              setMenu(menu === id ? null : id)
            }}
          />
        ))}
      </svg>

      {beatCaption && beats && (
        <div
          key={`${pos_}-${beatCaption}`}
          className="beat-caption absolute left-3 top-3 z-10 max-w-[45%] overflow-hidden rounded-lg border border-[#7c9cff]/40 bg-[#141a2b]/95 text-[12.5px] text-[#dfe6ff] shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 py-1.5 pl-3 pr-1.5">
            {pos_ >= 0 && (
              <span className="mono text-[10.5px] text-[#7c9cff]">
                {pos_ + 1}/{beats.list.length}
              </span>
            )}
            <span>{beatCaption}</span>
            {pos_ >= 0 && (
              <button className="btn btn-primary h-6 px-2.5 text-[11.5px]" onClick={() => useSim.getState().beatOk()} title="Next (or wait 5 s)">
                OK
              </button>
            )}
          </div>
          {pos_ >= 0 && (
            <div className="h-0.5 bg-[#7c9cff]/60" style={{ width: `${Math.max(0, 100 - ((beats.elapsed - BEAT_PRE_MS - pos_ * BEAT_MS) / BEAT_MS) * 100)}%` }} />
          )}
        </div>
      )}
      {menu && s.nodes[menu] && <NodeMenu id={menu} x={pos[menu].x / W} y={pos[menu].y / H} onClose={() => setMenu(null)} />}
      <Legend />
    </div>
  )
}

function NodeGlyph(props: {
  n: RaftNode
  s: SimState
  x: number
  y: number
  selected: boolean
  isolated: boolean
  learner: boolean
  outOfConfig: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const { n, s, x, y, selected, isolated, learner, outOfConfig } = props
  const color = n.alive ? ROLE_COLOR[n.role] : '#3b4252'
  const remaining = n.electionDeadline - s.now
  const timeoutFrac = n.alive && n.role !== 'leader' && Number.isFinite(n.electionDeadline) && n.electionTimeout > 0 ? remaining / n.electionTimeout : 0
  const hbFrac = n.alive && n.role === 'leader' ? (n.heartbeatDeadline - s.now) / s.settings.heartbeatInterval : 0
  const cfg = latestConfig(n)
  const votesNeeded = Math.floor(cfg.voters.length / 2) + 1
  const below = y > CY + 20
  // role line closest to the node, details line further out
  const ly = below ? y + NODE_R + 20 : y - NODE_R - 26
  const dy = 12

  return (
    <g onClick={props.onClick} style={{ cursor: 'pointer' }} opacity={n.alive ? 1 : 0.55}>
      {n.alive && n.role === 'leader' && <circle cx={x} cy={y} r={NODE_R + 34} fill="url(#glow)" />}
      {isolated && <circle cx={x} cy={y} r={NODE_R + 14} fill="none" stroke="#f87171" strokeOpacity={0.55} strokeDasharray="3 4" strokeWidth={1.5} />}
      {selected && <circle cx={x} cy={y} r={NODE_R + 10} fill="none" stroke="#7c9cff" strokeWidth={2} />}
      {/* timer ring */}
      <circle cx={x} cy={y} r={NODE_R + 5} fill="none" stroke="#1f2430" strokeWidth={3.5} />
      {timeoutFrac > 0 && <path d={arc(x, y, NODE_R + 5, timeoutFrac)} fill="none" stroke={color} strokeOpacity={0.8} strokeWidth={3.5} strokeLinecap="round" />}
      {hbFrac > 0 && <path d={arc(x, y, NODE_R + 5, hbFrac)} fill="none" stroke="#34d399" strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" />}
      {/* body */}
      <circle
        cx={x}
        cy={y}
        r={NODE_R}
        fill="#141821"
        stroke={color}
        strokeWidth={n.role === 'leader' ? 3 : 2}
        strokeDasharray={!n.alive || learner || outOfConfig ? '5 4' : undefined}
      />
      <text x={x} y={y - 3} textAnchor="middle" fontSize={16} fontWeight={700} fill={n.alive ? '#e6ebf3' : '#6b7385'} fontFamily="Inter">
        {n.id}
      </text>
      <text x={x} y={y + 13} textAnchor="middle" fontSize={10.5} fill={termColor(n.currentTerm)} fontFamily="JetBrains Mono" fontWeight={600}>
        term {n.currentTerm}
      </text>
      {!n.alive && (
        <g stroke="#f87171" strokeWidth={2.5} strokeLinecap="round">
          <line x1={x + 16} y1={y - 26} x2={x + 26} y2={y - 16} />
          <line x1={x + 26} y1={y - 26} x2={x + 16} y2={y - 16} />
        </g>
      )}
      {/* label */}
      <text x={x} y={below ? ly : ly + dy} textAnchor="middle" fontSize={10.5} fill={n.alive ? color : '#6b7385'} fontWeight={600} fontFamily="Inter">
        {!n.alive ? 'crashed' : learner ? 'learner' : outOfConfig ? 'removed' : ROLE_LABEL[n.role].toLowerCase()}
        {n.alive && (n.role === 'candidate' || n.role === 'precandidate') ? ` · ${n.votesGranted.length}/${votesNeeded} votes` : ''}
      </text>
      <text x={x} y={below ? ly + dy : ly} textAnchor="middle" fontSize={9.5} fill="#5f687a" fontFamily="JetBrains Mono">
        log {lastLogIndex(n)} · commit {n.commitIndex}
        {n.votedFor ? ` · voted ${n.votedFor}` : ''}
      </text>
    </g>
  )
}

function ClientGlyph({ s, x, y }: { s: SimState; x: number; y: number }) {
  const pending = s.client.ops.filter((o) => o.status === 'pending' || o.status === 'queued').length
  return (
    <g
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation()
        useSim.getState().setPanel('client')
      }}
    >
      <rect x={x - 26} y={y - 15} width={52} height={30} rx={8} fill="#16140c" stroke="#facc15" strokeOpacity={0.5} />
      <text x={x} y={y + 1} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#facc15" fontFamily="Inter">
        client
      </text>
      <text x={x} y={y + 11} textAnchor="middle" fontSize={8.5} fill="#a19560" fontFamily="JetBrains Mono">
        {pending ? `${pending} pending` : 'idle'}
      </text>
    </g>
  )
}

function MessageDot({ m, s, pos, selected }: { m: Message; s: SimState; pos: Record<string, { x: number; y: number }>; selected: boolean }) {
  const a = pos[m.from]
  const b = pos[m.to]
  if (!a || !b) return null
  const span = Math.max(1, m.deliverTime - m.sendTime)
  let p = (s.now - m.sendTime) / span
  p = Math.max(0, Math.min(1, p))
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // start/end at the node border, shift replies to the other side of the line
  const r0 = m.from === CLIENT_ID ? 26 : NODE_R + 6
  const r1 = m.to === CLIENT_ID ? 26 : NODE_R + 6
  const off = isReply(m.type) ? -5 : 5
  const nx = (-dy / len) * off
  const ny = (dx / len) * off
  const sx = a.x + (dx / len) * r0 + nx
  const sy = a.y + (dy / len) * r0 + ny
  const ex = b.x - (dx / len) * r1 + nx
  const ey = b.y - (dy / len) * r1 + ny
  const x = sx + (ex - sx) * p
  const y = sy + (ey - sy) * p
  const style = MSG_STYLE[m.type]
  const reply = isReply(m.type)
  const entries = m.type === 'AppendEntries' ? m.body.entries.length : 0
  const heartbeat = m.type === 'AppendEntries' && entries === 0
  const failed = (m.type === 'AppendEntriesReply' && !m.body.success) || (m.type === 'RequestVoteReply' && !m.body.voteGranted) || (m.type === 'ClientReply' && !m.body.ok)
  const r = heartbeat ? 4.5 : entries ? 7.5 : m.type === 'InstallSnapshot' ? 8 : 6
  const dropped = m.dropped
  const fade = dropped ? Math.max(0, 1 - Math.max(0, p - 0.45) / 0.25) : 1
  if (fade <= 0) return null
  const color = dropped ? '#f87171' : style.color

  return (
    <g
      style={{ cursor: 'pointer' }}
      opacity={fade}
      onClick={(e) => {
        e.stopPropagation()
        const st = useSim.getState()
        st.setPlaying(false)
        st.selectMsg(m.id)
      }}
    >
      <line x1={sx} y1={sy} x2={x} y2={y} stroke={color} strokeOpacity={0.18} strokeWidth={1.5} />
      {selected && <circle cx={x} cy={y} r={r + 6} fill="none" stroke="#7c9cff" strokeWidth={2} />}
      <circle cx={x} cy={y} r={r + 7} fill="transparent" />
      {reply ? (
        <circle cx={x} cy={y} r={r} fill="#0b0d12" stroke={color} strokeWidth={2} strokeDasharray={failed ? '2 2' : undefined} />
      ) : m.type === 'InstallSnapshot' ? (
        <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={2} fill={color} />
      ) : m.type === 'TimeoutNow' ? (
        <path d={`M ${x} ${y - r - 1} L ${x + r + 1} ${y} L ${x} ${y + r + 1} L ${x - r - 1} ${y} Z`} fill={color} />
      ) : (
        <circle cx={x} cy={y} r={r} fill={color} />
      )}
      {entries > 0 && (
        <text x={x} y={y + 3} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#0b0d12" fontFamily="JetBrains Mono">
          {entries}
        </text>
      )}
      {failed && !dropped && (
        <text x={x} y={y + 2.8} textAnchor="middle" fontSize={8} fontWeight={700} fill={color}>
          ✕
        </text>
      )}
    </g>
  )
}

function NodeMenu({ id, x, y, onClose }: { id: NodeId; x: number; y: number; onClose: () => void }) {
  const st = useSim.getState()
  const s = st.sim.s
  const n = s.nodes[id]
  if (!n) return null
  const isolated = isolatedSet(s).includes(id)
  const leader = st.sim.leader()
  const act = (fn: Parameters<typeof st.act>[0]) => {
    st.act(fn)
    onClose()
  }
  const toggleIsolate = () =>
    act((sim) => {
      const iso = isolatedSet(sim.s)
      const next = iso.includes(id) ? iso.filter((x) => x !== id) : [...iso, id]
      const rest = sim.s.nodeOrder.filter((x) => !next.includes(x))
      sim.setPartition(next.length && rest.length ? [rest, next] : null)
    })
  const inConfig = s.nodeOrder.some((x) => isVoter(latestConfig(s.nodes[x]), id))
  const items: { label: string; hint?: string; onClick: () => void; danger?: boolean; show: boolean }[] = [
    { label: 'Crash', hint: 'keeps term, vote, log', onClick: () => act((sim) => sim.crash(id)), danger: true, show: n.alive },
    { label: 'Restart', hint: 'as follower', onClick: () => act((sim) => sim.restart(id)), show: !n.alive },
    { label: 'Election timeout now', onClick: () => act((sim) => sim.forceTimeout(id)), show: n.alive && n.role !== 'leader' },
    { label: isolated ? 'Reconnect to network' : 'Isolate (partition)', onClick: toggleIsolate, show: true },
    {
      label: 'Client: send SET here',
      hint: 'redirects if not leader',
      onClick: () => act((sim) => sim.clientRequest({ op: 'set', key: 'x', value: String(sim.s.client.seq + 1) }, id)),
      show: true,
    },
    { label: 'Take snapshot', hint: '§7', onClick: () => act((sim) => sim.forceSnapshot(id)), show: n.alive && n.lastApplied > n.snapshot.lastIndex },
    { label: 'Transfer leadership here', hint: 'TimeoutNow', onClick: () => act((sim) => sim.transferLeadership(id)), show: !!leader && leader.id !== id && n.alive },
    { label: 'Remove from cluster', hint: '§6', onClick: () => act((sim) => sim.removeServer(id)), danger: true, show: inConfig },
    { label: 'Decommission', hint: 'drop from view', onClick: () => act((sim) => sim.forget(id)), show: !inConfig },
  ]
  return (
    <div
      className="panel absolute z-20 w-56 p-1.5 shadow-2xl shadow-black/60"
      style={{ left: `calc(${x * 100}% + 46px)`, top: `calc(${y * 100}% - 30px)` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <span className="font-semibold">{id}</span>
        <span className="text-[11px]" style={{ color: n.alive ? ROLE_COLOR[n.role] : '#6b7385' }}>
          {n.alive ? ROLE_LABEL[n.role] : 'crashed'}
        </span>
      </div>
      {items
        .filter((i) => i.show)
        .map((i) => (
          <button
            key={i.label}
            onClick={i.onClick}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-[#1f2533] ${i.danger ? 'text-[#f87171]' : ''}`}
          >
            <span>{i.label}</span>
            {i.hint && <span className="text-[10.5px] text-[var(--text-faint)]">{i.hint}</span>}
          </button>
        ))}
    </div>
  )
}

function Legend() {
  const items: [string, React.ReactNode][] = [
    ['RequestVote', <circle key="a" cx={6} cy={6} r={5} fill="#c084fc" />],
    ['AppendEntries', <circle key="b" cx={6} cy={6} r={5} fill="#60a5fa" />],
    ['heartbeat', <circle key="c" cx={6} cy={6} r={3.5} fill="#60a5fa" />],
    ['reply', <circle key="d" cx={6} cy={6} r={4.5} fill="none" stroke="#94a3b8" strokeWidth={1.8} />],
    ['snapshot', <rect key="e" x={1} y={1} width={10} height={10} rx={2} fill="#fb923c" />],
    ['client', <circle key="f" cx={6} cy={6} r={5} fill="#facc15" />],
    ['lost', <circle key="g" cx={6} cy={6} r={5} fill="#f87171" />],
  ]
  return (
    <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[var(--text-dim)]">
      {items.map(([label, icon]) => (
        <span key={label} className="flex items-center gap-1">
          <svg width={12} height={12}>
            {icon}
          </svg>
          {label}
        </span>
      ))}
    </div>
  )
}

/** Servers an action refers to: its node plus any server named in its title. */
function beatTargets(title: string, nodeId: NodeId | null, ids: NodeId[]): NodeId[] {
  const named = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(title))
  if (nodeId && !named.includes(nodeId)) named.unshift(nodeId)
  // a partition names every server: highlight the smaller side only
  if (title.startsWith('Network partitioned')) {
    const groups = [...title.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(','))
    groups.sort((a, b) => a.length - b.length)
    return groups[0] ?? []
  }
  return title.startsWith('Network healed') ? [] : named
}
