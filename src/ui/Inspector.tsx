import type { ReactNode } from 'react'
import { describeConfig, lastLogIndex, lastLogTerm, latestConfig } from '../sim/log'
import { fmt } from '../sim/trace'
import type { Message, RaftNode, SimState } from '../sim/types'
import { useSim, viewState } from '../store/simStore'
import { MSG_STYLE, ROLE_COLOR, ROLE_LABEL, termColor } from './theme'

export function Inspector() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const s = viewState(st)
  const selMsg = useSim((x) => x.selectedMsg)
  const selNode = useSim((x) => x.selectedNode)

  if (selMsg !== null) {
    const live = s.messages.find((m) => m.id === selMsg)
    const past = live ? undefined : st.sim.events.find((e) => e.msg?.id === selMsg)
    const m = live ?? past?.msg
    if (m) return <MessageInspector m={m} s={s} live={!!live} outcome={past?.kind === 'drop' ? 'lost' : past ? 'delivered' : undefined} />
  }
  if (selNode && s.nodes[selNode]) return <NodeInspector n={s.nodes[selNode]} s={s} />
  return (
    <div className="p-5 text-[var(--text-dim)]">
      <p className="mb-2">Click a server to see its full state, or click a moving message to open it.</p>
      <p className="text-[12px] text-[var(--text-faint)]">Tip: pause first — messages move fast.</p>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">{title}</span>
        {hint && <span className="text-[10.5px] text-[var(--text-faint)]">{hint}</span>}
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[#0f1218]">{children}</div>
    </div>
  )
}

function Row({ k, v, hint }: { k: string; v: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-3 py-1.5 last:border-b-0" title={hint}>
      <span className="mono text-[11.5px] text-[var(--text-dim)]">{k}</span>
      <span className="mono text-right text-[11.5px]">{v}</span>
    </div>
  )
}

function NodeInspector({ n, s }: { n: RaftNode; s: SimState }) {
  const cfg = latestConfig(n)
  const peers = Object.keys(n.nextIndex)
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold">{n.id}</span>
          <span className="chip" style={{ color: n.alive ? ROLE_COLOR[n.role] : '#6b7385' }}>
            {n.alive ? ROLE_LABEL[n.role] : 'crashed'}
          </span>
        </div>
        <span className="mono text-[11px] text-[var(--text-faint)]">t={s.now.toFixed(0)}ms</span>
      </div>

      <Section title="Persistent state" hint="survives crashes (on disk)">
        <Row k="currentTerm" v={<span style={{ color: termColor(n.currentTerm) }}>{n.currentTerm}</span>} hint="latest term this server has seen" />
        <Row k="votedFor" v={fmt(n.votedFor)} hint="candidate that received this server's vote in currentTerm" />
        <Row k="log" v={`${n.log.length} entries · last (${lastLogIndex(n)}, term ${lastLogTerm(n)})`} />
        <Row k="snapshot" v={n.snapshot.lastIndex ? `≤ ${n.snapshot.lastIndex} (term ${n.snapshot.lastTerm})` : 'none'} />
        <Row k="configuration" v={describeConfig(cfg)} hint="latest configuration in the log (used even if uncommitted)" />
      </Section>

      <Section title="Volatile state" hint="lost on crash">
        <Row k="commitIndex" v={n.commitIndex} hint="highest log entry known to be committed" />
        <Row k="lastApplied" v={n.lastApplied} hint="highest log entry applied to the state machine" />
        <Row k="leaderId" v={fmt(n.leaderId)} />
        {n.role !== 'leader' && n.alive && (
          <Row k="election timeout" v={Number.isFinite(n.electionDeadline) ? `${Math.max(0, n.electionDeadline - s.now).toFixed(0)} / ${n.electionTimeout} ms` : 'never'} />
        )}
        {(n.role === 'candidate' || n.role === 'precandidate') && <Row k="votes" v={`{${n.votesGranted.join(', ')}}`} />}
      </Section>

      {n.role === 'leader' && n.alive && (
        <Section title="Leader state" hint="reinitialized after election">
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr] px-3 py-1.5 text-[10.5px] text-[var(--text-faint)]">
            <span>server</span>
            <span className="text-right">nextIndex</span>
            <span className="text-right">matchIndex</span>
            <span className="text-right">last ack</span>
          </div>
          {peers.map((p) => (
            <div key={p} className="mono grid grid-cols-[1fr_1fr_1fr_1fr] border-t border-[var(--line)] px-3 py-1 text-[11.5px]">
              <span>
                {p}
                {n.learners.includes(p) ? <span className="text-[var(--text-faint)]"> (learner)</span> : ''}
              </span>
              <span className="text-right text-[#7c9cff]">{n.nextIndex[p]}</span>
              <span className="text-right text-[#34d399]">{n.matchIndex[p]}</span>
              <span className="text-right text-[var(--text-dim)]">{n.lastAck[p] !== undefined ? `${(s.now - n.lastAck[p]).toFixed(0)}ms ago` : '—'}</span>
            </div>
          ))}
          {n.pendingChange && <Row k="pending change" v={`${n.pendingChange.type} ${n.pendingChange.id}`} />}
          {n.transfer && <Row k="transfer" v={`→ ${n.transfer.target}`} />}
          {n.pendingReads.length > 0 && <Row k="pending reads" v={n.pendingReads.map((r) => `#${r.seq}@${fmt(r.readIndex)}`).join(' ')} />}
        </Section>
      )}

      <Section title="State machine" hint={`applied up to ${n.lastApplied}`}>
        {Object.keys(n.kv).length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-[var(--text-faint)]">empty</div>
        ) : (
          Object.entries(n.kv).map(([k, v]) => <Row key={k} k={k} v={v} />)
        )}
      </Section>
      {Object.keys(n.sessions).length > 0 && (
        <Section title="Client sessions" hint="§8 · deduplication">
          {Object.entries(n.sessions).map(([c, sess]) => (
            <Row key={c} k={c} v={`last seq ${sess.seq} → ${fmt(sess.result)}`} />
          ))}
        </Section>
      )}
    </div>
  )
}

const FIELD_HELP: Record<string, string> = {
  term: "sender's currentTerm",
  candidateId: 'candidate requesting the vote',
  lastLogIndex: "index of the candidate's last log entry",
  lastLogTerm: "term of the candidate's last log entry",
  voteGranted: 'true means the candidate received the vote',
  leaderId: 'so followers can redirect clients',
  prevLogIndex: 'index of the entry immediately preceding the new ones',
  prevLogTerm: 'term of the prevLogIndex entry',
  entries: 'log entries to store (empty for heartbeat)',
  leaderCommit: "leader's commitIndex",
  success: 'true if the follower had an entry matching prevLogIndex and prevLogTerm',
  matchIndex: 'last index known to match the leader',
  conflictIndex: 'fast backup: first index of the conflicting term (or log length)',
  conflictTerm: 'fast backup: term of the conflicting entry',
  rejectedPrev: 'prevLogIndex of the request being rejected',
  preVote: 'Pre-Vote round: no state changes on the receiver',
  transfer: 'election triggered by leadership transfer (ignores the disruption guard)',
  readSeq: 'ReadIndex round this heartbeat belongs to',
  sentAt: 'leader time when sent (for leases)',
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return v
      .map((e) => (typeof e === 'object' && e && 'index' in e ? `#${(e as { index: number }).index}(t${(e as { term: number }).term})` : JSON.stringify(e)))
      .join(' ')
  }
  if (typeof v === 'object' && v !== null) return JSON.stringify(v)
  return fmt(v)
}

function MessageInspector({ m, s, live, outcome }: { m: Message; s: SimState; live: boolean; outcome?: string }) {
  const style = MSG_STYLE[m.type]
  const body = m.body as unknown as Record<string, unknown>
  const st = useSim.getState()
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: style.color }} />
        <span className="text-[15px] font-bold">{style.label}</span>
      </div>
      <div className="mono mb-3 text-[12px] text-[var(--text-dim)]">
        {m.from} → {m.to} · #{m.id}
      </div>
      <div className="mb-4 rounded-lg border border-[var(--line)] bg-[#0f1218] p-3 text-[12.5px] leading-relaxed">
        <span className="label mr-2">why</span>
        {m.reason}
      </div>
      <Section title="Arguments" hint={m.type === 'AppendEntries' && (m.body.entries.length === 0) ? 'heartbeat' : undefined}>
        {Object.entries(body)
          .filter(([k]) => !(k === 'snapshot'))
          .map(([k, v]) => (
            <Row key={k} k={k} v={renderValue(v)} hint={FIELD_HELP[k]} />
          ))}
        {m.type === 'InstallSnapshot' && (
          <>
            <Row k="snapshot.lastIndex" v={m.body.snapshot.lastIndex} />
            <Row k="snapshot.lastTerm" v={m.body.snapshot.lastTerm} />
            <Row k="snapshot.state" v={JSON.stringify(m.body.snapshot.kv)} />
          </>
        )}
      </Section>
      <Section title="Network">
        <Row k="sent at" v={`${m.sendTime.toFixed(1)} ms`} />
        <Row k="arrives at" v={`${m.deliverTime.toFixed(1)} ms`} />
        <Row k="status" v={live ? (m.dropped ? <span className="text-[#f87171]">will be lost ({m.dropReason})</span> : `in flight (${Math.max(0, m.deliverTime - s.now).toFixed(0)} ms left)`) : outcome ?? 'done'} />
      </Section>
      {live && !m.dropped && (
        <button className="btn btn-danger w-full justify-center" onClick={() => st.act((sim) => sim.dropMessage(m.id))}>
          Drop this message
        </button>
      )}
    </div>
  )
}
