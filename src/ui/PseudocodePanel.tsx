import { useState } from 'react'
import { LINE_PROC, PROC_BY_ID, PROCEDURES } from '../sim/pseudocode'
import type { TraceStep } from '../sim/types'
import { focusEvent, useSim } from '../store/simStore'

export function PseudocodePanel() {
  useSim((st) => st.frame)
  const st = useSim.getState()
  const pinned = useSim((x) => x.pinnedProc)
  const ev = focusEvent(st)
  const [explain, setExplain] = useState(false)
  // the line-by-line cursor belongs to one event and resets when the event changes
  const [cur, setCur] = useState<{ ev: number; i: number } | null>(null)
  const cursor = cur && cur.ev === ev?.id ? cur.i : null
  const setCursor = (i: number | null) => setCur(i === null || !ev ? null : { ev: ev.id, i })

  const trace = ev?.trace ?? []
  const touched: string[] = []
  for (const t of trace) {
    const p = LINE_PROC[t.line]
    if (p && !touched.includes(p)) touched.push(p)
  }
  const run = st.scenario
  const scenarioFocus = run && run.step >= 0 ? run.sc.steps[run.step]?.focus : undefined
  const cursorProc = cursor !== null && trace[cursor] ? LINE_PROC[trace[cursor].line] : undefined
  const procId = cursorProc ?? pinned ?? touched[0] ?? scenarioFocus ?? 'timeout'
  const proc = PROC_BY_ID[procId]
  const visible = cursor === null ? trace : trace.slice(0, cursor + 1)

  const byLine = new Map<string, { order: number; steps: TraceStep[] }>()
  visible.forEach((t, i) => {
    const cur = byLine.get(t.line)
    if (cur) cur.steps.push(t)
    else byLine.set(t.line, { order: i, steps: [t] })
  })
  const currentLine = cursor !== null ? trace[cursor]?.line : undefined
  const ordered = [...byLine.entries()].sort((a, b) => a[1].order - b[1].order).map(([k]) => k)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* event header */}
      <div className="border-b border-[var(--line)] px-4 pb-3 pt-1">
        {ev ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="mono text-[10.5px] text-[var(--text-faint)]">
                event #{ev.id} · t={ev.time.toFixed(1)}ms
              </span>
              {trace.length > 0 && (
                <div className="flex items-center gap-1">
                  <button className="btn btn-ghost h-6 px-1.5 text-[11px]" disabled={cursor === 0} onClick={() => setCursor(cursor === null ? 0 : Math.max(0, cursor - 1))}>
                    ‹
                  </button>
                  <span className="mono w-14 text-center text-[10.5px] text-[var(--text-dim)]">{cursor === null ? `${trace.length} steps` : `${cursor + 1}/${trace.length}`}</span>
                  <button
                    className="btn btn-ghost h-6 px-1.5 text-[11px]"
                    onClick={() => setCursor(cursor === null ? 0 : cursor + 1 >= trace.length ? null : cursor + 1)}
                    title="Walk through the execution one line at a time"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
            <div className="mt-0.5 font-medium">{ev.title}</div>
            {touched.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {touched.map((p, i) => (
                  <span key={p} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[var(--text-faint)]">→</span>}
                    <button
                      onClick={() => st.pinProc(p === procId && pinned ? null : p)}
                      className={`chip ${p === procId ? '!border-[#7c9cff]/60 !text-[#c7d4ff]' : ''}`}
                    >
                      {PROC_BY_ID[p]?.title ?? p}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="text-[var(--text-dim)]">No event yet. Press play or step.</div>
        )}
      </div>

      {/* procedure */}
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <select
          value={procId}
          onChange={(e) => st.pinProc(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-[var(--line-2)] bg-[var(--panel-2)] px-2 py-1 text-[12.5px] font-semibold"
        >
          {PROCEDURES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
              {touched.includes(p.id) ? '  ●' : ''}
            </option>
          ))}
        </select>
        <button className={`btn h-7 text-[11.5px] ${explain ? 'btn-primary' : ''}`} onClick={() => setExplain(!explain)}>
          Why?
        </button>
      </div>
      {proc && (
        <div className="px-4 pb-1 pt-1.5 text-[11px] text-[var(--text-faint)]">
          {proc.who} · {proc.ref}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {explain && proc && (
          <div className="prose-explain mx-2 mb-3 mt-1 rounded-lg border border-[#7c9cff]/25 bg-[#7c9cff]/[0.06] p-3 text-[12.5px]">
            {proc.explain.split(/\n\s*\n/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}
        {proc && (
          <div className="mono text-[12px] leading-[1.55]">
            {proc.lines.map((l) => {
              const hit = byLine.get(l.id)
              const current = currentLine === l.id
              const order = hit ? ordered.indexOf(l.id) + 1 : 0
              return (
                <div
                  key={l.id}
                  className={`rounded-md px-2 py-[3px] transition-colors ${current ? 'bg-[#7c9cff]/25' : hit ? 'bg-[#7c9cff]/[0.09]' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="w-5 shrink-0 pt-[1px] text-right text-[10px] text-[var(--text-faint)]">
                      {hit ? <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${current ? 'bg-[#7c9cff] text-black' : 'bg-[#7c9cff]/25 text-[#c7d4ff]'}`}>{order}</span> : ''}
                    </span>
                    <span className={`flex-1 whitespace-pre-wrap ${hit ? 'text-[#e6ebf3]' : 'text-[var(--text-dim)]'}`} style={{ paddingLeft: l.indent * 16 }}>
                      {l.text}
                    </span>
                    {l.note && <span className="shrink-0 pt-[1px] text-[10px] text-[var(--text-faint)]">{l.note}</span>}
                  </div>
                  {hit && (
                    <div className="ml-7 mt-0.5 flex flex-col gap-0.5" style={{ paddingLeft: l.indent * 16 }}>
                      {hit.steps.map((s, i) => (
                        <StepNote key={i} s={s} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function StepNote({ s }: { s: TraceStep }) {
  if (s.kind === 'cond')
    return (
      <div className="text-[11px]">
        <span className="text-[var(--text-faint)]">{s.values}</span>{' '}
        <span className={`rounded px-1 font-semibold ${s.result ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'}`}>{s.result ? 'true' : 'false'}</span>
      </div>
    )
  if (s.kind === 'set') return <div className="text-[11px] text-amber-200/90">{s.text}</div>
  if (s.kind === 'note') return <div className="text-[11px] italic text-[var(--text-dim)]">{s.text}</div>
  if (s.text) return <div className="text-[11px] text-[var(--text-faint)]">{s.text}</div>
  return null
}
