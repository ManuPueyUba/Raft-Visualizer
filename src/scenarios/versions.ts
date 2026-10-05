import type { Settings } from '../sim/types'

export type VersionId = 'basic' | 'clients' | 'fastBackup' | 'snapshots' | 'readIndex' | 'lease' | 'preVote' | 'checkQuorum' | 'full' | 'unsafe'

export interface Version {
  id: VersionId
  label: string
  short: string
  adds: string
  settings: Partial<Settings>
}

const BASE: Partial<Settings> = {
  noopOnElection: false,
  fastBackup: false,
  snapshotThreshold: 0,
  readMode: 'log',
  preVote: false,
  checkQuorum: false,
  unsafeNoElectionRestriction: false,
  unsafeCommitOldTerms: false,
}

/** Cumulative presets: each version adds one idea on top of the previous one. */
export const VERSIONS: Version[] = [
  { id: 'basic', label: '1 · Basic Raft', short: 'Basic', adds: 'Figure 2 only: elections, log replication, commit rule and membership (§5–6).', settings: BASE },
  { id: 'clients', label: '2 · + Client semantics', short: '+Clients', adds: 'A no-op entry at the start of each term and client sessions for exactly-once commands (§8).', settings: { ...BASE, noopOnElection: true } },
  { id: 'fastBackup', label: '3 · + Fast backup', short: '+Fast backup', adds: 'Followers reply with conflictTerm/conflictIndex so the leader skips a whole term per round trip (§5.3).', settings: { ...BASE, noopOnElection: true, fastBackup: true } },
  { id: 'snapshots', label: '4 · + Snapshots', short: '+Snapshots', adds: 'Log compaction every 8 applied entries, InstallSnapshot for followers that fell behind (§7).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8 } },
  { id: 'readIndex', label: '5 · + ReadIndex', short: '+ReadIndex', adds: 'Reads skip the log: the leader confirms it is still leader with one heartbeat round (§8 / thesis 6.4).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8, readMode: 'readIndex' } },
  { id: 'lease', label: '6 · + Leader lease', short: '+Lease', adds: 'Reads served locally while the leader holds a time-based lease (needs bounded clock drift).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8, readMode: 'lease' } },
  { id: 'preVote', label: '7 · + Pre-Vote', short: '+Pre-Vote', adds: 'A candidate first asks whether it could win, so partitioned servers stop inflating terms (thesis 9.6).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8, readMode: 'lease', preVote: true } },
  { id: 'checkQuorum', label: '8 · + CheckQuorum', short: '+CheckQuorum', adds: 'A leader that stops hearing from a majority steps down by itself (thesis 6.2).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8, readMode: 'lease', preVote: true, checkQuorum: true } },
  { id: 'full', label: '9 · Everything', short: 'Full', adds: 'All of the above; use leadership transfer (TimeoutNow) from the node menu (thesis 3.10).', settings: { ...BASE, noopOnElection: true, fastBackup: true, snapshotThreshold: 8, readMode: 'lease', preVote: true, checkQuorum: true } },
  { id: 'unsafe', label: '⚠ Unsafe Raft', short: 'Unsafe', adds: 'Basic Raft with the election restriction and the current-term commit rule switched off, to watch safety break.', settings: { ...BASE, unsafeNoElectionRestriction: true, unsafeCommitOldTerms: true } },
]

export const VERSION_BY_ID = Object.fromEntries(VERSIONS.map((v) => [v.id, v])) as Record<VersionId, Version>
