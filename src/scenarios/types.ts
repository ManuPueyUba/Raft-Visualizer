import type { Simulation } from '../sim/simulation'
import type { Settings } from '../sim/types'
import type { VersionId } from './versions'

export interface ScenarioStep {
  title: string
  /** Narration shown while and after the step plays. */
  text: string
  /** Restore the state at the end of step k first (-1 = the scenario start). */
  rewindTo?: number
  /** Name of the alternative this step starts (steps with rewindTo begin a new branch) */
  branch?: string
  /** Actions applied when the step starts. */
  run?: (sim: Simulation) => void
  /** The step plays until this holds (or maxTime of simulated ms elapse). */
  until?: (sim: Simulation) => boolean
  /** Actions applied once `until` holds. */
  after?: (sim: Simulation) => void
  maxTime?: number
  /** Pseudocode procedure to open while the step plays. */
  focus?: string
}

export type ScenarioCategory = 'Elections' | 'Replication' | 'Safety' | 'Membership' | 'Clients & snapshots'

export interface Scenario {
  id: string
  category: ScenarioCategory
  title: string
  summary: string
  intro: string
  version: VersionId
  nodes: number
  seed: number
  settings?: Partial<Settings>
  /** Runs instantly before the scenario starts (its events are not kept). */
  setup?: (sim: Simulation) => void
  steps: ScenarioStep[]
}
