import { useSim } from '../store/simStore'

/** Scrubber over the checkpoints taken after every event (time travel). */
export function Timeline() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const view = useSim((x) => x.viewIndex)
  const playing = useSim((x) => x.playing)
  const beats = useSim((x) => x.beats)
  const viewTime = useSim((x) => x.viewTime)
  const h = st.sim.history
  const last = h.length - 1
  const idx = view ?? last
  const cur = h[idx]
  const first = h[0]
  const scenario = useSim((x) => x.scenario)
  const start = first?.now ?? 0
  const liveEnd = h[last]?.now ?? 0
  // in a scenario the bar spans the whole scenario (known from a dry run), so it fills up step by step
  const end = scenario ? Math.max(liveEnd, scenario.plan.end) : liveEnd
  const span = Math.max(1e-9, end - start)
  const pos = (t: number) => Math.max(0, Math.min(1, (t - start) / span))
  type Marker = { k: number; label: string; title: string; p: number; future: boolean }
  const markers: Marker[] = []
  if (scenario) {
    const n = scenario.sc.steps.length
    const label = (k: number) => (k === n ? 'end' : String(k + 1))
    const title = (k: number) => (k === n ? 'End of the scenario' : `Step ${k + 1}: ${scenario.sc.steps[k].title} (click to play it)`)
    // checkpoints already reached (only those still on the current timeline)
    scenario.states.forEach((snap, k) => {
      if (h.some((x) => x.eventCount === snap.eventCount && x.now === snap.now)) markers.push({ k, label: label(k), title: title(k), p: pos(snap.now), future: false })
    })
    // checkpoints still ahead, where the dry run put them
    const reached = scenario.states.length
    for (const f of scenario.plan.starts) if (f.k >= reached) markers.push({ k: f.k, label: label(f.k), title: title(f.k), p: pos(f.now), future: true })
    if (reached <= n) markers.push({ k: n, label: 'end', title: title(n), p: 1, future: true })
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--line)] px-4">
      <button
        className="btn btn-primary h-8 w-8 justify-center px-0"
        onClick={() => st.setPlaying(!playing)}
        title={view !== null ? (playing ? 'Pause replay' : 'Replay from here (space)') : playing ? 'Pause (space)' : 'Play (space)'}
      >
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
      <span className="label w-20">{beats ? 'Actions' : view !== null ? (playing ? 'Replaying' : 'Paused') : 'Timeline'}</span>
      <button className="btn btn-ghost h-7 px-2" disabled={idx <= 0} onClick={() => st.setView(Math.max(0, idx - 1))} title="Previous event (←)">
        ‹
      </button>
      <div className="relative flex flex-1 items-center">
        <input
          type="range"
          className="w-full"
          min={first?.now ?? 0}
          max={end}
          step="any"
          value={view !== null ? (viewTime ?? cur?.now ?? 0) : (h[last]?.now ?? 0)}
          onChange={(e) => st.setViewTime(Number(e.target.value))}
        />
        {markers.map((m) => (
          <button
            key={m.k}
            onClick={() => st.jumpToStep(m.k, m.k < (scenario?.sc.steps.length ?? 0))}
            title={m.title}
            className="group absolute -top-[13px] flex -translate-x-1/2 flex-col items-center"
            style={{ left: `calc(8px + ${m.p} * (100% - 16px))` }}
          >
            <span
              className={`mono rounded px-1 text-[9px] leading-[13px] group-hover:bg-[#7c9cff] group-hover:text-black ${m.future ? 'bg-[#262c38] text-[var(--text-faint)]' : 'bg-[#7c9cff]/20 text-[#c7d4ff]'}`}
            >
              {m.label}
            </span>
            <span className={`h-[9px] w-px ${m.future ? 'bg-[#3a4356]' : 'bg-[#7c9cff]/70'}`} />
          </button>
        ))}
      </div>
      <button className="btn btn-ghost h-7 px-2" disabled={view === null} onClick={() => st.stepOnce()} title="Next event (→)">
        ›
      </button>
      <span className="mono w-44 text-right text-[11px] text-[var(--text-dim)]">
        {`${((view !== null ? (viewTime ?? cur?.now ?? 0) : st.sim.s.now) / 1000).toFixed(3)}s`} · {first ? `${(start / 1000).toFixed(1)}–${(end / 1000).toFixed(1)}s` : ''}
      </span>
      {view !== null && !beats ? (
        <button className="btn btn-primary h-7" onClick={() => st.setView(null)}>
          Back to live
        </button>
      ) : (
        <span className="w-[92px] text-center text-[11px] text-emerald-300/80">● live</span>
      )}
    </div>
  )
}
