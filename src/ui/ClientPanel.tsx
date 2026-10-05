import { useState } from 'react'
import type { Command } from '../sim/types'
import { useSim, viewState } from '../store/simStore'
import { ROLE_COLOR } from './theme'

const STATUS_STYLE: Record<string, string> = {
  queued: 'text-[var(--text-faint)]',
  pending: 'text-amber-300',
  ok: 'text-emerald-300',
  failed: 'text-rose-300',
}

export function ClientPanel() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const s = viewState(st)
  const [key, setKey] = useState('x')
  const [value, setValue] = useState('1')
  const [target, setTarget] = useState<string | null>(null)
  const validTarget = target && s.nodes[target] ? target : null
  const send = (command: Command) => st.act((sim) => sim.clientRequest(command, validTarget ?? undefined))
  const c = s.client

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-dim)]">
        The client talks to a key-value store replicated with Raft. It sends each command with a unique (clientId, seq) so retries are never applied twice (§8). If it reaches a follower, it is redirected to the leader.
      </p>
      <div className="mb-3">
        <div className="label mb-1.5">Send to</div>
        <div className="flex flex-wrap gap-1">
          <button
            className={`btn h-7 text-[11.5px] ${validTarget === null ? 'btn-primary' : ''}`}
            onClick={() => setTarget(null)}
            title="The client's own choice: its guess of the leader, or a random server"
          >
            auto{c.leaderGuess ? ` (${c.leaderGuess})` : ''}
          </button>
          {s.nodeOrder.map((id) => {
            const n = s.nodes[id]
            return (
              <button
                key={id}
                className={`btn h-7 text-[11.5px] ${validTarget === id ? 'btn-primary' : ''}`}
                onClick={() => setTarget(id)}
                title={n.alive ? `${id} is ${n.role}` : `${id} is down: the request will be lost and retried after the timeout`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.alive ? ROLE_COLOR[n.role] : '#3b4252' }} />
                {id}
              </button>
            )
          })}
        </div>
        {validTarget && (
          <div className="mt-1.5 text-[11px] text-[var(--text-faint)]">
            Only the first attempt goes to {validTarget}; if it is not the leader, the client follows the redirect.
          </div>
        )}
      </div>
      <div className="mb-2 flex items-center gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} className="mono w-16 rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-2 py-1.5" placeholder="key" />
        <span className="text-[var(--text-faint)]">=</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} className="mono w-20 rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-2 py-1.5" placeholder="value" />
        <button className="btn btn-primary" onClick={() => send({ op: 'set', key: key || 'x', value: value || '1' })}>
          SET
        </button>
        <button className="btn" onClick={() => send({ op: 'get', key: key || 'x' })}>
          GET
        </button>
      </div>
      <label className="mb-4 flex items-center gap-2 text-[12px] text-[var(--text-dim)]">
        <input
          type="checkbox"
          checked={s.settings.autoClientInterval > 0}
          onChange={(e) => st.act((sim) => sim.updateSettings({ autoClientInterval: e.target.checked ? 400 : 0 }))}
        />
        Automatic writes every 400 ms
      </label>

      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">Requests</span>
        <span className="mono text-[10.5px] text-[var(--text-faint)]">leader guess: {c.leaderGuess ?? '—'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--line)] bg-[#0f1218]">
        {c.ops.length === 0 && <div className="p-3 text-[12px] text-[var(--text-faint)]">No requests yet.</div>}
        {[...c.ops].reverse().map((o) => (
          <div key={o.seq} className="mono flex items-center gap-3 border-b border-[var(--line)] px-3 py-1.5 text-[11.5px] last:border-b-0">
            <span className="w-8 text-[var(--text-faint)]">#{o.seq}</span>
            <span className="flex-1">{o.command.op === 'set' ? `SET ${o.command.key}=${o.command.value}` : `GET ${o.command.key}`}</span>
            <span className="text-[var(--text-faint)]">
              {o.sentTo ? `→ ${o.sentTo}` : o.target ? `→ ${o.target}` : ''}
              {o.attempts > 1 ? ` · ${o.attempts} tries` : ''}
            </span>
            <span className={STATUS_STYLE[o.status]}>
              {o.status}
              {o.status === 'ok' && o.command.op === 'get' ? ` = ${o.result ?? 'null'}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
