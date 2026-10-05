import { cloneState } from '../sim/clone'
import { Simulation } from '../sim/simulation'
import type { SimState } from '../sim/types'
import type { Scenario, ScenarioStep } from './types'
import { VERSION_BY_ID } from './versions'

export const DEFAULT_STEP_TIME = 3000

/** Builds the simulation for a scenario, already past its setup. */
export function createScenarioSim(sc: Scenario): Simulation {
  const sim = new Simulation({ nodes: sc.nodes, seed: sc.seed, settings: { ...VERSION_BY_ID[sc.version].settings, ...sc.settings } })
  sc.setup?.(sim)
  sim.markStart(`Scenario: ${sc.title}`)
  return sim
}

/** States saved at the start of the scenario (index 0) and at the end of each step (k + 1). */
export type StepStates = SimState[]

/** Starts a step: rewinds if needed and applies its actions. Returns the deadline (sim time). */
export function beginStep(sim: Simulation, step: ScenarioStep, states: StepStates): number {
  if (step.rewindTo !== undefined) {
    const snap = states[step.rewindTo + 1]
    if (snap) sim.restoreState(snap)
  }
  step.run?.(sim)
  return sim.s.now + (step.maxTime ?? DEFAULT_STEP_TIME)
}

export function stepDone(sim: Simulation, step: ScenarioStep, deadline: number): boolean {
  if (step.until?.(sim)) return true
  return sim.s.now >= deadline
}

/** Runs a whole step without animation. Returns whether `until` was reached. */
export function runStepHeadless(sim: Simulation, step: ScenarioStep, states: StepStates): boolean {
  const deadline = beginStep(sim, step, states)
  while (!stepDone(sim, step, deadline)) {
    const t = sim.nextEventTime()
    if (!Number.isFinite(t) || t > deadline) {
      sim.advanceTo(deadline)
      break
    }
    sim.step()
  }
  const reached = step.until ? step.until(sim) : true
  finishStep(sim, step, reached, states)
  return reached
}

export function finishStep(sim: Simulation, step: ScenarioStep, reached: boolean, states: StepStates) {
  if (reached) step.after?.(sim)
  states.push(cloneState(sim.s))
}

/** Advances the simulation instantly until `pred` holds (used in setups). */
export function fastForward(sim: Simulation, pred: () => boolean, maxTime = 5000) {
  const end = sim.s.now + maxTime
  while (!pred() && sim.s.now < end) if (!sim.step()) break
  if (!pred()) throw new Error('scenario setup did not reach its target state')
}
