import { useEffect, useState } from 'react'
import { useSim, type Panel } from './store/simStore'
import { ClientPanel } from './ui/ClientPanel'
import { ClusterView } from './ui/ClusterView'
import { EventsPanel } from './ui/EventsPanel'
import { Inspector } from './ui/Inspector'
import { LogTable } from './ui/LogTable'
import { PseudocodePanel } from './ui/PseudocodePanel'
import { ScenarioCard, ScenarioPicker } from './ui/Scenarios'
import { SettingsPanel } from './ui/SettingsPanel'
import { Timeline } from './ui/Timeline'
import { TopBar } from './ui/TopBar'

const TABS: { id: Panel; label: string }[] = [
  { id: 'code', label: 'Pseudocode' },
  { id: 'inspect', label: 'Inspector' },
  { id: 'events', label: 'Events' },
  { id: 'client', label: 'Client' },
  { id: 'settings', label: 'Settings' },
]

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const st = useSim.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        st.setPlaying(!st.playing)
      } else if (e.key === 'ArrowRight') st.stepOnce()
      else if (e.key === 'ArrowLeft') {
        const idx = st.viewIndex ?? st.sim.history.length - 1
        if (idx > 0) st.setView(idx - 1)
      } else if ((e.key === 'n' || e.key === 'Enter') && st.beats) st.beatOk()
      else if (e.key === 'n' && st.scenario) st.scenarioNext()
      else if (e.key === 'Escape') {
        st.selectNode(null)
        st.selectMsg(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export default function App() {
  useKeyboard()
  const panel = useSim((x) => x.panel)
  const toast = useSim((x) => x.toast)
  const viewing = useSim((x) => x.viewIndex !== null && !x.beats)
  const [picker, setPicker] = useState(false)

  return (
    <div className="flex h-full flex-col">
      <TopBar onScenarios={() => setPicker(true)} />
      <main className="flex min-h-0 flex-1 gap-3 p-3">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <div className={`panel relative min-h-0 flex-[3] overflow-hidden ${viewing ? 'ring-1 ring-[#7c9cff]/40' : ''}`}>
            <ClusterView />
            <ScenarioCard />
            {viewing && <div className="absolute left-3 top-3 rounded-md bg-[#7c9cff]/15 px-2 py-1 text-[11px] text-[#c7d4ff]">Viewing the past · actions will discard the future</div>}
          </div>
          <div className="panel min-h-[150px] flex-[1.4] overflow-hidden">
            <LogTable />
          </div>
        </section>
        <aside className="panel flex w-[460px] shrink-0 flex-col overflow-hidden">
          <nav className="flex gap-1 border-b border-[var(--line)] p-2">
            {TABS.map((t) => (
              <button key={t.id} className={`tab text-[12.5px] ${panel === t.id ? 'tab-active' : ''}`} onClick={() => useSim.getState().setPanel(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1">
            {panel === 'code' && <PseudocodePanel />}
            {panel === 'inspect' && <Inspector />}
            {panel === 'events' && <EventsPanel />}
            {panel === 'client' && <ClientPanel />}
            {panel === 'settings' && <SettingsPanel />}
          </div>
        </aside>
      </main>
      <Timeline />
      {picker && <ScenarioPicker onClose={() => setPicker(false)} />}
      {toast && <div className="panel fixed bottom-16 left-1/2 z-50 -translate-x-1/2 px-4 py-2 text-[12.5px] shadow-xl">{toast}</div>}
    </div>
  )
}
