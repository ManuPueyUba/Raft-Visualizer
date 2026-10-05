/** Pseudocode shown in the UI. Every line has an id; the simulation emits
 *  trace steps referencing these ids so the UI can highlight what runs. */

export interface PseudoLine {
  id: string
  text: string
  indent: number
  note?: string // short margin note (paper reference, rule number)
}

export interface Procedure {
  id: string
  title: string
  who: string
  ref: string
  lines: PseudoLine[]
  explain: string
}

const L = (id: string, indent: number, text: string, note?: string): PseudoLine => ({ id, indent, text, note })

export const PROCEDURES: Procedure[] = [
  {
    id: 'timeout',
    title: 'Election timeout',
    who: 'Followers & candidates',
    ref: 'Figure 2 · Rules for Servers · §5.2',
    lines: [
      L('t.1', 0, 'on election timeout elapsed:'),
      L('t.2', 1, 'if self ∉ latest configuration: return', '§6'),
      L('t.3', 1, 'if preVote enabled: run Pre-Vote first', 'opt.'),
      L('t.4', 1, 'currentTerm ← currentTerm + 1'),
      L('t.5', 1, 'state ← candidate'),
      L('t.6', 1, 'votedFor ← self'),
      L('t.7', 1, 'reset election timer to random ∈ [min, max]'),
      L('t.8', 1, 'send RequestVote RPCs to all other servers'),
      L('t.9', 1, 'if votes form a majority: become leader', 'single node'),
    ],
    explain: `A follower stays a follower as long as it keeps hearing from a valid leader (AppendEntries) or granting votes. If it hears nothing for a whole election timeout, it assumes there is no viable leader and starts an election.

The timeout is RANDOMIZED (e.g. 150–300 ms in the paper). This is the key trick that makes elections converge: usually one server times out first, wins the election and sends heartbeats before anybody else times out. If two candidates split the vote, both time out again with new random values and one of them will very likely be first next time.

Each term has at most one leader, because each server votes at most once per term (votedFor is persisted on disk).`,
  },
  {
    id: 'requestVote',
    title: 'RequestVote RPC (receiver)',
    who: 'Any server',
    ref: 'Figure 2 · RequestVote RPC · §5.2, §5.4.1',
    lines: [
      L('rv.1', 0, 'on RequestVote(term, candidateId, lastLogIndex, lastLogTerm):'),
      L('rv.2', 1, 'if heard from a leader < min election timeout ago: ignore', '§6'),
      L('rv.3', 1, 'if term > currentTerm: currentTerm ← term, votedFor ← null, state ← follower', 'all servers'),
      L('rv.4', 1, 'if term < currentTerm: reply false', '1.'),
      L('rv.5', 1, 'upToDate ← lastLogTerm > myLastTerm ∨ (lastLogTerm = myLastTerm ∧ lastLogIndex ≥ myLastIndex)', '§5.4.1'),
      L('rv.6', 1, 'if (votedFor = null ∨ votedFor = candidateId) ∧ upToDate:', '2.'),
      L('rv.7', 2, 'votedFor ← candidateId; reset election timer'),
      L('rv.8', 2, 'reply true'),
      L('rv.9', 1, 'else: reply false'),
    ],
    explain: `A server grants its vote if (1) the candidate's term is not stale, (2) it has not already voted for somebody else in this term, and (3) the candidate's log is at least as up-to-date as its own.

Rule (3) is the ELECTION RESTRICTION (§5.4.1). "Up-to-date" compares the last entries: the higher last term wins; if the last terms are equal, the longer log wins. Since a committed entry is stored on a majority, and the candidate needs votes from a majority, the two majorities overlap in at least one server, and that server refuses to vote for a candidate missing the entry. So a leader always has every committed entry (Leader Completeness).

The first line implements §6's protection against disruptive servers: if a server believes a current leader exists (it heard from it recently), it ignores RequestVote. Otherwise a removed server, which no longer gets heartbeats, would keep timing out and force new elections with higher terms.`,
  },
  {
    id: 'voteReply',
    title: 'RequestVote reply (candidate)',
    who: 'Candidates',
    ref: 'Figure 2 · Rules for Servers · Candidates',
    lines: [
      L('vr.1', 0, 'on RequestVote reply (term, voteGranted):'),
      L('vr.2', 1, 'if term > currentTerm: currentTerm ← term, state ← follower; return', 'all servers'),
      L('vr.3', 1, 'if state ≠ candidate ∨ term ≠ currentTerm: ignore (stale reply)'),
      L('vr.4', 1, 'if voteGranted: votes ← votes ∪ {from}'),
      L('vr.5', 1, 'if votes form a majority of the configuration: become leader'),
    ],
    explain: `A candidate becomes leader as soon as it collects votes from a majority of the servers of the configuration (in joint consensus, a majority of C_old AND a majority of C_new).

Replies can arrive late, after the candidate has moved on to a later term or already won, so replies from older terms are ignored. Any message with a higher term immediately turns the server back into a follower: some other server is ahead.`,
  },
  {
    id: 'becomeLeader',
    title: 'Become leader',
    who: 'Newly elected leader',
    ref: 'Figure 2 · Leaders · §8',
    lines: [
      L('bl.1', 0, 'become leader:'),
      L('bl.2', 1, 'for each server: nextIndex ← lastLogIndex + 1, matchIndex ← 0'),
      L('bl.3', 1, 'append a no-op entry with the current term', '§8'),
      L('bl.4', 1, 'send initial AppendEntries (heartbeat) to each server'),
    ],
    explain: `The new leader starts optimistic: it assumes every follower's log matches its own (nextIndex = its last index + 1) and lets the consistency check of AppendEntries find out where each log diverges. matchIndex starts at 0 because nothing is known to be replicated yet.

The no-op entry (§8) matters: a leader can only count replicas to commit entries from ITS OWN term (§5.4.2). Committing the no-op commits everything before it, and tells the leader what the commit index really is, which is needed to serve linearizable reads.`,
  },
  {
    id: 'replicate',
    title: 'Send AppendEntries / heartbeats',
    who: 'Leader',
    ref: 'Figure 2 · Leaders · §5.3, §7',
    lines: [
      L('rp.1', 0, 'on heartbeat timer or new entries (leader):'),
      L('rp.2', 1, 'for each follower f:'),
      L('rp.3', 2, 'if nextIndex[f] ≤ snapshot.lastIndex: send InstallSnapshot; continue', '§7'),
      L('rp.4', 2, 'prevLogIndex ← nextIndex[f] − 1; prevLogTerm ← log[prevLogIndex].term'),
      L('rp.5', 2, 'entries ← log[nextIndex[f] …] (at most batch size)'),
      L('rp.6', 2, 'send AppendEntries(term, prevLogIndex, prevLogTerm, entries, leaderCommit)'),
      L('rp.7', 1, 'reset heartbeat timer'),
    ],
    explain: `The leader sends AppendEntries to every follower. An AppendEntries with no entries is a HEARTBEAT: it tells followers the leader is alive so they don't start elections. The heartbeat interval must be much smaller than the election timeout.

Each RPC carries prevLogIndex/prevLogTerm: the index and term of the entry right before the new ones. The follower only accepts the entries if it has that exact entry. This is how logs are kept consistent.

If the follower is so far behind that the needed entries were already compacted into a snapshot, the leader sends its snapshot instead (InstallSnapshot, §7).`,
  },
  {
    id: 'appendEntries',
    title: 'AppendEntries RPC (receiver)',
    who: 'Followers',
    ref: 'Figure 2 · AppendEntries RPC · §5.3',
    lines: [
      L('ae.1', 0, 'on AppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommit):'),
      L('ae.2', 1, 'if term > currentTerm: currentTerm ← term, votedFor ← null', 'all servers'),
      L('ae.3', 1, 'if term < currentTerm: reply false', '1.'),
      L('ae.4', 1, 'state ← follower; leaderId ← leaderId; reset election timer'),
      L('ae.5', 1, 'if log has no entry at prevLogIndex with term prevLogTerm: reply false', '2.'),
      L('ae.6', 1, 'if an existing entry conflicts with a new one (same index, different term): delete it and all that follow', '3.'),
      L('ae.7', 1, 'append any new entries not already in the log', '4.'),
      L('ae.8', 1, 'if leaderCommit > commitIndex: commitIndex ← min(leaderCommit, index of last new entry)', '5.'),
      L('ae.9', 1, 'reply true'),
    ],
    explain: `This RPC both replicates entries and acts as heartbeat.

The CONSISTENCY CHECK (step 2) gives the LOG MATCHING property: if two logs contain an entry with the same index and term, the logs are identical up to that entry. By induction: the leader creates at most one entry per index in a term, and a follower only appends after verifying it has the preceding entry.

If the check fails the follower answers false and the leader retries with an earlier prevLogIndex. When it finally matches, conflicting entries in the follower (from a deposed leader, never committed) are deleted and replaced (step 3). Committed entries can never conflict, so they are never deleted.

Step 5 lets followers learn which entries are committed so they can apply them to their state machines.`,
  },
  {
    id: 'appendReply',
    title: 'AppendEntries reply (leader)',
    who: 'Leader',
    ref: 'Figure 2 · Leaders · §5.3',
    lines: [
      L('ar.1', 0, 'on AppendEntries reply from f:'),
      L('ar.2', 1, 'if term > currentTerm: currentTerm ← term, state ← follower; return', 'all servers'),
      L('ar.3', 1, 'if state ≠ leader ∨ term ≠ currentTerm: ignore (stale)'),
      L('ar.4', 1, 'if success: matchIndex[f] ← max(matchIndex[f], match); nextIndex[f] ← matchIndex[f] + 1'),
      L('ar.5', 1, 'else if fast backup: nextIndex[f] ← lastIndexOf(conflictTerm) + 1 or conflictIndex', 'opt.'),
      L('ar.6', 1, 'else: nextIndex[f] ← nextIndex[f] − 1'),
      L('ar.7', 2, 'retry AppendEntries to f'),
      L('ar.8', 1, 'advance commitIndex'),
    ],
    explain: `On success the leader knows f's log matches its own up to matchIndex[f].

On failure, the basic algorithm decrements nextIndex by one and retries, walking backwards until the logs match. This can take one round trip per missing entry.

FAST BACKUP (an optimization the paper mentions at the end of §5.3): the follower returns the term of its conflicting entry and the first index it stores for that term, so the leader can skip a whole term per round trip.`,
  },
  {
    id: 'commit',
    title: 'Advance commitIndex',
    who: 'Leader',
    ref: 'Figure 2 · Leaders · §5.3, §5.4.2',
    lines: [
      L('cm.1', 0, 'advance commitIndex (leader):'),
      L('cm.2', 1, 'find the largest N > commitIndex such that:'),
      L('cm.3', 2, 'a majority of servers have matchIndex ≥ N (joint: of C_old AND of C_new)'),
      L('cm.4', 2, 'and log[N].term = currentTerm', '§5.4.2'),
      L('cm.5', 1, 'commitIndex ← N'),
    ],
    explain: `An entry is COMMITTED once the leader that created it has replicated it on a majority. From then on it is durable: every future leader will have it.

Subtle rule (§5.4.2, Figure 8): a leader never commits an entry from a PREVIOUS term just by counting replicas. An old entry can be on a majority and still be overwritten by a later leader. Instead the leader commits an entry of its own term, and older entries get committed indirectly because of Log Matching. Turn on "Commit old-term entries" in the unsafe section to see a safety violation.`,
  },
  {
    id: 'apply',
    title: 'Apply to state machine',
    who: 'All servers',
    ref: 'Figure 2 · Rules for Servers · §8',
    lines: [
      L('ap.1', 0, 'while commitIndex > lastApplied:'),
      L('ap.2', 1, 'lastApplied ← lastApplied + 1'),
      L('ap.3', 1, 'if (clientId, seq) already applied: skip, reuse cached result', '§8'),
      L('ap.4', 1, 'else: apply log[lastApplied] to the state machine'),
      L('ap.5', 1, 'if leader and a client waits on this entry: reply to client'),
    ],
    explain: `Every server applies committed entries in log order to its own state machine (here, a key-value store). Since all logs agree on committed entries, every state machine goes through the same sequence of states (State Machine Safety).

Client requests carry a unique (clientId, seq). If a leader crashes after committing but before replying, the client retries, and the command may end up in the log twice. The state machine remembers the last seq applied per client and skips duplicates, giving exactly-once semantics (§8).`,
  },
  {
    id: 'snapshot',
    title: 'Take a snapshot',
    who: 'Each server independently',
    ref: '§7 · Log compaction',
    lines: [
      L('sn.1', 0, 'if lastApplied − snapshot.lastIndex ≥ threshold:'),
      L('sn.2', 1, 'snapshot ← (state machine, lastIncludedIndex = lastApplied, lastIncludedTerm, config)'),
      L('sn.3', 1, 'discard log entries up to lastIncludedIndex'),
    ],
    explain: `Logs can't grow forever. Each server independently takes a snapshot of its state machine covering only COMMITTED (applied) entries and throws away that prefix of the log.

The snapshot keeps the index and term of the last entry it replaces (needed for the consistency check of the next AppendEntries) and the latest configuration as of that index (needed for membership changes).`,
  },
  {
    id: 'installSnapshot',
    title: 'InstallSnapshot RPC (receiver)',
    who: 'Followers',
    ref: 'Figure 13 · §7',
    lines: [
      L('is.1', 0, 'on InstallSnapshot(term, leaderId, lastIncludedIndex, lastIncludedTerm, data):'),
      L('is.2', 1, 'if term < currentTerm: reply immediately', '1.'),
      L('is.3', 1, 'update term if needed; state ← follower; reset election timer'),
      L('is.4', 1, 'if lastIncludedIndex ≤ my snapshot.lastIndex: reply (already have it)'),
      L('is.5', 1, 'if existing entry has same index and term as lastIncluded: retain entries after it; reply', '6.'),
      L('is.6', 1, 'discard the entire log', '7.'),
      L('is.7', 1, 'reset state machine from snapshot contents (and load its config)', '8.'),
      L('is.8', 1, 'reply'),
    ],
    explain: `When a follower lags so much that the leader has already discarded the entries it needs, the leader sends its snapshot.

In the paper the snapshot is sent in chunks (offset, done); here it travels in one message for clarity. If the follower already has a prefix described by the snapshot (e.g. a retransmitted, older snapshot), it keeps the entries that follow. Otherwise the snapshot replaces everything: the follower's log is discarded and its state machine is reset.`,
  },
  {
    id: 'snapshotReply',
    title: 'InstallSnapshot reply (leader)',
    who: 'Leader',
    ref: '§7',
    lines: [
      L('sr.1', 0, 'on InstallSnapshot reply from f:'),
      L('sr.2', 1, 'if term > currentTerm: currentTerm ← term, state ← follower; return'),
      L('sr.3', 1, 'matchIndex[f] ← max(matchIndex[f], lastIncludedIndex); nextIndex[f] ← matchIndex[f] + 1'),
    ],
    explain: `After the follower installs the snapshot, the leader continues sending normal AppendEntries from the entry right after the snapshot.`,
  },
  {
    id: 'client',
    title: 'Client request',
    who: 'Leader (others redirect)',
    ref: '§8 · Client interaction',
    lines: [
      L('cl.1', 0, 'on ClientRequest(clientId, seq, command):'),
      L('cl.2', 1, 'if state ≠ leader: reply NOT_LEADER with leaderId hint'),
      L('cl.3', 1, 'if leadership transfer in progress: reject', 'opt.'),
      L('cl.4', 1, 'if seq already applied for clientId: reply cached result', '§8'),
      L('cl.5', 1, 'if read-only and readMode ≠ log: serve as linearizable read'),
      L('cl.6', 1, 'append command to local log'),
      L('cl.7', 1, 'replicate (now, or with the next heartbeat)'),
      L('cl.8', 1, 'reply after the entry is applied'),
    ],
    explain: `Clients send all requests to the leader. A client starts with a random server; a non-leader rejects the request and returns the most recent leader it knows. If the request times out (e.g. the leader crashed), the client retries with another server.

Requests are only answered once their entry is committed and applied, so an acknowledged write is never lost. Because of retries a command can be submitted twice; the unique (clientId, seq) pair makes the state machine apply it only once.`,
  },
  {
    id: 'read',
    title: 'Linearizable read-only query',
    who: 'Leader',
    ref: '§8 · Read-only operations',
    lines: [
      L('rd.1', 0, 'serve read-only query without writing to the log:'),
      L('rd.2', 1, 'if no entry from currentTerm is committed yet: wait (the no-op commits soon)'),
      L('rd.3', 1, 'readIndex ← commitIndex'),
      L('rd.4', 1, 'ReadIndex: send heartbeats and wait for a majority to ack (am I still leader?)'),
      L('rd.5', 1, 'Lease: skip the round if the lease (from the last majority ack) has not expired', 'opt.'),
      L('rd.6', 1, 'wait until lastApplied ≥ readIndex'),
      L('rd.7', 1, 'reply with the value from the state machine'),
    ],
    explain: `Reads could go through the log like writes (readMode = log), which is simple but slow. Answering directly from the leader's state machine is unsafe: the "leader" might have been deposed by a partition without knowing, and return stale data.

ReadIndex (§8): the leader (1) makes sure it knows the latest commit index (it has committed an entry of its term, the no-op), (2) records it as readIndex, (3) checks it is still the leader by exchanging heartbeats with a majority, and (4) answers once its state machine has applied up to readIndex.

LEASES skip step (3): after a majority acked a heartbeat sent at time t, no other leader can be elected before t + election timeout, so the leader can answer locally until then. This relies on bounded clock drift.`,
  },
  {
    id: 'config',
    title: 'Membership change (joint consensus)',
    who: 'Leader',
    ref: '§6 · Cluster membership changes',
    lines: [
      L('cf.1', 0, 'on membership change request (leader):'),
      L('cf.2', 1, 'add server: replicate to it as a non-voting learner until it catches up'),
      L('cf.3', 1, 'append C_old,new; each server uses it as soon as it is in its log'),
      L('cf.4', 1, 'once C_old,new is committed: append C_new'),
      L('cf.5', 1, 'once C_new is committed: servers not in C_new can be shut down'),
      L('cf.6', 1, 'if leader ∉ C_new: step down once C_new is committed'),
    ],
    explain: `Switching straight from C_old to C_new is unsafe: servers switch at different times, so for a moment a majority of C_old and a majority of C_new could exist at the same time, electing two leaders in one term.

Raft uses JOINT CONSENSUS: an intermediate configuration C_old,new where elections and commits need a majority of C_old AND a majority of C_new. Configurations are stored as log entries and take effect as soon as a server stores them (even uncommitted). Once C_old,new commits, neither C_old nor C_new can decide alone, and the leader safely appends C_new.

Extra details: new servers first catch up as non-voting members; a leader not included in C_new manages the cluster until C_new commits and then steps down; servers ignore RequestVotes while they hear from a leader so removed servers can't disrupt.`,
  },
  {
    id: 'preVote',
    title: 'Pre-Vote',
    who: 'Followers (optimization)',
    ref: 'Ongaro thesis §9.6',
    lines: [
      L('pv.1', 0, 'on election timeout (Pre-Vote enabled):'),
      L('pv.2', 1, 'state ← pre-candidate (currentTerm is NOT incremented)'),
      L('pv.3', 1, 'send RequestVote(preVote, term = currentTerm + 1) to all'),
      L('pv.4', 0, 'receiver: grant iff candidate log up-to-date ∧ no leader heard recently (term, votedFor unchanged)'),
      L('pv.5', 0, 'on majority of pre-votes: start a real election'),
    ],
    explain: `Problem: a server isolated by a partition keeps timing out and incrementing its term. When it reconnects, its huge term forces the current leader to step down, causing a useless election.

With Pre-Vote, a server first asks "would you vote for me?" without changing any state. Only if a majority says yes (they also lost contact with the leader and the candidate's log is up-to-date) does it increment its term and run the real election. The isolated server never gets pre-votes, so its term stays put.`,
  },
  {
    id: 'checkQuorum',
    title: 'CheckQuorum',
    who: 'Leader (optimization)',
    ref: 'Ongaro thesis §6.2',
    lines: [
      L('cq.1', 0, 'every election timeout (leader, CheckQuorum enabled):'),
      L('cq.2', 1, 'if a majority has not responded since the last check: step down'),
    ],
    explain: `A leader cut off from the majority by a partition would otherwise remain "leader" forever, accepting client requests that can never commit. With CheckQuorum it notices it lost contact with a majority and steps down, so clients go look for the real leader.`,
  },
  {
    id: 'transfer',
    title: 'Leadership transfer',
    who: 'Leader → target (optimization)',
    ref: 'Ongaro thesis §3.10',
    lines: [
      L('tr.1', 0, 'transfer leadership to target t:'),
      L('tr.2', 1, 'stop accepting new client requests'),
      L('tr.3', 1, 'replicate until matchIndex[t] = lastLogIndex'),
      L('tr.4', 1, 'send TimeoutNow to t'),
      L('tr.5', 0, 't on TimeoutNow: start an election immediately (bypasses the §6 guard)'),
      L('tr.6', 0, 'abort the transfer if it does not finish within an election timeout'),
    ],
    explain: `Useful to move leadership away from a server about to be shut down, or to a better placed server. The leader brings the target's log fully up to date and then tells it to time out right away. The target wins easily because it starts first and has an up-to-date log.`,
  },
]

export const PROC_BY_ID: Record<string, Procedure> = Object.fromEntries(PROCEDURES.map((p) => [p.id, p]))

export const LINE_PROC: Record<string, string> = Object.fromEntries(
  PROCEDURES.flatMap((p) => p.lines.map((l) => [l.id, p.id])),
)
