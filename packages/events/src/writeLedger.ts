/**
 * memory_write observer (TASK-002, PLAN-mem-loop-tuning). Rides the
 * plugin-ctx `tools/result` (emit; the frozen final outcome) and mirrors
 * every successful `memory_write` into the session's written-source
 * ledger (TASK-001 `noteWrittenSource`), so the recall flows can exclude
 * memories the session itself authored. The outcome is read from the
 * structured `result.value` the live emit carries
 * (`ToolExecutionSuccess.value: JsonValue`, verified against the
 * installed @deepseek-ai/dsh-tools 0.2.1-alpha.3 types), never by
 * parsing the rendered content text. Only the `written` kind records:
 * the refusal kinds (`read_required`, `stale`, `read_only_vault`,
 * `outside_notes`, `reserved_file`, `invalid_meta`) mean nothing was
 * written, and the key goes through `sourceKeyFor` so one ledger entry
 * matches the identity the recall flows derive from search results.
 * @module dsh-plugin-obsidian-mem/events/writeLedger
 */

import { TOOL_MEMORY_WRITE } from '../../core/lib/index.js'
import type { HookLogger, ToolResultEvents } from './host.js'
import { sourceKeyFor, type SessionRegistry } from './sessions.js'
import { asRecord, runGuarded } from './toolkit.js'

/** Dependencies of the plugin-ctx write observer (mount-owned). */
export interface WriteLedgerDeps {
  ctx: ToolResultEvents
  registry: SessionRegistry
  logger: HookLogger
}

/**
 * InstallWriteLedger registers the plugin-level `tools/result` observer
 * that feeds the per-session written-source ledger, keyed by the calling
 * agent's session (same registration shape as installMemoryToolWatch;
 * mounted from mountLifecycle). Answers the listener disposer.
 */
export function installWriteLedger(deps: WriteLedgerDeps): () => void {
  const off = deps.ctx.on('tools/result', (exec, result) => {
    // Emit dispatch runs listeners raw; nothing may escape this one.
    runGuarded(deps.logger, 'write-ledger observer', () => {
      if (exec.name !== TOOL_MEMORY_WRITE || result.isError) {
        return
      }
      const agent = exec.agent
      if (agent === undefined) {
        return
      }
      const written = writtenValueOf(result.value)
      if (written === null) {
        return
      }
      deps.registry.noteWrittenSource(String(agent.id), sourceKeyFor(written))
    })
    return undefined
  })
  return () => { off() }
}

// Type guard over the structured tool value: a `written` result carries
// the FINAL absolute note path and the owning vault root. Every other
// shape (refusal kinds, absent value, poisoned payloads) records nothing.
function writtenValueOf(value: unknown): { vault: string, source_path: string } | null {
  const record = asRecord(value)
  if (record === null || record['kind'] !== 'written') {
    return null
  }
  const path = record['path']
  const vault = record['vault']
  if (typeof path !== 'string' || typeof vault !== 'string') {
    return null
  }
  return { vault, source_path: path }
}
