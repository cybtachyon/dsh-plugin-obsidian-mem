/**
 * `memory_read`: reads one memory note verbatim and returns it inside the
 * core recalled-memory envelope (whose defang rule neutralizes any literal
 * closing tag in vault text). The path guard keeps the tool inside a
 * registered vault's markdown/ directory; the frontmatter renders as the
 * first part of the verbatim text, the body is line-windowed by
 * offset/limit, and truncation is marked inside the envelope plus a
 * structured flag. Read-stat bumping and the read registry that
 * memory_write's staleness guard consumes are the service's job.
 * @module dsh-plugin-obsidian-mem/tools/read
 */
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
/** Fast file read: one vault file, one small write. */
export declare const READ_TIMEOUT_MS = 10000;
/** The description the model sees for `memory_read`. */
export declare const READ_DESCRIPTION = "Read one memory note from a configured vault by absolute path. Returns the note text verbatim as stored (frontmatter first, then body lines), with the body windowed by offset/limit, the total body-line count, and a truncated marker inside the text when lines were left out. Only paths inside a registered vault's markdown/ directory resolve. Reading a note in a shared vault also bumps its frontmatter read stats.";
/** Parameter schema; window rules live on the parameters. */
export declare const READ_PARAMETERS: JsonSchemaNode;
/** Closed output union keyed on kind; `notice` marks the one-time provisioning line. */
export declare const READ_OUTPUT: JsonSchemaNode;
/** The value one memory_read call returns. */
export type ReadValue = {
    kind: 'read';
    path: string;
    mode: 'shared' | 'read-only';
    stats_updated: boolean;
    total_lines: number;
    truncated: boolean;
    content: string;
    notice?: string;
} | {
    kind: 'outside_vault';
    path: string;
    message: string;
    vaults: string[];
    notice?: string;
} | {
    kind: 'not_found';
    path: string;
    message: string;
    notice?: string;
};
/** Execute one memory_read call; every expected failure is a value. */
export declare function executeRead(service: MemoryService, args: unknown): Promise<ReadValue>;
/** Model-facing rendering of one memory_read value. */
export declare function renderRead(value: ReadValue): string;
/** Build the memory_read definition for one service seam. */
export declare function createReadTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=read.d.ts.map
