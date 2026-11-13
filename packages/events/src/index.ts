/**
 * The lifecycle hooks for the Obsidian Mem capability: turn-start recall
 * injection through the per-agent channel, the Read-tool intercept, the
 * Think-stream keyword intercept, the turn-end save/audit reminder, and the
 * global per-session recall budget that caps what all of them inject.
 *
 * In the scaffold this plugin is a no-op placeholder that declares the seam
 * injection so the bundle loads inertly. Phase 5 (TASK-040..045) wires the
 * session tracking, injections, and budget.
 * @module dsh-plugin-obsidian-mem/events
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-events'
export const inject = ['obsidianMem']

/**
 * Mount the lifecycle hooks. The scaffold subscribes to nothing so the bundle
 * stays loadable; the event wiring lands in Phase 5.
 */
export function apply(ctx: Context): void {
  // Session tracking, recall injection, and the turn-end reminder land here.
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
