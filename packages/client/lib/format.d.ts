/**
 * Pure display logic for the card: string truncation (long vault paths and
 * chunk texts never overflow the card), count and age formatting, the local
 * calendar date the failed-dream banner dates with, the budget
 * meter's percent math, and the schedule-slug rule the Dreaming add form uses
 * to derive a trigger id from its label. Everything here is a total function
 * the vitest specs cover directly; nothing touches fetch, DOM, or react.
 * @module dsh-plugin-obsidian-mem/client/format
 */
/** TruncateLong truncates to `max` characters, marking the cut with an ellipsis. */
export declare function truncate(text: string, max: number): string;
/** FormatCount renders an integer with thin-free thousands separators. */
export declare function formatCount(value: number): string;
/** FormatBytes renders a byte count as the nearest human unit. */
export declare function formatBytes(bytes: number): string;
/**
 * FormatAge renders an epoch-ms stamp relative to `nowMs`: "never" for null,
 * "just now" under a minute, then whole minutes, hours, and days. A stamp in
 * the future reads "just now" (a skewed clock never renders a negative age).
 */
export declare function formatAge(epochMs: number | null, nowMs: number): string;
/**
 * FormatLocalDate renders an epoch-ms stamp as the local calendar date
 * "YYYY-MM-DD" (zero-padded). A hand-built date instead of
 * toLocaleDateString: the copy stays stable across host locales and the
 * specs assert it literally.
 */
export declare function formatLocalDate(epochMs: number): string;
/**
 * BudgetPercent clamps used/budget to a 0..100 meter percent. A non-positive
 * budget (or a non-finite ratio) reads 0: the meter never divides by zero and
 * never overflows its track; the over-budget state carries itself.
 */
export declare function budgetPercent(used: number, budget: number): number;
/**
 * SlugId derives a dreaming-trigger id from a label under the route's slug
 * rule ([a-z0-9][a-z0-9._-]{0,63}): lower-cased, every run of other
 * characters collapsed to one '-', leading separators dropped, capped at 64.
 * An empty result falls back to 'dream'.
 */
export declare function slugId(label: string): string;
/**
 * ClampTopK bounds the search panel's topK input to 1..10 (the route clamps
 * to 10 too; the card clamps first so the field and the request agree).
 */
export declare function clampTopK(raw: string): number;
//# sourceMappingURL=format.d.ts.map
