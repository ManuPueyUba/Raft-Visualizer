import { create } from 'zustand'
import { cloneState } from '../sim/clone'
import { Simulation } from '../sim/simulation'
import type { NodeId, SimEvent, SimState } from '../sim/types'
import { SCENARIOS } from '../scenarios/library'
import { beginStep, createScenarioSim, finishStep, runStepHeadless, stepDone, type StepStates } from '../scenarios/runner'
import type { Scenario } from '../scenarios/types'
import { VERSION_BY_ID, type VersionId } from '../scenarios/versions'

export interface ScenarioRun {
  sc: Scenario
  /** -1 = intro, k = step k has been started */
  step: number
  states: StepStates
  /** sim deadline of the step that is playing, null when the step finished */
  deadline: number | null
  /** where things end up if the scenario is played as written (from a dry run) */
  plan: ScenarioPlan
}

export interface ScenarioPlan {
  /** sim time at the end of the last step */
  end: number
  /** start time of each step that lies on the final timeline (steps undone by a rewind are missing) */
  starts: { k: number; now: number }[]
}

/** Plays the whole scenario instantly on a copy, to know how long the timeline will be. */
function planScenario(sc: Scenario): ScenarioPlan {
  const sim = createScenarioSim(sc)
  const states: StepStates = [cloneState(sim.s)]
  for (const step of sc.steps) runStepHeadless(sim, step, states)
  const onTimeline = (x: SimState) => sim.history.some((h) => h.eventCount === x.eventCount && h.now === x.now)
  const starts = states.flatMap((x, k) => (k < sc.steps.length && onTimeline(x) ? [{ k, now: x.now }] : []))
  return { end: sim.s.now, starts }
}

/** Scenario actions shown one at a time (each one is a history checkpoint). */
export interface Beats {
  /** history index of the state before the actions */
  before: number
  /** history indices right after each action */
  list: number[]
  /** real ms since the beats started */
  elapsed: number
  /** resume playing once the beats are over */
  thenPlay: boolean
  /** shown with the "before" frame, e.g. after a rewind */
  preface?: string
}

export const BEAT_PRE_MS = 700
/** each action waits for OK, or moves on by itself after this long */
export const BEAT_MS = 5000

/** Which frame of the beats is on screen: -1 = the state before the actions. */
export function beatPos(b: Beats): number {
  if (b.elapsed < BEAT_PRE_MS) return -1
  return Math.min(b.list.length - 1, Math.floor((b.elapsed - BEAT_PRE_MS) / BEAT_MS))
}

export type Panel = 'code' | 'inspect' | 'events' | 'client' | 'settings'

interface Store {
  sim: Simulation
  version: VersionId
  nodeCount: number
  seed: number
  frame: number
  playing: boolean
  /** simulated milliseconds per real millisecond */
  speed: number
  /** history index being viewed (time travel), null = live */
  viewIndex: number | null
  /** sim time drawn while replaying the past (between two checkpoints) */
  viewTime: number | null
  selectedNode: NodeId | null
  selectedMsg: number | null
  selectedEvent: number | null
  /** procedure pinned by the user (overrides the automatic choice) */
  pinnedProc: string | null
  panel: Panel
  toast: string | null
  scenario: ScenarioRun | null
  beats: Beats | null

  bump: () => void
  /** Leaves time travel, discarding the future after the viewed point. */
  goLive: () => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void
  stepOnce: () => void
  reset: (opts?: { nodes?: number; seed?: number; version?: VersionId }) => void
  setVersion: (v: VersionId) => void
  act: (fn: (sim: Simulation) => string | null | void) => void
  selectNode: (id: NodeId | null) => void
  selectMsg: (id: number | null) => void
  selectEvent: (id: number | null) => void
  setView: (i: number | null) => void
  /** Time travel to an arbitrary sim time (shows the last checkpoint before it, animated to t) */
  setViewTime: (t: number) => void
  pinProc: (id: string | null) => void
  setPanel: (p: Panel) => void
  notify: (msg: string) => void
  loadScenario: (id: string) => void
  scenarioNext: () => void
  /** Moves the scenario to the start of step `target` (= steps.length for the end), running
   *  skipped steps instantly; with `play`, that step starts right away. */
  jumpToStep: (target: number, play: boolean) => void
  /** OK on the current action: show the next one (or resume) */
  beatOk: () => void
  scenarioBack: () => void
  scenarioRestart: () => void
  exitScenario: () => void
  /** Leaves the guided mode keeping the current state, and starts playing. */
  continueFromScenario: () => void
  tick: (dtMs: number) => void
}

const DEFAULT_VERSION: VersionId = 'clients'
/** Simulated ms per real ms at ×1 */
export const BASE_SPEED = 0.02

function makeSim(nodes: number, seed: number, version: VersionId) {
  return new Simulation({ nodes, seed, settings: VERSION_BY_ID[version].settings })
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useSim = create<Store>((set, get) => ({
  sim: makeSim(5, 1, DEFAULT_VERSION),
  version: DEFAULT_VERSION,
  nodeCount: 5,
  seed: 1,
  frame: 0,
  playing: true,
  speed: BASE_SPEED,
  viewIndex: null,
  viewTime: null,
  selectedNode: null,
  selectedMsg: null,
  selectedEvent: null,
  pinnedProc: null,
  panel: 'code',
  toast: null,
  scenario: null,
  beats: null,

  bump: () => set((s) => ({ frame: s.frame + 1 })),

  goLive: () => {
    const st = get()
    if (st.beats) {
      // the beats only replay actions that already happened: just jump to the present
      set({ beats: null, viewIndex: null, viewTime: null })
      return
    }
    if (st.viewIndex === null) return
    if (st.viewIndex < st.sim.history.length - 1) st.sim.restore(st.viewIndex)
    set({ viewIndex: null, viewTime: null })
  },

  setPlaying: (p) => {
    // playing while viewing the past replays the recorded history
    const { viewIndex, sim } = get()
    if (p && viewIndex !== null && viewIndex >= sim.history.length - 1) get().setView(null)
    set({ playing: p })
  },

  setSpeed: (speed) => set({ speed }),

  stepOnce: () => {
    const st = get()
    if (st.viewIndex !== null) {
      // stepping while looking at the past moves the view forward one event
      const next = st.viewIndex + 1
      st.setView(next >= st.sim.history.length - 1 ? null : next)
      return
    }
    st.sim.step()
    const last = st.sim.events[st.sim.events.length - 1]
    set({ playing: false, selectedEvent: last?.id ?? null, frame: st.frame + 1 })
    get().tick(0)
  },

  reset: (opts) => {
    const st = get()
    const nodes = opts?.nodes ?? st.nodeCount
    const seed = opts?.seed ?? st.seed
    const version = opts?.version ?? st.version
    set({
      sim: makeSim(nodes, seed, version),
      nodeCount: nodes,
      seed,
      version,
      viewIndex: null,
      selectedNode: null,
      selectedMsg: null,
      selectedEvent: null,
      scenario: null,
      beats: null,
      frame: st.frame + 1,
    })
  },

  setVersion: (v) => {
    const st = get()
    st.goLive()
    st.sim.updateSettings(VERSION_BY_ID[v].settings)
    set({ version: v, frame: st.frame + 1 })
  },

  act: (fn) => {
    const st = get()
    st.goLive()
    const err = fn(st.sim)
    if (typeof err === 'string') st.notify(err)
    set({ frame: get().frame + 1 })
  },

  selectNode: (id) => set({ selectedNode: id, selectedMsg: null, panel: id && get().panel === 'events' ? 'inspect' : get().panel }),
  selectMsg: (id) => set({ selectedMsg: id, panel: id !== null ? 'inspect' : get().panel }),

  selectEvent: (id) => {
    const st = get()
    if (id === null) return set({ selectedEvent: null })
    const idx = st.sim.history.findIndex((h) => h.eventCount === id + 1)
    set({ selectedEvent: id, playing: false, pinnedProc: null })
    if (idx >= 0) st.setView(idx === st.sim.history.length - 1 ? null : idx)
  },

  setView: (i) => {
    const st = get()
    if (i === null) return set({ viewIndex: null, viewTime: null, frame: st.frame + 1 })
    const h = st.sim.history[i]
    set({ viewIndex: i, viewTime: h?.now ?? null, playing: false, selectedEvent: h ? h.eventCount - 1 : null, frame: st.frame + 1 })
  },

  setViewTime: (t) => {
    const st = get()
    const h = st.sim.history
    if (h.length === 0) return
    if (t >= h[h.length - 1].now) return st.setView(null)
    // last checkpoint at or before t (binary search: checkpoints are sorted by time)
    let lo = 0
    let hi = h.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (h[mid].now <= t) lo = mid
      else hi = mid - 1
    }
    set({ viewIndex: lo, viewTime: Math.max(t, h[lo].now), playing: false, selectedEvent: h[lo].eventCount - 1, frame: st.frame + 1 })
  },

  pinProc: (id) => set({ pinnedProc: id }),
  setPanel: (panel) => set({ panel }),

  notify: (msg) => {
    clearTimeout(toastTimer)
    set({ toast: msg })
    toastTimer = setTimeout(() => set({ toast: null }), 3500)
  },

  // ------------------------------------------------------------ scenarios

  loadScenario: (id) => {
    const sc = SCENARIOS.find((s) => s.id === id)
    if (!sc) return
    const sim = createScenarioSim(sc)
    set({
      sim,
      version: sc.version,
      nodeCount: sc.nodes,
      seed: sc.seed,
      scenario: { sc, step: -1, states: [cloneState(sim.s)], deadline: null, plan: planScenario(sc) },
      beats: null,
      viewIndex: null,
      selectedNode: null,
      selectedMsg: null,
      selectedEvent: null,
      pinnedProc: null,
      playing: false,
      panel: 'code',
      frame: get().frame + 1,
    })
  },

  scenarioNext: () => {
    const st = get()
    const run = st.scenario
    if (!run) return
    if (st.beats) {
      const thenPlay = st.beats.thenPlay
      st.goLive()
      set({ playing: thenPlay, frame: st.frame + 1 })
      return
    }
    st.goLive()
    // a step still playing: jump to its end first
    if (run.deadline !== null) {
      const step = run.sc.steps[run.step]
      while (!stepDone(st.sim, step, run.deadline)) {
        const t = st.sim.nextEventTime()
        if (!Number.isFinite(t) || t > run.deadline) {
          st.sim.advanceTo(run.deadline)
          break
        }
        st.sim.step()
      }
      const beats = completeStep(st.sim, run)
      set({ scenario: { ...run, deadline: null }, playing: false, frame: st.frame + 1 })
      startBeats(beats)
      return
    }
    const k = run.step + 1
    if (k >= run.sc.steps.length) return
    const states = run.states.slice(0, k + 1)
    const step = run.sc.steps[k]
    let preface: string | undefined
    if (step.rewindTo !== undefined) {
      const snap = states[step.rewindTo + 1]
      if (snap) st.sim.restoreState(snap)
      preface = step.rewindTo < 0 ? 'Rewound to the start of the scenario' : `Rewound to the end of step ${step.rewindTo + 1}`
    }
    const before = st.sim.history.length - 1
    const deadline = beginStep(st.sim, { ...step, rewindTo: undefined }, states)
    set({ scenario: { ...run, step: k, states, deadline }, playing: true, pinnedProc: null, frame: st.frame + 1 })
    startBeats(collectBeats(st.sim, before, true, preface))
  },

  jumpToStep: (target, play) => {
    const st = get()
    const run = st.scenario
    if (!run) return
    const n = run.sc.steps.length
    target = Math.max(0, Math.min(n, target))
    if (st.beats) set({ beats: null, viewIndex: null, viewTime: null })
    else st.goLive()
    const sim = st.sim
    let states = run.states
    // states[k] is the state at the start of step k; states.length - 1 steps are complete
    if (target < states.length) {
      sim.restoreState(states[target])
      states = states.slice(0, target + 1)
    } else {
      // finish the step that is playing, then run the missing steps without animation
      if (run.deadline !== null) {
        const step = run.sc.steps[run.step]
        while (!stepDone(sim, step, run.deadline)) {
          const t = sim.nextEventTime()
          if (!Number.isFinite(t) || t > run.deadline) {
            sim.advanceTo(run.deadline)
            break
          }
          sim.step()
        }
        finishStep(sim, step, step.until ? step.until(sim) : true, states)
      }
      for (let k = states.length - 1; k < target; k++) runStepHeadless(sim, run.sc.steps[k], states)
    }
    set({ scenario: { ...run, step: target - 1, states, deadline: null }, playing: false, viewIndex: null, viewTime: null, pinnedProc: null, frame: get().frame + 1 })
    if (play && target < n) get().scenarioNext()
  },

  beatOk: () => {
    const b = get().beats
    if (!b) return
    const pos = beatPos(b)
    // jump to the start of the next action (past the end finishes the beats on the next tick)
    set({ beats: { ...b, elapsed: BEAT_PRE_MS + (pos + 1) * BEAT_MS } })
    get().tick(0)
  },

  scenarioBack: () => {
    const st = get()
    const run = st.scenario
    if (!run || run.step < 0) return
    // back to the state before the current step started
    const k = run.step
    const snap = run.states[k]
    if (!snap) return
    set({ beats: null })
    st.sim.restoreState(snap)
    set({ scenario: { ...run, step: k - 1, states: run.states.slice(0, k), deadline: null }, playing: false, viewIndex: null, frame: st.frame + 1 })
  },

  scenarioRestart: () => {
    const run = get().scenario
    if (run) get().loadScenario(run.sc.id)
  },

  continueFromScenario: () => {
    get().exitScenario()
    set({ playing: true, pinnedProc: null })
  },

  exitScenario: () => {
    get().goLive()
    set({ scenario: null, frame: get().frame + 1 })
  },

  // ------------------------------------------------------------ animation

  tick: (dtMs) => {
    const st = get()
    if (st.beats) {
      const b = { ...st.beats, elapsed: st.beats.elapsed + dtMs }
      const total = BEAT_PRE_MS + b.list.length * BEAT_MS
      if (b.elapsed >= total) {
        set({ beats: null, viewIndex: null, viewTime: null, playing: b.thenPlay, frame: st.frame + 1 })
        return
      }
      const pos = beatPos(b)
      set({ beats: b, viewIndex: pos < 0 ? b.before : b.list[pos], viewTime: null, frame: st.frame + 1 })
      return
    }
    if (!st.playing) return
    if (st.viewIndex !== null) {
      // replay: walk forward through the checkpoints at the current speed
      const h = st.sim.history
      const vt = (st.viewTime ?? h[st.viewIndex].now) + dtMs * st.speed
      let i = st.viewIndex
      while (i + 1 < h.length && h[i + 1].now <= vt) i++
      if (i >= h.length - 1) {
        set({ viewIndex: null, viewTime: null, selectedEvent: null, frame: st.frame + 1 })
        return
      }
      set({ viewIndex: i, viewTime: vt, selectedEvent: i !== st.viewIndex ? h[i].eventCount - 1 : st.selectedEvent, frame: st.frame + 1 })
      return
    }
    const sim = st.sim
    const run = st.scenario
    let target = sim.s.now + dtMs * st.speed * idleBoost(sim)
    if (run && run.deadline !== null) target = Math.min(target, run.deadline)
    // advance event by event so scenario goals can stop exactly when reached
    let guard = 0
    while (guard++ < 500) {
      const t = sim.nextEventTime()
      if (!Number.isFinite(t) || t > target) break
      sim.step()
      if (run && run.deadline !== null && stepDone(sim, run.sc.steps[run.step], run.deadline)) {
        const beats = completeStep(sim, run)
        set({ scenario: { ...run, deadline: null }, playing: false, frame: st.frame + 1 })
        startBeats(beats)
        return
      }
    }
    if (guard < 500) sim.s.now = Math.max(sim.s.now, target)
    if (run && run.deadline !== null && sim.s.now >= run.deadline) {
      const beats = completeStep(sim, run)
      set({ scenario: { ...run, deadline: null }, playing: false, frame: st.frame + 1 })
      startBeats(beats)
      return
    }
    set({ frame: st.frame + 1 })
  },
}))

/** Skips dead time: with nothing on the wire, time runs faster the further away the
 *  next event is, and slows back to normal as a timeout is about to fire. */
const IDLE_SLOW_ZONE = 40 // sim ms before the next event that play at normal speed
const IDLE_MAX_BOOST = 25

function idleBoost(sim: Simulation): number {
  if (sim.s.messages.length > 0) return 1
  const gap = sim.nextEventTime() - sim.s.now
  if (!Number.isFinite(gap)) return 1
  return Math.min(IDLE_MAX_BOOST, Math.max(1, gap / IDLE_SLOW_ZONE))
}

/** Finishes a step; returns the actions its `after` hook performed, to show them one by one. */
function completeStep(sim: Simulation, run: ScenarioRun): Beats | null {
  const step = run.sc.steps[run.step]
  const before = sim.history.length - 1
  finishStep(sim, step, step.until ? step.until(sim) : true, run.states)
  return collectBeats(sim, before, false)
}

/** The checkpoints after `before` that were produced by user/scenario actions. */
function collectBeats(sim: Simulation, before: number, thenPlay: boolean, preface?: string): Beats | null {
  const list: number[] = []
  for (let i = before + 1; i < sim.history.length; i++) {
    const id = sim.history[i].eventCount - 1
    const ev = sim.events.find((e) => e.id === id)
    if (ev && (ev.kind === 'action' || ev.kind === 'client')) list.push(i)
  }
  if (list.length === 0 && !preface) return null
  if (list.length === 0) list.push(before)
  return { before, list, elapsed: 0, thenPlay, preface }
}

function startBeats(b: Beats | null) {
  if (!b) return
  useSim.setState({ beats: b, viewIndex: b.before, viewTime: null, playing: false })
}

/** The state the UI should draw: the live state or a past checkpoint. */
export function viewState(st: { sim: Simulation; viewIndex: number | null; viewTime?: number | null }): SimState {
  if (st.viewIndex === null) return st.sim.s
  const h = st.sim.history[st.viewIndex]
  if (!h) return st.sim.s
  return st.viewTime != null && st.viewTime > h.now ? { ...h, now: st.viewTime } : h
}

/** The event to explain in the pseudocode panel. */
export function focusEvent(st: { sim: Simulation; selectedEvent: number | null; selectedNode: NodeId | null; viewIndex: number | null }): SimEvent | null {
  const evs = st.sim.events
  if (st.selectedEvent !== null) return evs.find((e) => e.id === st.selectedEvent) ?? null
  const upTo = st.viewIndex !== null ? (st.sim.history[st.viewIndex]?.eventCount ?? Infinity) : Infinity
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (e.id >= upTo) continue
    if (e.trace.length === 0) continue
    if (st.selectedNode && e.nodeId !== st.selectedNode) continue
    return e
  }
  return null
}

// The animation loop lives with the store so a hot reload of this module
// replaces it cleanly instead of leaving it attached to a stale store.
if (typeof window !== 'undefined') {
  let last = performance.now()
  let raf = 0
  const loop = (t: number) => {
    const dt = Math.min(100, t - last)
    last = t
    useSim.getState().tick(dt)
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  import.meta.hot?.dispose(() => cancelAnimationFrame(raf))
}
