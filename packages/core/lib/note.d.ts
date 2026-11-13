/**
 * Models the memory-note Markdown format: NoteMeta frontmatter fields,
 * tolerant parsing, stable-order serialization, meta validation split into
 * errors versus warnings, title-to-filename slugs, archive detection, and
 * the Why:/How to apply: body discipline warnings.
 *
 * Pure text transforms over gray-matter; no fs, no env, no @deepseek-ai
 * imports. Notes are files only through their callers.
 * @module dsh-plugin-obsidian-mem/core/note
 */
/** A registered memory: frontmatter meta plus Markdown body. */
export interface Note {
    meta: NoteMeta;
    body: string;
    /**
     * Raw frontmatter record including the keys NoteMeta does not model
     * (keywords, trigger_extensions, trigger_frameworks); trigger extraction
     * reads the overrides from here. Absent on hand-built Note objects.
     */
    raw?: Record<string, unknown>;
}
/**
 * NoteMeta is the frontmatter contract every indexed note carries.
 * index_title follows the "Topic: Scenario" discipline; index_description
 * is the recall hook that decides whether to open the note; type is a named
 * scope or a project slug; archive retires the note from search defaults
 * and reindexing; read stats (last_read_at, read_count) drive dreaming.
 */
export interface NoteMeta {
    index_title: string;
    index_description: string;
    type: string;
    archive: boolean;
    /** ISO 8601 timestamp or date; '' when unknown. */
    created: string;
    /** ISO 8601 timestamp or date; '' when unknown. */
    updated: string;
    /** ISO 8601 date of the last recall read; absent when never read. */
    last_read_at?: string;
    read_count: number;
}
/** Soft ceiling for index_description; longer text warns, never errors. */
export declare const MAX_INDEX_DESCRIPTION_CHARS = 120;
/** The outcome of validating note meta; empty arrays mean valid. */
export interface MetaValidation {
    errors: string[];
    warnings: string[];
}
/**
 * parseNote splits a note into meta and body, applying defaults for missing
 * fields (archive false, read_count 0, type global, empty strings) and
 * coercing YAML-parsed dates back to ISO text. It tolerates absent fields
 * and absent frontmatter, but malformed YAML throws from gray-matter:
 * a corrupt file is an audit finding, not something to reinterpret.
 */
export declare function parseNote(text: string): Note;
/** Frontmatter keys NoteMeta models; every other key in a parsed note is raw. */
export declare const NOTE_FRONTMATTER_KEYS: readonly string[];
/**
 * serializeNote renders {meta, body} back to note text: frontmatter keys in
 * one stable order (index_title, index_description, type, archive, created,
 * updated, last_read_at, read_count), CRLF collapsed to LF, body ending in
 * exactly one newline. Optional timestamps are omitted when empty, so a
 * re-serialize of untouched content is byte-identical. It renders the
 * modelled keys only; a rewrite of an authored note must use
 * serializeNoteWithRaw to keep the keys it does not model.
 */
export declare function serializeNote(note: Note): string;
/**
 * serializeNoteWithRaw renders the modelled frontmatter (same order as
 * serializeNote) plus every key from `raw` that NoteMeta does not model
 * (keywords, trigger_extensions, trigger_frameworks, user keys), in the raw
 * record's original order after the modelled block. Rewriting an authored
 * note through this seam is lossless: parseNote → edit meta → serialize-
 * NoteWithRaw round-trips the un-modelled keys. With no extras (or none
 * beyond the modelled keys) the output is byte-identical to serializeNote.
 */
export declare function serializeNoteWithRaw(note: Note, raw?: Record<string, unknown>): string;
/**
 * validateMeta checks a draft meta and splits findings: errors are hard
 * (required fields, invalid scope value, malformed read stats, a description
 * that merely repeats the title); warnings are discipline nudges (a long or
 * title-repeating description). memory_write refuses on errors and surfaces
 * warnings to the agent.
 */
export declare function validateMeta(meta: Partial<NoteMeta>): MetaValidation;
/**
 * titleToFilename slugifies a note title into a kebab-case file name with
 * the .md suffix, appending -2, -3, ... to skip names already in taken
 * (collision handling for same-titled notes).
 */
export declare function titleToFilename(title: string, taken?: Iterable<string>): string;
/** Tests whether the note is archived; archived notes leave search
 * defaults and reindexing, staying on disk for audit and dreams. */
export declare function isArchived(note: Note | NoteMeta): boolean;
/**
 * ensureWhyAndHow returns discipline warnings when the body lacks a Why:
 * line or a How to apply: line, the two anchors that make a decision memory
 * actionable. Soft warnings for memory_write, per the turn-end policy.
 */
export declare function ensureWhyAndHow(body: string): string[];
/**
 * formatLocalDate renders now's local calendar day as the YYYY-MM-DD stamp
 * the note frontmatter fields (created, updated, last_read_at) carry; notes
 * are human-editable memory, so the day is the meaningful resolution. The
 * clock stays with the caller so core stays deterministic under test.
 */
export declare function formatLocalDate(now: Date): string;
//# sourceMappingURL=note.d.ts.map
