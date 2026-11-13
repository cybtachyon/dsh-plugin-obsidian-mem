/**
 * The pure, framework-free domain model for the dsh Obsidian Mem plugin:
 * constants and intent strings, VaultConfig and the vault registry model, the
 * memory-note Markdown format, the heading-aware Markdown chunker, workspace
 * manifest reading, chunk-id hashing, and the deterministic wake-keyword
 * extraction shared by the service, tools, and lifecycle hooks.
 *
 * The package is a plain library, never a mounted plugin row: cordis.patch.yml
 * mounts only the service, ui, tools, and events halves, and consumers reach
 * this package through the bundle's `./core` export. It therefore carries no
 * cordis lifecycle and no @deepseek-ai imports.
 * @module dsh-plugin-obsidian-mem/core
 */

export * from './constants.js'
export * from './chunk.js'
export * from './idhash.js'
export * from './note.js'
export * from './vaults.js'
