/**
 * The `ctx.obsidianMem` Cordis service: the vault registry, embedder,
 * Milvus-Lite lifecycle, indexer manager, hybrid search, and the audit/dream
 * compaction engine behind the memory_* tools. Activation stays side-effect
 * free; `ensureMemoryAccess()` (TASK-030) provisions the default vault, the
 * database, and the collection lazily on the first memory access.
 *
 * In the scaffold this plugin is a placeholder that publishes nothing yet.
 * Phase 3 (TASK-020..024) and Phase 4 (TASK-030) build the service and its
 * `declare module '@deepseek-ai/cordis'` seam.
 * @module dsh-plugin-obsidian-mem/service
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-service'
export const inject: string[] = []

/**
 * Mount the obsidianMem seam. The scaffold registers nothing so the bundle
 * stays loadable; the service publication lands in TASK-030.
 */
export function apply(ctx: Context): void {
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
