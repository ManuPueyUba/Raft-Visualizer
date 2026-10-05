import { useState } from 'react'
import { BASE_SPEED, useSim } from '../store/simStore'
import { VERSION_BY_ID, VERSIONS, type VersionId } from '../scenarios/versions'


export function TopBar({ onScenarios }: { onScenarios: () => void }) {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const playing = useSim((x) => x.playing)
  const version = useSim((x) => x.version)
  const scenario = useSim((x) => x.scenario)
  const leader = st.sim.leader()
  const violations = st.sim.s.oracle.violations.length

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4">
      <div className="flex items-center gap-2 pr-2">
        <svg width="22" height="22" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="13" fill="none" stroke="#34d399" strokeWidth="3" />
          <circle cx="16" cy="16" r="5" fill="#34d399" />
        </svg>
        <span className="text-[15px] font-semibold tracking-tight">Raft Visualizer</span>
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1">
        <button className="btn btn-ghost h-7 w-8 justify-center px-0" onClick={() => st.setPlaying(!playing)} title="Play / pause (space)">
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="1" width="3" height="10" rx="1" />
              <rect x="7" y="1" width="3" height="10" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 1.5v9l7.5-4.5z" />
            </svg>
          )}
        </button>
        <div className="mx-1 h-5 w-px bg-[var(--line)]" />
        <SpeedControl />
      </div>

      <select
        value={version}
        onChange={(e) => st.setVersion(e.target.value as VersionId)}
        className="h-9 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2 text-[12.5px] font-medium"
        title={VERSION_BY_ID[version].adds}
        disabled={!!scenario}
      >
        {VERSIONS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>

      <button className="btn h-9" onClick={onScenarios}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 2.5h7l3 3v8H3z" />
          <path d="M5.5 7.5h5M5.5 10h5" />
        </svg>
        Guided scenarios
      </button>

      <div className="ml-auto flex items-center gap-3 text-[12px]">
        <span className="mono text-[var(--text-dim)]">t = {(st.sim.s.now / 1000).toFixed(2)}s</span>
        <span className="chip">{leader ? `leader ${leader.id} · term ${leader.currentTerm}` : 'no leader'}</span>
        <button
          className={`chip ${violations ? '!border-rose-400/50 !text-rose-300' : '!text-emerald-300'}`}
          onClick={() => st.setPanel('settings')}
          title="Safety properties of Figure 3"
        >
          {violations ? `⚠ ${violations} safety violation${violations > 1 ? 's' : ''}` : '✓ safe'}
        </button>
        {!scenario && (
          <button className="btn h-8" onClick={() => st.reset()} title="Restart with the same seed">
            Reset
          </button>
        )}
        <div className="h-5 w-px bg-[var(--line)]" />
        <a
          href="https://pdos.csail.mit.edu/6.824/papers/raft-extended.pdf"
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost h-8 px-2 text-[12px]"
          title="In Search of an Understandable Consensus Algorithm (Extended Version) — Ongaro & Ousterhout"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 1.5h5.5L13 5v9.5H4z" />
            <path d="M9.5 1.5V5H13" />
          </svg>
          Paper
        </a>
        <a href="https://github.com/ManuPueyUba" target="_blank" rel="noreferrer" className="btn btn-ghost h-8 w-8 justify-center px-0" title="ManuPueyUba on GitHub">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </div>
    </header>
  )
}

/** Speed as a multiplier of the default pace: the slider goes ×0–×2 (×1 in the middle), the box accepts any value. */
function SpeedControl() {
  const speed = useSim((x) => x.speed)
  const setSpeed = useSim((x) => x.setSpeed)
  const mult = speed / BASE_SPEED
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft.replace(/^\s*[x×]/i, '').replace(',', '.'))
    if (Number.isFinite(v) && v >= 0) setSpeed(Math.min(v, 20) * BASE_SPEED)
    setDraft(null)
  }
  return (
    <div className="flex items-center gap-2 px-1" title="Simulation speed (×1 = default pace)">
      <span className="text-[11px] text-[var(--text-faint)]">speed</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={Math.min(2, mult)}
        onChange={(e) => setSpeed(Number(e.target.value) * BASE_SPEED)}
        onDoubleClick={() => setSpeed(BASE_SPEED)}
        className="w-28"
      />
      <input
        value={draft ?? `×${+mult.toFixed(2)}`}
        onFocus={(e) => {
          setDraft(String(+mult.toFixed(2)))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="mono h-7 w-14 rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-1.5 text-center text-[11.5px]"
      />
    </div>
  )
}
