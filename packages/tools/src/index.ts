/**
 * The model-facing tools for the Obsidian Mem capability: `memory_read`,
 * `memory_search`, `memory_write`, `memory_dream`, and `memory_audit`, each
 * registered with its own timeout budget, plus the system-prompt section that
 * tells the agent when to reach for them.
 *
 * In the scaffold this plugin is a no-op placeholder that declares the seam
 * injection so the bundle loads with zero tools. Phase 4 (TASK-031..036)
 * registers the five tools and the prompt section.
 * @module dsh-plugin-obsidian-mem/tools
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-tools'
export const inject = ['obsidianMem']

/**
 * Mount the model-facing tools. The scaffold registers nothing so the bundle
 * stays loadable; the tool registrations land in Phase 4.
 */
export function apply(ctx: Context): void {
  // Tools register their memory_* entries and prompt section here.
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
