import type { ReactNode } from 'react'
import { PROPERTIES } from '../sim/invariants'
import type { ReadMode, Settings } from '../sim/types'
import { useSim } from '../store/simStore'
import { VERSION_BY_ID } from '../scenarios/versions'

export function SettingsPanel() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const s = st.sim.s
  const set = (patch: Partial<Settings>) => st.act((sim) => sim.updateSettings(patch))
  const st8 = s.settings

  return (
    <div className="h-full overflow-auto p-4">
      <Safety />

      <Group title="Cluster" hint="restarts the simulation">
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="w-20 text-[12px] text-[var(--text-dim)]">Servers</span>
          <div className="flex gap-1">
            {[3, 4, 5, 6, 7].map((k) => (
              <button key={k} className={`btn h-7 w-8 justify-center px-0 ${st.nodeCount === k ? 'btn-primary' : ''}`} onClick={() => st.reset({ nodes: k })}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-[var(--line)] px-3 py-2">
          <span className="w-20 text-[12px] text-[var(--text-dim)]">Seed</span>
          <input
            type="number"
            value={st.seed}
            onChange={(e) => st.reset({ seed: Number(e.target.value) || 1 })}
            className="mono w-24 rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-2 py-1"
          />
          <button className="btn h-7" onClick={() => st.reset({ seed: 1 + Math.floor(Math.random() * 9999) })}>
            Random
          </button>
        </div>
        <div className="flex items-center gap-3 border-t border-[var(--line)] px-3 py-2">
          <button className="btn h-7" onClick={() => st.act((sim) => sim.addServer())}>
            + Add server (§6)
          </button>
          <span className="text-[11px] text-[var(--text-faint)]">joins as a learner, then joint consensus</span>
        </div>
      </Group>

      <Group title="Timing & network">
        <Slider label="Election timeout min" value={st8.electionTimeoutMin} min={150} max={1000} step={10} unit="ms" onChange={(v) => set({ electionTimeoutMin: v, electionTimeoutMax: Math.max(v + 50, st8.electionTimeoutMax) })} />
        <Slider label="Election timeout max" value={st8.electionTimeoutMax} min={200} max={1500} step={10} unit="ms" onChange={(v) => set({ electionTimeoutMax: Math.max(v, st8.electionTimeoutMin + 10) })} />
        <Slider label="Heartbeat interval" value={st8.heartbeatInterval} min={30} max={400} step={10} unit="ms" onChange={(v) => set({ heartbeatInterval: v })} />
        <Slider label="Latency min" value={st8.latencyMin} min={5} max={300} step={5} unit="ms" onChange={(v) => set({ latencyMin: v, latencyMax: Math.max(v, st8.latencyMax) })} />
        <Slider label="Latency max" value={st8.latencyMax} min={5} max={400} step={5} unit="ms" onChange={(v) => set({ latencyMax: Math.max(v, st8.latencyMin) })} />
        <Slider label="Message loss" value={Math.round(st8.dropRate * 100)} min={0} max={50} step={1} unit="%" onChange={(v) => set({ dropRate: v / 100 })} />
        {s.partition && (
          <div className="border-t border-[var(--line)] px-3 py-2">
            <button className="btn h-7" onClick={() => st.act((sim) => sim.setPartition(null))}>
              Heal network partition
            </button>
          </div>
        )}
      </Group>

      <Group title="Protocol" hint={`preset: ${VERSION_BY_ID[st.version].short}`}>
        <Toggle label="No-op on election" hint="§8 · lets a new leader commit entries from older terms" value={st8.noopOnElection} onChange={(v) => set({ noopOnElection: v })} />
        <Toggle label="Fast log backup" hint="§5.3 · conflictTerm / conflictIndex" value={st8.fastBackup} onChange={(v) => set({ fastBackup: v })} />
        <Toggle label="Pre-Vote" hint="thesis §9.6" value={st8.preVote} onChange={(v) => set({ preVote: v })} />
        <Toggle label="CheckQuorum" hint="thesis §6.2" value={st8.checkQuorum} onChange={(v) => set({ checkQuorum: v })} />
        <Toggle label="Disruption guard" hint="§6 · ignore RequestVote while a leader is alive" value={st8.disruptionGuard} onChange={(v) => set({ disruptionGuard: v })} />
        <Toggle label="Replicate immediately" hint="otherwise wait for the next heartbeat" value={st8.replicateImmediately} onChange={(v) => set({ replicateImmediately: v })} />
        <Slider label="Batch size" value={st8.batchSize} min={1} max={20} step={1} unit=" entries" onChange={(v) => set({ batchSize: v })} />
        <Slider label="Snapshot every" value={st8.snapshotThreshold} min={0} max={30} step={1} unit=" entries" zero="never" onChange={(v) => set({ snapshotThreshold: v })} />
        <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2">
          <span className="text-[12px]">Read-only queries</span>
          <select value={st8.readMode} onChange={(e) => set({ readMode: e.target.value as ReadMode })} className="rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-2 py-1 text-[12px]">
            <option value="log">through the log</option>
            <option value="readIndex">ReadIndex</option>
            <option value="lease">leader lease</option>
          </select>
        </div>
      </Group>

      <Group title="Break Raft on purpose" hint="watch the safety checker">
        <Toggle label="No election restriction" hint="vote for any candidate, even with a stale log" value={st8.unsafeNoElectionRestriction} danger onChange={(v) => set({ unsafeNoElectionRestriction: v })} />
        <Toggle label="Commit old-term entries by counting" hint="the Figure 8 bug" value={st8.unsafeCommitOldTerms} danger onChange={(v) => set({ unsafeCommitOldTerms: v })} />
      </Group>
    </div>
  )
}

export function Safety() {
  useSim((st) => st.frame)
  const v = useSim.getState().sim.s.oracle.violations
  return (
    <Group title="Safety properties" hint="Figure 3 · checked after every event">
      {PROPERTIES.map((p) => {
        const bad = v.filter((x) => x.property === p.id)
        return (
          <div key={p.id} className="border-b border-[var(--line)] px-3 py-2 last:border-b-0" title={p.text}>
            <div className="flex items-center justify-between">
              <span className="text-[12px]">{p.id}</span>
              {bad.length ? <span className="chip !border-rose-400/40 !text-rose-300">violated</span> : <span className="chip !border-emerald-400/30 !text-emerald-300">holds</span>}
            </div>
            {bad.slice(0, 2).map((b, i) => (
              <div key={i} className="mono mt-1 text-[10.5px] text-rose-300/80">
                t={b.time.toFixed(0)}: {b.detail}
              </div>
            ))}
          </div>
        )
      })}
    </Group>
  )
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
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

function Toggle({ label, hint, value, onChange, danger }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <button onClick={() => onChange(!value)} className="flex w-full items-center justify-between gap-3 border-b border-[var(--line)] px-3 py-2 text-left last:border-b-0">
      <span>
        <span className={`block text-[12px] ${danger && value ? 'text-rose-300' : ''}`}>{label}</span>
        {hint && <span className="block text-[10.5px] text-[var(--text-faint)]">{hint}</span>}
      </span>
      <span className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${value ? (danger ? 'bg-rose-400' : 'bg-[#7c9cff]') : 'bg-[#2a3140]'}`}>
        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${value ? 'left-[16px]' : 'left-[2px]'}`} />
      </span>
    </button>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit: string; zero?: string; onChange: (v: number) => void }) {
  return (
    <div className="border-b border-[var(--line)] px-3 py-2 last:border-b-0">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <span>{props.label}</span>
        <span className="mono text-[11px] text-[var(--text-dim)]">{props.value === 0 && props.zero ? props.zero : `${props.value}${props.unit}`}</span>
      </div>
      <input type="range" className="w-full" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </div>
  )
}
