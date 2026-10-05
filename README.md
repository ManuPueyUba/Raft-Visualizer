# Raft Visualizer

An interactive, in-browser simulator of the Raft consensus algorithm, covering the whole
[extended Raft paper](https://pdos.csail.mit.edu/6.824/papers/raft-extended.pdf)
(Ongaro & Ousterhout): leader election, log replication, safety, membership changes,
log compaction and client interaction — plus common optimizations as toggles.

Made for the Sistemas Distribuidos course at FIUBA.

## Features

- **Cluster view**: servers in a ring with election-timeout rings, animated RPCs (click any
  message to see its arguments and why it was sent), crashes, partitions and dropped messages.
- **Live pseudocode** (Figure 2 and beyond): the lines each event executed are highlighted,
  conditions are shown with their evaluated values, and every procedure has a "Why?" explanation.
- **Logs table** with terms, commit/applied markers, snapshots and the leader's `nextIndex`/`matchIndex`.
- **Time travel**: scrub back through the simulation and replay it.
- **Versions**: from basic Raft up to all optimizations (no-op on election, fast log backup,
  snapshots, ReadIndex, leader leases, Pre-Vote, CheckQuorum, leadership transfer), plus an
  "unsafe" version that disables safety rules.
- **Guided scenarios** played step by step: split vote, stale candidate, term inflation,
  lagging follower, old leader in a minority, Figure 8, adding a server, exactly-once semantics.
- **Safety checker** for the five properties of Figure 3, verified after every event.
- Deterministic: the same seed and actions always produce the same run.

## Running

```bash
npm install
npm run dev     # development server
npm test        # simulation tests (Figure 3 properties fuzzed over many seeds)
npm run build   # static build in dist/
```

## Structure

- `src/sim/` — the simulation engine (pure TypeScript): Raft handlers, network, invariants, pseudocode.
- `src/scenarios/` — version presets and guided scenarios.
- `src/store/` — Zustand store, animation loop and time travel.
- `src/ui/` — React components.
