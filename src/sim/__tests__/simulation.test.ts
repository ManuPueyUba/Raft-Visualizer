import { describe, expect, it } from 'vitest'
import { Simulation } from '../simulation'
import { lastLogIndex, latestConfig } from '../log'

const leaders = (sim: Simulation) => sim.s.nodeOrder.filter((id) => sim.s.nodes[id].alive && sim.s.nodes[id].role === 'leader')

function runUntil(sim: Simulation, pred: () => boolean, maxTime = 20000) {
  const end = sim.s.now + maxTime
  while (sim.s.now < end && !pred()) if (!sim.step()) break
  return pred()
}

describe('elections', () => {
  it('elects exactly one leader', () => {
    const sim = new Simulation({ nodes: 5, seed: 42 })
    expect(runUntil(sim, () => leaders(sim).length === 1)).toBe(true)
    sim.advanceTo(sim.s.now + 3000)
    expect(leaders(sim).length).toBe(1)
    expect(sim.s.oracle.violations).toEqual([])
  })

  it('re-elects after the leader crashes', () => {
    const sim = new Simulation({ nodes: 5, seed: 7 })
    runUntil(sim, () => leaders(sim).length === 1)
    const old = leaders(sim)[0]
    const term = sim.s.nodes[old].currentTerm
    sim.crash(old)
    expect(runUntil(sim, () => leaders(sim).length === 1)).toBe(true)
    const nu = leaders(sim)[0]
    expect(nu).not.toBe(old)
    expect(sim.s.nodes[nu].currentTerm).toBeGreaterThan(term)
  })

  it('pre-vote keeps an isolated node from inflating its term', () => {
    const sim = new Simulation({ nodes: 3, seed: 3, settings: { preVote: true } })
    runUntil(sim, () => leaders(sim).length === 1)
    const l = leaders(sim)[0]
    const iso = sim.s.nodeOrder.find((x) => x !== l)!
    const term = sim.s.nodes[iso].currentTerm
    sim.setPartition([[iso], sim.s.nodeOrder.filter((x) => x !== iso)])
    sim.advanceTo(sim.s.now + 5000)
    expect(sim.s.nodes[iso].currentTerm).toBe(term)
  })
})

describe('replication', () => {
  it('commits and applies client writes on every server', () => {
    const sim = new Simulation({ nodes: 3, seed: 11 })
    runUntil(sim, () => leaders(sim).length === 1)
    sim.clientRequest({ op: 'set', key: 'x', value: '5' })
    sim.clientRequest({ op: 'set', key: 'y', value: '7' })
    expect(runUntil(sim, () => sim.s.client.ops.every((o) => o.status === 'ok'))).toBe(true)
    sim.advanceTo(sim.s.now + 1000)
    for (const id of sim.s.nodeOrder) expect(sim.s.nodes[id].kv).toEqual({ x: '5', y: '7' })
  })

  it('catches up a follower that was down (with and without fast backup)', () => {
    for (const fastBackup of [false, true]) {
      const sim = new Simulation({ nodes: 3, seed: 5, settings: { fastBackup } })
      runUntil(sim, () => leaders(sim).length === 1)
      const l = leaders(sim)[0]
      const f = sim.s.nodeOrder.find((x) => x !== l)!
      sim.crash(f)
      for (let i = 0; i < 8; i++) sim.clientRequest({ op: 'set', key: 'k', value: String(i) })
      runUntil(sim, () => sim.s.client.ops.every((o) => o.status === 'ok'))
      sim.restart(f)
      expect(runUntil(sim, () => lastLogIndex(sim.s.nodes[f]) === lastLogIndex(sim.s.nodes[leaders(sim)[0]]))).toBe(true)
      expect(sim.s.oracle.violations).toEqual([])
    }
  })

  it('uses InstallSnapshot for a lagging follower', () => {
    const sim = new Simulation({ nodes: 3, seed: 9, settings: { snapshotThreshold: 3 } })
    runUntil(sim, () => leaders(sim).length === 1)
    const l = leaders(sim)[0]
    const f = sim.s.nodeOrder.find((x) => x !== l)!
    sim.crash(f)
    for (let i = 0; i < 8; i++) sim.clientRequest({ op: 'set', key: 'k', value: String(i) })
    runUntil(sim, () => sim.s.client.ops.every((o) => o.status === 'ok'))
    sim.restart(f)
    runUntil(sim, () => sim.s.nodes[f].kv.k === '7')
    expect(sim.s.nodes[f].kv.k).toBe('7')
    expect(sim.events.some((e) => e.msg?.type === 'InstallSnapshot')).toBe(true)
    expect(sim.s.oracle.violations).toEqual([])
  })

  it('serves linearizable reads with ReadIndex and lease', () => {
    for (const readMode of ['readIndex', 'lease'] as const) {
      const sim = new Simulation({ nodes: 3, seed: 21, settings: { readMode } })
      runUntil(sim, () => leaders(sim).length === 1)
      sim.clientRequest({ op: 'set', key: 'x', value: '9' })
      sim.clientRequest({ op: 'get', key: 'x' })
      expect(runUntil(sim, () => sim.s.client.ops.every((o) => o.status === 'ok'))).toBe(true)
      expect(sim.s.client.ops[1].result).toBe('9')
    }
  })
})

describe('membership', () => {
  it('adds and removes servers through joint consensus', () => {
    const sim = new Simulation({ nodes: 3, seed: 13 })
    runUntil(sim, () => leaders(sim).length === 1)
    expect(sim.addServer()).toBeNull()
    const l = () => sim.s.nodes[leaders(sim)[0]]
    expect(runUntil(sim, () => leaders(sim).length === 1 && latestConfig(l()).voters.length === 4 && !latestConfig(l()).newVoters && l().commitIndex >= lastLogIndex(l()))).toBe(true)
    const victim = l().id
    expect(sim.removeServer(victim)).toBeNull()
    expect(runUntil(sim, () => leaders(sim).length === 1 && leaders(sim)[0] !== victim && latestConfig(l()).voters.length === 3)).toBe(true)
    expect(latestConfig(l()).voters).not.toContain(victim)
    sim.advanceTo(sim.s.now + 3000)
    expect(sim.s.oracle.violations).toEqual([])
  })
})

describe('determinism', () => {
  it('same seed and actions produce the same history', () => {
    const run = () => {
      const sim = new Simulation({ nodes: 5, seed: 99, settings: { dropRate: 0.1 } })
      sim.advanceTo(1500)
      sim.clientRequest({ op: 'set', key: 'a', value: '1' })
      sim.advanceTo(4000)
      return sim.events.map((e) => `${e.time.toFixed(3)}:${e.title}`).join('\n')
    }
    expect(run()).toBe(run())
  })
})

describe('time travel', () => {
  it('restores a checkpoint', () => {
    const sim = new Simulation({ nodes: 3, seed: 1 })
    sim.advanceTo(2000)
    const idx = sim.history.length - 1
    const snapshot = JSON.stringify(sim.history[idx])
    sim.advanceTo(5000)
    sim.restore(idx)
    expect(JSON.stringify(sim.s)).toBe(snapshot)
  })
})

describe('fuzz: safety under crashes, partitions and loss', () => {
  it('never violates the Figure 3 properties', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const settings = {
        dropRate: (seed % 4) * 0.05,
        preVote: seed % 2 === 0,
        checkQuorum: seed % 3 === 0,
        fastBackup: seed % 5 < 2,
        snapshotThreshold: seed % 3 === 1 ? 4 : 0,
        readMode: (['log', 'readIndex', 'lease'] as const)[seed % 3],
        autoClientInterval: 250,
      }
      const sim = new Simulation({ nodes: 3 + (seed % 3), seed, settings })
      let r = seed
      const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648)
      for (let t = 0; t < 20000; t += 500) {
        sim.advanceTo(t)
        const ids = sim.s.nodeOrder
        const x = rnd()
        const id = ids[Math.floor(rnd() * ids.length)]
        if (x < 0.1) sim.crash(id)
        else if (x < 0.25) sim.restart(id)
        else if (x < 0.3) sim.setPartition([ids.slice(0, 2), ids.slice(2)])
        else if (x < 0.35) sim.setPartition(null)
        else if (x < 0.38) sim.addServer()
        else if (x < 0.4) sim.removeServer(id)
        else if (x < 0.42) sim.transferLeadership(id)
        else if (x < 0.45) sim.clientRequest({ op: 'get', key: 'x' })
      }
      if (sim.s.oracle.violations.length) throw new Error(`seed ${seed}: ${JSON.stringify(sim.s.oracle.violations[0])}`)
    }
  }, 120000)

  it('the unsafe switches do produce violations', () => {
    let found = false
    for (let seed = 1; seed <= 80 && !found; seed++) {
      const sim = new Simulation({ nodes: 5, seed, settings: { unsafeNoElectionRestriction: true, unsafeCommitOldTerms: true, autoClientInterval: 150, dropRate: 0.15 } })
      let r = seed
      const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648)
      for (let t = 0; t < 20000; t += 400) {
        sim.advanceTo(t)
        const id = sim.s.nodeOrder[Math.floor(rnd() * 5)]
        if (rnd() < 0.3) sim.crash(id)
        else sim.restart(id)
      }
      found = sim.s.oracle.violations.length > 0
    }
    expect(found).toBe(true)
  }, 120000)
})
