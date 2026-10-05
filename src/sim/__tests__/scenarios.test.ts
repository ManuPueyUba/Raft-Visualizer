import { describe, expect, it } from 'vitest'
import { cloneState } from '../clone'
import { SCENARIOS } from '../../scenarios/library'
import { createScenarioSim, runStepHeadless } from '../../scenarios/runner'

describe('guided scenarios', () => {
  for (const sc of SCENARIOS) {
    it(sc.id, () => {
      const sim = createScenarioSim(sc)
      const states = [cloneState(sim.s)]
      const failed: string[] = []
      sc.steps.forEach((st, i) => {
        if (!runStepHeadless(sim, st, states)) failed.push(`step ${i}: ${st.title}`)
      })
      expect(failed).toEqual([])
      if (sc.id !== 'figure-8') expect(sim.s.oracle.violations).toEqual([])
    })
  }
})
