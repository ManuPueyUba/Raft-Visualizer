import { latestConfig, latestConfigIndex } from '../sim/log'
import type { Simulation } from '../sim/simulation'
import { commitWrites, elect, inFlight, isLeader, lastIndex, leaderId, node, quiet, settled, termOf } from './helpers'
import { fastForward } from './runner'
import type { Scenario } from './types'

const anyRole = (sim: Simulation, role: string) => sim.s.nodeOrder.some((id) => node(sim, id).alive && node(sim, id).role === role)
const leaderOtherThan = (sim: Simulation, ...ids: string[]) => {
  const l = leaderId(sim)
  return l !== null && !ids.includes(l)
}

// ------------------------------------------------------------------ elections

const firstElection: Scenario = {
  id: 'first-election',
  category: 'Elections',
  title: 'The first election',
  summary: 'Five followers, no leader. Randomized timeouts decide who asks for votes first.',
  intro:
    'Every server starts as a follower in term 0 and waits for a heartbeat that never comes. Each one picked a random election timeout (the ring around the node). The first ring to empty wins the race to become a candidate.',
  version: 'basic',
  nodes: 5,
  seed: 4,
  steps: [
    {
      title: 'A timeout fires',
      text: 'The first server whose timer runs out increments its term, votes for itself and sends RequestVote to everyone. Click the RequestVote dots to see lastLogIndex/lastLogTerm.',
      until: (sim) => anyRole(sim, 'candidate'),
      focus: 'timeout',
    },
    {
      title: 'Votes come back',
      text: 'Each follower grants its vote if it has not voted in this term and the candidate’s log is at least as up-to-date as its own. With 3 of 5 votes the candidate becomes leader.',
      until: (sim) => anyRole(sim, 'leader'),
      focus: 'requestVote',
    },
    {
      title: 'Heartbeats',
      text: 'The new leader immediately sends empty AppendEntries (heartbeats) and keeps sending them every heartbeat interval. Each heartbeat resets the followers’ election timers, so nobody else starts an election.',
      maxTime: 600,
      focus: 'replicate',
    },
  ],
}

const splitVote: Scenario = {
  id: 'split-vote',
  category: 'Elections',
  title: 'Split vote',
  summary: 'Two servers time out at the same moment and split the votes; nobody wins term 1.',
  intro:
    'S1 and S2 are about to time out at almost the same instant in a 4-server cluster. Each votes for itself, and the other two servers vote for whichever RequestVote reaches them first. A majority needs 3 votes.',
  version: 'basic',
  nodes: 4,
  seed: 2,
  setup: (sim) => sim.setTimers({ S1: 100, S2: 101, S3: 2000, S4: 2000 }),
  steps: [
    {
      title: 'Two candidates',
      text: 'Both S1 and S2 become candidates in term 1. Each one has already used its own vote, so each rejects the other.',
      until: (sim) => node(sim, 'S1').role === 'candidate' && node(sim, 'S2').role === 'candidate',
      focus: 'timeout',
    },
    {
      title: 'Votes are split',
      text: 'S3 and S4 vote for different candidates. Each candidate ends up with 2 of 4 votes — not a majority — so term 1 has no leader. Look at votedFor in each node.',
      until: (sim) => !inFlight(sim, 'RequestVote') && !inFlight(sim, 'RequestVoteReply'),
      focus: 'voteReply',
    },
    {
      title: 'Randomization breaks the tie',
      text: 'The candidates wait for a new random timeout. One of them almost always fires first, starts term 2 and wins before the other wakes up. This is why Raft randomizes timeouts (§5.2).',
      run: (sim) => sim.setTimers({ S3: 3000, S4: 3000 }),
      until: (sim) => anyRole(sim, 'leader'),
      focus: 'timeout',
    },
  ],
}

const staleCandidate: Scenario = {
  id: 'stale-candidate',
  category: 'Elections',
  title: 'A candidate with a stale log loses',
  summary: 'S3 missed two committed entries. It times out first, but nobody votes for it.',
  intro:
    'S3 was down while the leader S1 committed entries 1–2, so its log is empty. Next, S3 comes back exactly when S1 crashes, and S3 is the first to time out. If S3 won, the committed entries would be lost.',
  version: 'basic',
  nodes: 5,
  seed: 7,
  // with the §6 guard the others would silently ignore S3 (they heard from S1 a moment ago)
  settings: { disruptionGuard: false },
  setup: (sim) => {
    elect(sim, 'S1')
    sim.crash('S3')
    commitWrites(sim, [['x', '1'], ['y', '2']])
  },
  steps: [
    {
      title: 'S3 returns, the leader crashes',
      text: 'At the same moment S3 restarts (empty log) and S1 crashes. S3 times out first, moves to term 2 and asks for votes with lastLogIndex = 0. The others compare: their last entry has term 1 and index 2, which is more up-to-date. Watch the up-to-date condition in RequestVote evaluate to false.',
      run: (sim) => {
        sim.crash('S1')
        sim.restart('S3')
        sim.setTimers({ S3: 30, S2: 400, S4: 900, S5: 900 })
      },
      until: (sim) => node(sim, 'S3').role === 'candidate' && !inFlight(sim, 'RequestVote') && !inFlight(sim, 'RequestVoteReply'),
      focus: 'requestVote',
    },
    {
      title: 'An up-to-date server wins',
      text: 'The rejections still moved everyone to term 2, but S3 cannot win. S2 times out next with a complete log and gets the votes. This is the election restriction (§5.4.1): a leader always holds every committed entry.',
      until: (sim) => leaderOtherThan(sim, 'S3'),
      focus: 'requestVote',
    },
    {
      title: 'S3 catches up',
      text: 'The new leader repairs S3’s log with AppendEntries. Nothing committed was lost.',
      until: (sim) => settled(sim),
      focus: 'appendEntries',
    },
  ],
}

const termInflation: Scenario = {
  id: 'term-inflation',
  category: 'Elections',
  title: 'An isolated server disrupts the cluster',
  summary: 'A partitioned server keeps incrementing its term; when it comes back it forces the leader to step down. Then replay it with Pre-Vote.',
  intro:
    'S1 leads a healthy cluster. S5 is about to be cut off from everyone. It will not hear heartbeats, so it will time out again and again, each time with a higher term.',
  version: 'clients',
  nodes: 5,
  seed: 3,
  setup: (sim) => elect(sim, 'S1'),
  steps: [
    {
      title: 'S5 is isolated',
      text: 'S5 times out, becomes a candidate, gets no votes and retries — term after term. Meanwhile the majority keeps working: S1 commits a new entry that S5 does not have.',
      run: (sim) => {
        sim.setPartition([['S5'], ['S1', 'S2', 'S3', 'S4']])
        sim.propose('S1', { op: 'set', key: 'x', value: '1' })
      },
      until: (sim) => node(sim, 'S5').currentTerm >= node(sim, 'S1').currentTerm + 4,
      maxTime: 5000,
      focus: 'timeout',
    },
    {
      title: 'The partition heals',
      text: 'S5 rejoins with a much higher term. The leader’s next AppendEntries gets a reply with that term, so S1 steps down (“if term > currentTerm: become follower”). S5 cannot win (its log is behind), so the only effect is a useless election: the cluster has no leader until a new one (maybe S1 again) is elected in an even higher term.',
      run: (sim) => sim.setPartition(null),
      until: (sim) => {
        const l = sim.leader()
        return !!l && l.currentTerm > node(sim, 'S1').currentTerm - 1 && l.currentTerm >= node(sim, 'S5').currentTerm
      },
      maxTime: 5000,
      focus: 'appendReply',
    },
    {
      title: 'Replay with Pre-Vote',
      text: 'Back to the start, now with Pre-Vote on. Before incrementing its term, S5 asks “would you vote for me?”. Nobody answers, so its term never changes.',
      rewindTo: -1,
      branch: 'With Pre-Vote',
      run: (sim) => {
        sim.updateSettings({ preVote: true })
        sim.setPartition([['S5'], ['S1', 'S2', 'S3', 'S4']])
        sim.propose('S1', { op: 'set', key: 'x', value: '1' })
      },
      maxTime: 2500,
      focus: 'preVote',
    },
    {
      title: 'Heal: no disruption',
      text: 'When the partition heals S5 is still in the leader’s term. It simply accepts S1’s heartbeats and catches up. The leader never stepped down.',
      run: (sim) => sim.setPartition(null),
      until: (sim) => settled(sim) && isLeader(sim, 'S1'),
      focus: 'appendEntries',
    },
  ],
}

// ------------------------------------------------------------------ replication

const laggingFollower: Scenario = {
  id: 'lagging-follower',
  category: 'Replication',
  title: 'Repairing a lagging follower',
  summary: 'A follower missed 8 entries. Watch nextIndex walk back one entry per round trip — then replay with fast backup.',
  intro:
    'S3 was down while 8 entries were committed, and then S2 became the new leader. A new leader optimistically sets nextIndex = 9 for everyone, so its first AppendEntries to S3 carries prevLogIndex = 8. S3 does not have entry 8: the consistency check fails.',
  version: 'basic',
  nodes: 3,
  seed: 5,
  setup: (sim) => {
    elect(sim, 'S1')
    sim.crash('S3')
    commitWrites(sim, Array.from({ length: 8 }, (_, i) => ['k', String(i + 1)] as [string, string]))
    sim.transferLeadership('S2')
    fastForward(sim, () => isLeader(sim, 'S2') && settled(sim))
  },
  steps: [
    {
      title: 'S3 restarts',
      text: 'Each rejection makes S2 decrement nextIndex[S3] by one and retry. Follow nextIndex in the leader’s inspector and the prevLogIndex of each AppendEntries.',
      run: (sim) => sim.restart('S3'),
      until: (sim) => lastIndex(sim, 'S3') === lastIndex(sim, 'S2'),
      maxTime: 5000,
      focus: 'appendReply',
    },
    {
      title: 'Replay with fast backup',
      text: 'Same situation with fast backup: S3 answers “my log ends at index 0” (conflictIndex), and S2 jumps straight there. One round trip instead of eight.',
      rewindTo: -1,
      branch: 'With fast backup',
      run: (sim) => {
        sim.updateSettings({ fastBackup: true })
        sim.restart('S3')
      },
      until: (sim) => lastIndex(sim, 'S3') === lastIndex(sim, 'S2'),
      maxTime: 5000,
      focus: 'appendReply',
    },
  ],
}

const oldLeader: Scenario = {
  id: 'old-leader',
  category: 'Replication',
  title: 'An old leader in the minority',
  summary: 'A partition leaves the leader with only one follower. It keeps accepting writes that can never commit.',
  intro: 'S1 leads 5 servers. The network splits into {S1, S2} and {S3, S4, S5}.',
  version: 'clients',
  nodes: 5,
  seed: 8,
  setup: (sim) => elect(sim, 'S1'),
  steps: [
    {
      title: 'Partition',
      text: 'The majority side stops hearing heartbeats and elects a new leader in a higher term. S1 does not know: it still thinks it is the leader of the old term.',
      run: (sim) => sim.setPartition([['S1', 'S2'], ['S3', 'S4', 'S5']]),
      until: (sim) => ['S3', 'S4', 'S5'].some((id) => isLeader(sim, id)),
      focus: 'timeout',
    },
    {
      title: 'Two leaders, two terms',
      text: 'Both leaders receive a write. The new one replicates to a majority and commits. The old one can only reach S2 — 2 of 5 — so its entry stays uncommitted forever. Election Safety holds: there is at most one leader per term.',
      run: (sim) => {
        sim.propose('S1', { op: 'set', key: 'x', value: 'old' })
        const l = ['S3', 'S4', 'S5'].find((id) => isLeader(sim, id))!
        sim.propose(l, { op: 'set', key: 'x', value: 'new' })
      },
      maxTime: 800,
      focus: 'commit',
    },
    {
      title: 'Heal',
      text: 'S1 sees the higher term, steps down, and its uncommitted entry is overwritten by the new leader’s log. A client that wrote to S1 never got a reply, so nothing it was told was lost.',
      run: (sim) => sim.setPartition(null),
      until: (sim) => !isLeader(sim, 'S1') && settled(sim),
      focus: 'appendEntries',
    },
    {
      title: 'Replay with CheckQuorum',
      text: 'Back to the start, with CheckQuorum on: a leader that has not heard from a majority within an election timeout steps down by itself. S1 stops accepting writes instead of pretending to lead.',
      rewindTo: -1,
      branch: 'With CheckQuorum',
      run: (sim) => {
        sim.updateSettings({ checkQuorum: true })
        sim.setPartition([['S1', 'S2'], ['S3', 'S4', 'S5']])
      },
      until: (sim) => !isLeader(sim, 'S1'),
      focus: 'checkQuorum',
    },
  ],
}

// ------------------------------------------------------------------ safety

const figure8: Scenario = {
  id: 'figure-8',
  category: 'Safety',
  title: 'Figure 8: why old-term entries are not committed by counting',
  summary: 'The famous sequence from the paper, step by step — and what goes wrong if the rule is removed.',
  intro:
    'Five servers; entry 1 (term 1) is committed everywhere and S1 is leader of term 2. Follow the log table: colors are terms. The question is when entry 2 is really committed.',
  version: 'basic',
  nodes: 5,
  seed: 2,
  // the §6 guard (ignore RequestVote while a leader is alive) would only add failed rounds here
  settings: { disruptionGuard: false },
  setup: (sim) => {
    elect(sim, 'S2')
    commitWrites(sim, [['x', '1']])
    sim.transferLeadership('S1')
    fastForward(sim, () => isLeader(sim, 'S1') && settled(sim))
  },
  steps: [
    {
      title: '(a) S1 replicates entry 2 to S2 only',
      text: 'S1 (term 2) receives x=2 at index 2, but only S2 gets it before trouble starts.',
      run: (sim) => {
        sim.setPartition([['S1', 'S2'], ['S3', 'S4', 'S5']])
        sim.setTimers({ S3: 5000, S4: 5000, S5: 5000 })
        sim.propose('S1', { op: 'set', key: 'x', value: '2' })
      },
      until: (sim) => lastIndex(sim, 'S2') === 2 && quiet(sim, 'S1'),
      focus: 'replicate',
    },
    {
      title: '(b) S1 crashes; S5 wins term 3',
      text: 'S5 is elected with votes from S3, S4 and itself (S2 refuses: its log is more up-to-date). S5 accepts a different entry, x=3, at index 2 — then gets cut off before replicating it.',
      run: (sim) => {
        sim.crash('S1')
        sim.setPartition(null)
        sim.setTimers({ S5: 30, S2: 3000, S3: 3000, S4: 3000 })
      },
      until: (sim) => isLeader(sim, 'S5'),
      after: (sim) => {
        sim.setPartition([['S5'], ['S1', 'S2', 'S3', 'S4']])
        sim.propose('S5', { op: 'set', key: 'x', value: '3' })
      },
      focus: 'requestVote',
    },
    {
      title: '(c) S5 crashes; S1 returns and wins term 4',
      text: 'S1 restarts and is elected (term 3 fails, term 4 succeeds). It continues replicating its entry 2 (term 2): now it is on S1, S2, S3 — a majority. Is it committed? Look at the commit procedure: log[2].term = 2 ≠ currentTerm 4, so S1 does NOT advance commitIndex.',
      run: (sim) => {
        sim.crash('S5')
        sim.setPartition(null)
        sim.restart('S1')
        sim.setTimers({ S1: 30, S2: 3000, S3: 3000, S4: 3000 })
      },
      until: (sim) => isLeader(sim, 'S1') && termOf(sim, 'S3', 2) === 2 && termOf(sim, 'S4', 2) === 2 && quiet(sim, 'S1'),
      focus: 'commit',
    },
    {
      title: '(d) S1 crashes; S5 overwrites entry 2',
      text: 'S5’s last entry has term 3 > 2, so S2, S3 and S4 consider its log more up-to-date and vote for it in a new term. S5 replaces entry 2 everywhere with its own x=3. This is fine only because entry 2 was never committed — which is exactly why S1 refused to commit it in (c).',
      run: (sim) => {
        sim.crash('S1')
        sim.restart('S5')
        sim.setTimers({ S5: 30, S2: 3000, S3: 3000, S4: 3000 })
      },
      until: (sim) => isLeader(sim, 'S5') && termOf(sim, 'S2', 2) === 3 && termOf(sim, 'S3', 2) === 3,
      maxTime: 4000,
      focus: 'appendEntries',
    },
    {
      title: '(e) Alternative: S1 commits an entry of its own term',
      text: 'Rewind to (c). This time S1 replicates a new entry 3 from term 4 to a majority. Once entry 3 is committed, entry 2 is committed with it (Log Matching). Now S5 can never be elected: a majority has a log ending in term 4.',
      rewindTo: 2,
      branch: '(e) own-term entry',
      run: (sim) => sim.propose('S1', { op: 'set', key: 'x', value: '4' }),
      until: (sim) => node(sim, 'S1').commitIndex >= 3 && quiet(sim, 'S1'),
      focus: 'commit',
    },
    {
      title: '(e) S1 crashes; S5 cannot win',
      text: 'S5 restarts and asks for votes, but S2 and S3 have term-4 entries and refuse. A server with the committed entries wins instead.',
      run: (sim) => {
        sim.crash('S1')
        sim.restart('S5')
        sim.setTimers({ S5: 30, S2: 1200, S3: 3000, S4: 3000 })
      },
      until: (sim) => leaderOtherThan(sim, 'S5', 'S1'),
      maxTime: 4000,
      focus: 'requestVote',
    },
    {
      title: 'Unsafe: count replicas of old entries',
      text: 'Rewind to (c) again, now with the current-term rule switched off. S1 sees entry 2 on a majority and commits it — x=2 is applied and would be acknowledged to a client.',
      rewindTo: 2,
      branch: 'unsafe rule',
      run: (sim) => sim.updateSettings({ unsafeCommitOldTerms: true }),
      until: (sim) => node(sim, 'S1').commitIndex >= 2 && quiet(sim, 'S1'),
      focus: 'commit',
    },
    {
      title: 'Unsafe: a committed entry disappears',
      text: 'S1 crashes and S5 is elected exactly as in (d), overwriting the “committed” entry 2 with x=3. Different servers apply different commands at index 2: the invariant checker reports the violation.',
      run: (sim) => {
        sim.crash('S1')
        sim.restart('S5')
        sim.setTimers({ S5: 30, S2: 3000, S3: 3000, S4: 3000 })
      },
      until: (sim) => sim.s.oracle.violations.length > 0 && termOf(sim, 'S3', 2) === 3,
      maxTime: 5000,
      focus: 'commit',
    },
  ],
}

// ------------------------------------------------------------------ membership

const addServer: Scenario = {
  id: 'add-server',
  category: 'Membership',
  title: 'Adding a server with joint consensus',
  summary: 'A new server catches up as a learner, then the cluster moves through C_old,new to C_new.',
  intro:
    'Three servers with a few committed entries. We add S4. Switching every server to the new configuration at once is unsafe (two majorities could exist), so Raft goes through a joint configuration (§6).',
  version: 'clients',
  nodes: 3,
  seed: 13,
  setup: (sim) => {
    elect(sim, 'S1')
    commitWrites(sim, [['x', '1'], ['y', '2'], ['z', '3']])
  },
  steps: [
    {
      title: 'S4 joins as a learner',
      text: 'S4 starts with an empty log. The leader replicates to it, but S4 does not vote and does not count for commits until it has caught up — otherwise the cluster could stall waiting for it.',
      run: (sim) => sim.addServer(),
      until: (sim) => lastIndex(sim, 'S4') >= 4 && !!latestConfig(node(sim, 'S1')).newVoters,
      focus: 'config',
    },
    {
      title: 'C_old,new',
      text: 'The leader appends the joint configuration. From now on every decision (elections and commits) needs a majority of {S1,S2,S3} AND a majority of {S1,S2,S3,S4}. Servers use the latest configuration in their log, committed or not.',
      until: (sim) => {
        const l = node(sim, 'S1')
        return l.commitIndex >= latestConfigIndex(l) && !latestConfig(l).newVoters
      },
      focus: 'config',
    },
    {
      title: 'C_new',
      text: 'Once C_old,new is committed, the leader appends C_new = {S1..S4}. When it commits, the change is done.',
      until: (sim) => settled(sim),
      focus: 'config',
    },
  ],
}

// ------------------------------------------------------------------ clients

const exactlyOnce: Scenario = {
  id: 'exactly-once',
  category: 'Clients & snapshots',
  title: 'Exactly-once despite a lost reply',
  summary: 'The leader commits x=1 but the reply to the client is lost. The client retries — the command is not applied twice.',
  intro:
    'The client sends “SET x=1” with (clientId, seq=1). Every server remembers the last seq it applied for each client — the session table, part of the state machine (§8).',
  version: 'clients',
  nodes: 3,
  seed: 21,
  setup: (sim) => elect(sim, 'S1'),
  steps: [
    {
      title: 'Commit, then lose the reply',
      text: 'The leader appends, replicates and applies x=1, then replies. That reply is dropped on the way.',
      run: (sim) => sim.clientRequest({ op: 'set', key: 'x', value: '1' }),
      until: (sim) => sim.s.messages.some((m) => m.type === 'ClientReply'),
      after: (sim) => {
        const m = sim.s.messages.find((x) => x.type === 'ClientReply')
        if (m) sim.dropMessage(m.id)
      },
      focus: 'client',
    },
    {
      title: 'The client retries',
      text: 'After its timeout the client sends the same (clientId, seq=1) again. The leader finds seq 1 in its session table and answers with the cached result instead of appending a second entry.',
      until: (sim) => sim.s.client.ops.every((o) => o.status === 'ok'),
      focus: 'client',
    },
  ],
}

export const SCENARIOS: Scenario[] = [firstElection, splitVote, staleCandidate, termInflation, laggingFollower, oldLeader, figure8, addServer, exactlyOnce]
