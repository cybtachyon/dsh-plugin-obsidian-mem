/**
 * The pure, framework-free domain model for the dsh Obsidian Mem plugin:
 * constants and intent strings, VaultConfig and the vault registry model, the
 * memory-note Markdown format, the heading-aware Markdown chunker, workspace
 * manifest reading, chunk-id hashing, and the deterministic wake-keyword
 * extraction shared by the service, tools, and lifecycle hooks.
 *
 * In the scaffold this plugin is a placeholder that carries no domain code.
 * Phase 2 (TASK-010..016) replaces the body with the real model and drops this
 * plugin stub if the package stays mount-free.
 * @module dsh-plugin-obsidian-mem/core
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'obsidian-mem-core'
export const inject: string[] = []

/**
 * Mount the core domain contributions. The scaffold registers nothing; the
 * domain model lands in Phase 2 as plain exports, not lifecycle code.
 */
export function apply(ctx: Context): void {
  void ctx
}

const plugin = { name, inject, apply }
export default plugin
