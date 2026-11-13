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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { classifyPath, markdownDir, serializeNote, TOOL_MEMORY_READ, wrapRecalled, } from '../../core/lib/index.js';
import { expandHomePath } from '../../service/lib/config.js';
import { asRecord, optionalInt, requiredString } from './host.js';
import { defineMemoryTool, makePresentCall, noticeHeader, withNotice } from './toolkit.js';
/** Fast file read: one vault file, one small write. */
export const READ_TIMEOUT_MS = 10_000;
/** The description the model sees for `memory_read`. */
export const READ_DESCRIPTION = 'Read one memory note from a configured vault by absolute path. Returns the note text verbatim as stored (frontmatter first, then body lines), with the body windowed by offset/limit, the total body-line count, and a truncated marker inside the text when lines were left out. Only paths inside a registered vault\'s markdown/ directory resolve. Reading a note in a shared vault also bumps its frontmatter read stats.';
/** Parameter schema; window rules live on the parameters. */
export const READ_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
        path: {
            type: 'string',
            description: 'Absolute path of the note file, inside a registered vault\'s markdown/ directory. The first memory call names the auto-created default vault path when no vault was configured.',
        },
        offset: {
            type: 'integer',
            description: '1-based body line to start from. Defaults to 1.',
        },
        limit: {
            type: 'integer',
            description: 'Largest number of body lines to return. Defaults to the rest of the body.',
        },
    },
};
/** Closed output union keyed on kind; `notice` marks the one-time provisioning line. */
export const READ_OUTPUT = {
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'mode', 'stats_updated', 'total_lines', 'truncated', 'content'],
            properties: {
                kind: { type: 'string', const: 'read' },
                path: { type: 'string' },
                mode: { type: 'string', enum: ['shared', 'read-only'] },
                stats_updated: { type: 'boolean' },
                total_lines: { type: 'integer' },
                truncated: { type: 'boolean' },
                content: { type: 'string' },
                notice: { type: 'string' },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'message', 'vaults'],
            properties: {
                kind: { type: 'string', const: 'outside_vault' },
                path: { type: 'string' },
                message: { type: 'string' },
                vaults: { type: 'array', items: { type: 'string' } },
                notice: { type: 'string' },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'message'],
            properties: {
                kind: { type: 'string', const: 'not_found' },
                path: { type: 'string' },
                message: { type: 'string' },
                notice: { type: 'string' },
            },
        },
    ],
};
/** Execute one memory_read call; every expected failure is a value. */
export async function executeRead(service, args) {
    const raw = asRecord(args);
    const path = requiredString(raw, 'path');
    const offset = optionalInt(raw, 'offset');
    const limit = optionalInt(raw, 'limit');
    const notice = await service.ensureMemoryAccess();
    const target = expandHomePath(path, homedir());
    const vaults = service.listVaults();
    const classified = classifyPath(vaults, target);
    if (classified === null || !classified.insideMarkdownDir) {
        return withNotice({
            kind: 'outside_vault',
            path: target,
            message: classified === null
                ? `${target} is not inside any registered vault. Memory notes live under a vault's markdown/ directory.`
                : `${target} is inside vault ${classified.vault.path} but outside its markdown/ directory.`,
            vaults: vaults.map((vault) => markdownDir(vault.path)),
        }, notice);
    }
    if (!existsSync(target)) {
        return withNotice({
            kind: 'not_found',
            path: target,
            message: `${target} does not exist. List the vault in a file manager or search for the note's topic instead.`,
        }, notice);
    }
    const result = await service.read(target, {
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
    });
    const frontmatter = serializeNote({ meta: result.meta, body: '' }).replace(/\n+$/, '');
    const body = result.body === '' ? frontmatter : `${frontmatter}\n${result.body}`;
    const inner = result.truncated ? `${body}\n${truncationMarker(result.body, result)}` : body;
    return withNotice({
        kind: 'read',
        path: result.path,
        mode: result.mode,
        stats_updated: result.statsUpdated,
        total_lines: result.totalLines,
        truncated: result.truncated,
        content: wrapRecalled(result.path, inner),
    }, notice);
}
// The in-envelope continuation marker: the window's lines, the whole-body
// size, and the exact offset that continues it (locality: omissions named
// and resumable where they sit in the text).
function truncationMarker(body, result) {
    const shown = body === '' ? 0 : body.split('\n').length;
    const first = result.offset;
    const last = first + shown - 1;
    return `[truncated: showing body lines ${first}-${last} of ${result.totalLines}; continue with offset=${last + 1}]`;
}
/** Model-facing rendering of one memory_read value. */
export function renderRead(value) {
    const notice = noticeHeader(value.notice);
    switch (value.kind) {
        case 'read': {
            const stats = value.stats_updated ? 'read stats updated' : 'read-only vault: read stats unchanged';
            const size = value.truncated
                ? `${value.total_lines} body lines total, result truncated`
                : `${value.total_lines} body lines`;
            return `${notice}${value.content}\n\n(${value.path}, ${value.mode}, ${size}, ${stats}.)`;
        }
        case 'outside_vault':
            return `${notice}${value.message}\nConfigured vault note dirs:\n${value.vaults.map((vault) => `- ${vault}`).join('\n')}`;
        case 'not_found':
            return `${notice}${value.message}`;
    }
}
/** Build the memory_read definition for one service seam. */
export function createReadTool(service) {
    return defineMemoryTool({
        name: TOOL_MEMORY_READ,
        description: READ_DESCRIPTION,
        parameters: READ_PARAMETERS,
        output: READ_OUTPUT,
        timeoutMs: READ_TIMEOUT_MS,
        execute: async (args) => await executeRead(service, args),
        render: renderRead,
        presentCall: makePresentCall({ tool: TOOL_MEMORY_READ, kind: 'read', field: 'path', fallback: '' }),
    });
}
//# sourceMappingURL=read.js.map
