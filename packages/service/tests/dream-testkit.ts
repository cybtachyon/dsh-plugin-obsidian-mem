/**
 * Shared dream-launch test doubles (dream-launch TASK-005: one create()
 * builder for every launch assertion). The fake agents gateway records
 * create payloads, followups, and the call order, and its agent double
 * answers ownEvents with a scripted transcript; the session-record
 * builders name the turn/end shapes the failed-turn scan reads.
 */

import type { DreamAgentHandle, DreamAgentsGateway } from '../src/dream.ts'

export interface GatewayRecorder {
  gateway: DreamAgentsGateway
  created: Array<{ sessionId: string; agentOptions?: { provider?: string; model?: string }; meta?: { cwd?: string } }>
  followups: unknown[]
  calls: string[]
  disposed: number
}

export type SessionRecord = { type: string; data?: unknown }

// A real clean dream turn closes with reason kind 'completed' (verified
// against ~/.dsh/sessions transcripts); the double answers ownEvents with
// this unless a test scripts its own transcript.
export const CLEAN_TRANSCRIPT: SessionRecord[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

export function turnEndRecord(reason: Record<string, unknown>): SessionRecord {
  return { type: 'turn/end', data: { turn: 1, reason } }
}

export function failedTurnError(message: string): SessionRecord {
  return turnEndRecord({ kind: 'error', error: { message, code: 'UNKNOWN' } })
}

export function fakeGateway(options: {
  whenIdle?: () => Promise<void>
  /** Transcript the agent double's ownEvents answers with; defaults to a clean one. */
  sessionEvents?: SessionRecord[]
  /** Replaces the whole session slice; null omits it (TASK-003 defensive path). */
  session?: DreamAgentHandle['agent']['session'] | null
} = {}): GatewayRecorder {
  const recorder: GatewayRecorder = {
    created: [],
    followups: [],
    calls: [],
    disposed: 0,
    gateway: null as never,
  }
  recorder.gateway = {
    async create(createOptions) {
      recorder.created.push(createOptions)
      recorder.calls.push('create')
      const agent: DreamAgentHandle['agent'] = {
        followup: (message: unknown) => {
          recorder.calls.push('followup')
          recorder.followups.push(message)
          return undefined
        },
        whenIdle: async () => {
          recorder.calls.push('whenIdle')
          await (options.whenIdle?.() ?? Promise.resolve())
        },
      }
      if (options.session !== null) {
        agent.session = options.session ?? { ownEvents: () => options.sessionEvents ?? CLEAN_TRANSCRIPT }
      }
      return {
        agent,
        dispose: async () => {
          recorder.calls.push('dispose')
          recorder.disposed += 1
        },
      }
    },
  }
  return recorder
}
