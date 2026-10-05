import type { MessageType, Role } from '../sim/types'

export const ROLE_COLOR: Record<Role, string> = {
  follower: '#94a3b8',
  precandidate: '#fde68a',
  candidate: '#fbbf24',
  leader: '#34d399',
}

export const ROLE_LABEL: Record<Role, string> = {
  follower: 'Follower',
  precandidate: 'Pre-candidate',
  candidate: 'Candidate',
  leader: 'Leader',
}

const TERM_HUES = [215, 160, 35, 285, 0, 190, 95, 320, 55, 250, 130, 15]

/** A stable color per term, used for log entries and term badges. */
export function termColor(term: number, alpha = 1): string {
  if (term <= 0) return `hsla(220, 10%, 45%, ${alpha})`
  const h = TERM_HUES[(term - 1) % TERM_HUES.length]
  return `hsla(${h}, 70%, 62%, ${alpha})`
}

export const MSG_STYLE: Record<MessageType, { color: string; label: string; short: string }> = {
  RequestVote: { color: '#c084fc', label: 'RequestVote', short: 'RV' },
  RequestVoteReply: { color: '#c084fc', label: 'RequestVote reply', short: 'RV✓' },
  AppendEntries: { color: '#60a5fa', label: 'AppendEntries', short: 'AE' },
  AppendEntriesReply: { color: '#60a5fa', label: 'AppendEntries reply', short: 'AE✓' },
  InstallSnapshot: { color: '#fb923c', label: 'InstallSnapshot', short: 'IS' },
  InstallSnapshotReply: { color: '#fb923c', label: 'InstallSnapshot reply', short: 'IS✓' },
  TimeoutNow: { color: '#f472b6', label: 'TimeoutNow', short: 'TN' },
  ClientRequest: { color: '#facc15', label: 'Client request', short: 'REQ' },
  ClientReply: { color: '#facc15', label: 'Client reply', short: 'REP' },
}

export const isReply = (t: MessageType) => t.endsWith('Reply')
