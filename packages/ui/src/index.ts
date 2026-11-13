/**
 * The host web routes for the Obsidian Mem settings card: the
 * `/obsidian-mem/*` API the browser card calls to manage the vault registry
 * (paths, shared/readonly modes, re-index) and to read index and audit/dream
 * state.
 *
 * In the scaffold this plugin is a placeholder that registers no routes.
 * TASK-050 adds the route handlers against the `obsidianMem` seam.
 * @module dsh-plugin-obsidian-mem/ui
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-ui'
export const inject: string[] = []

/**
 * Mount the `/obsidian-mem/*` routes. The scaffold registers nothing; the
 * route handlers land in TASK-050.
 */
export function apply(ctx: Context): void {
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
