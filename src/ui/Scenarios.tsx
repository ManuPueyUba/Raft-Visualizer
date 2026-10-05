import { SCENARIOS } from '../scenarios/library'
import type { Scenario, ScenarioCategory } from '../scenarios/types'
import { VERSION_BY_ID } from '../scenarios/versions'
import { useSim } from '../store/simStore'

const CATEGORIES: ScenarioCategory[] = ['Elections', 'Replication', 'Safety', 'Membership', 'Clients & snapshots']

export function ScenarioPicker({ onClose }: { onClose: () => void }) {
  const st = useSim.getState()
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="panel max-h-[85vh] w-[760px] overflow-auto p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Guided scenarios</h2>
          <button className="btn btn-ghost h-7" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="mb-5 text-[12.5px] text-[var(--text-dim)]">
          Each scenario puts the cluster in an interesting situation and plays it step by step. Press <span className="kbd">Next</span> to advance; while a step plays, the pseudocode follows along.
        </p>
        {CATEGORIES.map((cat) => {
          const list = SCENARIOS.filter((s) => s.category === cat)
          if (!list.length) return null
          return (
            <div key={cat} className="mb-5">
              <div className="label mb-2">{cat}</div>
              <div className="grid grid-cols-2 gap-2">
                {list.map((sc) => (
                  <button
                    key={sc.id}
                    onClick={() => {
                      st.loadScenario(sc.id)
                      onClose()
                    }}
                    className="rounded-xl border border-[var(--line)] bg-[#0f1218] p-3 text-left transition-colors hover:border-[#7c9cff]/50 hover:bg-[#7c9cff]/[0.05]"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-semibold">{sc.title}</span>
                      <span className="chip shrink-0">{VERSION_BY_ID[sc.version].short}</span>
                    </div>
                    <div className="text-[12px] leading-relaxed text-[var(--text-dim)]">{sc.summary}</div>
                    <div className="mt-2 text-[10.5px] text-[var(--text-faint)]">
                      {sc.nodes} servers · {sc.steps.length} steps
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Floating narration card shown over the cluster while a scenario runs. */
export function ScenarioCard() {
  useSim((st) => st.frame)
  const run = useSim((x) => x.scenario)
  const beats = useSim((x) => x.beats)
  const st = useSim.getState()
  if (!run) return null
  const { sc, step } = run
  const cur = step >= 0 ? sc.steps[step] : null
  const playing = run.deadline !== null
  const last = step >= sc.steps.length - 1
  const reached = !playing && cur?.until ? cur.until(st.sim) : true
  const finished = last && step >= 0 && !playing && !beats

  const next = step + 1
  const steps = sc.steps.length

  return (
    <div className="panel absolute right-3 top-3 z-10 w-[340px] p-4 shadow-xl shadow-black/40">
      <div className="mb-1 label">{sc.category}</div>
      <div className="mb-3 text-[14px] font-semibold leading-snug">{sc.title}</div>
      {/* the step bar is the only navigation: click a segment to play that step.
          Alternatives (steps that rewind) get their own row, starting under their branch point. */}
      <div className="mb-3 flex flex-col gap-1.5">
        {layoutSteps(sc.steps).rows.map((row, r) => (
          <div key={r}>
            {row.label && (
              <div className="mb-0.5 text-[10px] text-[var(--text-faint)]" style={{ paddingLeft: `${(row.start / row.cols) * 100}%` }}>
                ↳ {row.label}
              </div>
            )}
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${row.cols}, minmax(0, 1fr))` }}>
              {row.start > 0 && (
                <span
                  className="mb-2.5 ml-[45%] rounded-bl-md border-b border-l border-dashed border-[#3a4356]"
                  style={{ gridColumn: `${row.start} / span 1`, gridRow: 1 }}
                />
              )}
              {row.items.map(({ i, col }) => {
                const s_ = sc.steps[i]
                const done = run.states.length > i + 1 && (i < step || (i === step && !playing))
                const isNext = i === next && !playing && !beats
                return (
                  <button key={i} onClick={() => st.jumpToStep(i, true)} title={`Play step ${i + 1}: ${s_.title}`} className="group" style={{ gridColumn: `${col + 1} / span 1`, gridRow: 1 }}>
                    <span
                      className={`mono flex h-5 items-center justify-center rounded-md text-[10px] font-semibold transition-colors ${
                        i === step && playing
                          ? 'bg-[#7c9cff]/45 text-white'
                          : done
                            ? 'bg-[#7c9cff] text-[#0b0d12]'
                            : isNext
                              ? 'animate-pulse bg-[#7c9cff]/25 text-[#c7d4ff] ring-1 ring-[#7c9cff]/70'
                              : 'bg-[#232935] text-[var(--text-faint)] group-hover:bg-[#2f3747] group-hover:text-[var(--text)]'
                      }`}
                    >
                      {i + 1}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {(() => {
        // at a pause the card already shows what comes next; while a step plays, that step
        const shown = finished ? step : playing || beats ? step : step + 1
        const st_ = shown >= 0 && step >= 0 ? sc.steps[shown] : null
        return (
          <>
            {st_ ? (
              <>
                <div className="mb-1 flex items-center gap-2 text-[12.5px] font-semibold text-[#c7d4ff]">
                  <span className="mono text-[10.5px] text-[var(--text-faint)]">
                    {shown + 1}/{steps}
                  </span>
                  {st_.title}
                  {playing && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-[#7c9cff]" />}
                </div>
                <p className="text-[12.5px] leading-relaxed text-[var(--text)]">{st_.text}</p>
              </>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-[var(--text)]">{sc.intro}</p>
            )}
            {cur && !playing && !beats && !reached && <p className="mt-2 text-[11px] text-amber-300/80">The last step ran out of time before reaching its goal; click its number to retry.</p>}
          </>
        )
      })()}
      {finished ? (
        <>
          <p className="mt-3 rounded-md bg-[#7c9cff]/10 px-2.5 py-2 text-[12px] text-[#c7d4ff]">End of the scenario. Keep simulating from this state: crash servers, send requests or change settings.</p>
          <button className="btn btn-primary mt-3 h-8 w-full justify-center" onClick={() => st.continueFromScenario()} title="Leave the guided mode and keep simulating from this state">
            Continue from here ▸
          </button>
        </>
      ) : (
        !playing &&
        !beats && (
          <button className="btn btn-primary mt-3 h-8 w-full justify-center" onClick={() => st.scenarioNext()} title="Play it (N)">
            {step < 0 ? 'Start ▸' : 'Continue ▸'}
          </button>
        )
      )}
    </div>
  )
}

interface StepRow {
  label?: string
  /** column where the row's first step sits (0 for the main line) */
  start: number
  cols: number
  items: { i: number; col: number }[]
}

/** Puts every step in a column; a step that rewinds starts a new row right after the step it rewinds to. */
function layoutSteps(steps: Scenario['steps']): { rows: StepRow[] } {
  const col: number[] = []
  const rows: StepRow[] = []
  steps.forEach((s, i) => {
    if (i === 0 || s.rewindTo !== undefined) {
      const start = s.rewindTo === undefined || s.rewindTo < 0 ? 0 : col[s.rewindTo] + 1
      rows.push({ label: i === 0 ? undefined : (s.branch ?? 'Alternative'), start, cols: 0, items: [] })
      col[i] = start
    } else col[i] = col[i - 1] + 1
    rows[rows.length - 1].items.push({ i, col: col[i] })
  })
  const cols = Math.max(...col) + 1
  for (const r of rows) r.cols = cols
  return { rows }
}
