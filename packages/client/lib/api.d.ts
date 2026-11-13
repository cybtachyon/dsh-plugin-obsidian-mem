/**
 * The card's API layer: one typed fetch wrapper over the `/obsidian-mem/*`
 * routes plus the bootstrap's route probe.
 *
 * Every route answers JSON. A failure answers the shared error envelope
 * `{ error: { code, message } }` (ui/src/index.ts ErrorEnvelope), and the
 * wrapper turns it into an ApiError that keeps the status, the stable code
 * from the ui ROUTE_ERROR_CODES vocabulary, and the host's message VERBATIM:
 * sections render `error.message` directly (React escapes text, so vault
 * paths and host hints reach the card exactly as written) and branch on
 * `error.code` only where behavior differs (an offline search probe, a busy
 * dream run, a missing schedule service).
 *
 * The payload types are type-only imports of the host packages, so they erase
 * at bundle time; the shapes they describe are the routes' own answers.
 * @module dsh-plugin-obsidian-mem/client/api
 */
import type { ObsidianMemStatus, ScheduleCatalogRow } from '../../ui/lib/index.js';
import type { VaultMode } from '../../core/lib/index.js';
import type { AuditReport, AuditView } from '../../service/lib/audit.js';
import type { DreamPlan } from '../../service/lib/dream.js';
import type { MemorySearchResult } from '../../service/lib/search.js';
import type { VaultEntry } from '../../service/lib/index.js';
/**
 * ERROR_CODES mirrors the ROUTE_ERROR_CODES entries the card branches on
 * (a subset; tests/api.spec.ts asserts every value exists in the ui
 * vocabulary). Message text is shown verbatim, so most codes need no branch.
 */
export declare const ERROR_CODES: {
    readonly vaultInvalid: "vault_invalid";
    readonly vaultConflict: "vault_conflict";
    readonly vaultProtected: "vault_protected";
    readonly dreamUnavailable: "dream_unavailable";
    readonly dreamBusy: "dream_busy";
    readonly scheduleUnavailable: "schedule_unavailable";
    readonly scheduleNotFound: "schedule_not_found";
    readonly indexOffline: "index_offline";
};
/** ApiError is a failed route call: the status, the stable code, the verbatim message. */
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** ApiErrorOf reports whether a caught value is a failed route call. */
export declare function isApiError(error: unknown): error is ApiError;
/** ReadErrorMessage answers a caught error's renderable text. */
export declare function errorText(error: unknown): string;
/** StatusPayload answers GET /obsidian-mem/status (the noticeActive banner flag). */
export type StatusPayload = ObsidianMemStatus & {
    noticeActive: boolean;
};
/** DreamStatePayload answers GET /obsidian-mem/dream/state. */
export interface DreamStatePayload {
    lastDreamAt: number | null;
    promptPath: string;
}
/** A live dreaming trigger: the catalog row plus the card-owned trigger id (the ownership-title suffix). */
export type DreamingScheduleEntry = ScheduleCatalogRow & {
    pluginId: string;
};
/** SchedulesPayload answers GET /obsidian-mem/dreaming/schedules. */
export interface SchedulesPayload {
    entries: DreamingScheduleEntry[];
    configured: StatusPayload['dreaming']['schedules'];
}
/** AddVaultRequest is the POST /obsidian-mem/vaults body. */
export interface AddVaultRequest {
    path: string;
    mode: VaultMode;
}
/** SearchPayload answers GET /obsidian-mem/search. */
export interface SearchPayload {
    results: MemorySearchResult[];
    query: string;
    topK: number;
}
/** ScheduleUpsertRequest is the POST /obsidian-mem/dreaming/schedules body: exactly one of expression / everySeconds. */
export interface ScheduleUpsertRequest {
    id: string;
    label: string;
    sessionId: string;
    expression?: string;
    everySeconds?: number;
    timeZone?: string;
}
/** RouteExists probes GET /obsidian-mem/status: any answer but a 404 proves the host serves the card's routes; a network failure reads absent. */
export declare function routeExists(): Promise<boolean>;
/** FetchStatus reads the polling snapshot (state, vaults, index, dream orchestrator). */
export declare function fetchStatus(): Promise<StatusPayload>;
/** AddVault registers a card vault (409 duplicate/shadowing answers with the service's own message). */
export declare function addVault(vault: AddVaultRequest): Promise<VaultEntry>;
/** RemoveVault drops a card-added vault (protected and unknown paths answer 409/404 verbatim). */
export declare function removeVault(path: string): Promise<{
    removed: boolean;
    path: string;
}>;
/** FetchAudit runs the read-only audit pass for one view. */
export declare function fetchAudit(view: AuditView): Promise<{
    report: AuditReport;
}>;
/** FetchDreamPlan reads the deterministic plan preview (no model call). */
export declare function fetchDreamPlan(): Promise<{
    plan: DreamPlan;
}>;
/** RunDream launches the background dream run; the route answers 202 { started, id } and a busy guard answers 409 dream_busy. */
export declare function runDream(): Promise<{
    started: boolean;
    id: string;
}>;
/** FetchDreamState reads lastDreamAt and the editable prompt path. */
export declare function fetchDreamState(): Promise<DreamStatePayload>;
/** FetchSchedules lists live triggers plus the read-only config echo (503 schedule_unavailable without the service). */
export declare function fetchSchedules(): Promise<SchedulesPayload>;
/** UpsertSchedule creates (or replaces, by ownership title) one trigger. */
export declare function upsertSchedule(requestBody: ScheduleUpsertRequest): Promise<{
    id: string;
    label: string;
    replaced: boolean;
    entry: unknown;
}>;
/** DeleteSchedule removes one owned trigger by card id (404 schedule_not_found otherwise). */
export declare function deleteSchedule(id: string): Promise<{
    deleted: boolean;
    id: string;
}>;
/** ProbeSearch runs the card's hybrid-search test with topK clamped to 1..10 (the route's own ceiling). */
export declare function probeSearch(query: string, topK: number): Promise<SearchPayload>;
//# sourceMappingURL=api.d.ts.map
