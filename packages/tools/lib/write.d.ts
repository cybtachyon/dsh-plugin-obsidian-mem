/**
 * `memory_write`: creates or updates one memory note in a shared vault's
 * indexed note tree (the vault root itself). The guard ladder is the
 * contract, in order: target inside a registered vault, reserved protocol
 * file names refuse, read-only vaults refuse explicitly, plugin-internal
 * and other non-note paths refuse, and a rewrite of an existing file
 * requires a prior memory_read whose read-registry hash still matches the
 * on-disk bytes (changed-since-read refuses with a re-read instruction; a
 * path absent from disk is the only exemption). Frontmatter goes through
 * core validateMeta (errors are values, discipline nudges come back as
 * warnings); a new file's name is slugged from index_title with collision
 * suffixes, so the response reports the FINAL absolute path. The service's
 * applyWrite does the raw-merging atomic write and confirms the note on
 * disk; the reindex and the git commit settle asynchronously afterwards.
 * @module dsh-plugin-obsidian-mem/tools/write
 */
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
/** Bounds the guard ladder plus the atomic write; the process's first
 * call also bounds core provisioning. Index and git settle after return. */
export declare const WRITE_TIMEOUT_MS = 10000;
/** The description the model sees for `memory_write`. */
export declare const WRITE_DESCRIPTION = "Create or update one memory note in a shared vault (the vault root is the note root). Updating an existing file requires a prior memory_read of that exact path in this session; a path not on disk yet is written without one, and its filename is derived from index_title (the path you pass supplies the directory). Notes in read-only vaults are refused. The note is written atomically and confirmed on disk; indexing and the git commit settle asynchronously afterwards. The result reports the final absolute path and any discipline warnings.";
/** Parameter schema; every pairing and naming rule lives on its parameter. */
export declare const WRITE_PARAMETERS: JsonSchemaNode;
/** Closed output union keyed on kind. */
export declare const WRITE_OUTPUT: JsonSchemaNode;
/** The value one memory_write call returns. */
export type WriteValue = {
    kind: 'written';
    path: string;
    created: boolean;
    vault: string;
    warnings: string[];
    write_through: 'queued';
    notice?: string;
} | {
    kind: 'read_required';
    path: string;
    message: string;
    notice?: string;
} | {
    kind: 'stale';
    path: string;
    message: string;
    notice?: string;
} | {
    kind: 'read_only_vault';
    path: string;
    vault: string;
    message: string;
    notice?: string;
} | {
    kind: 'outside_notes';
    path: string;
    message: string;
    shared_vault_roots: string[];
    notice?: string;
} | {
    kind: 'reserved_file';
    path: string;
    message: string;
    notice?: string;
} | {
    kind: 'invalid_meta';
    path: string;
    errors: string[];
    notice?: string;
};
/** Execute one memory_write call; every expected refusal is a value. */
export declare function executeWrite(service: MemoryService, args: unknown): Promise<WriteValue>;
/** Model-facing rendering of one memory_write value. */
export declare function renderWrite(value: WriteValue): string;
/** Build the memory_write definition for one service seam. */
export declare function createWriteTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=write.d.ts.map
