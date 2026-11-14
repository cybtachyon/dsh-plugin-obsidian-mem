/**
 * The host web routes for the Obsidian Mem settings card: the JSON API under
 * `/obsidian-mem/*` the browser card (TASK-051) calls to manage the vault
 * registry, read index/audit/dream state, edit dreaming triggers, edit the
 * Configuration pane's whitelisted settings, and probe search. Response
 * discipline has one home: every handler first asks the composition's
 * `connection` service for a rejection when one is reachable, then
 * dispatches on the request method against the path's declared method
 * map (405 with the declared methods as `allow`), then reads a non-GET body
 * as application/json under a 64 KiB ceiling (415 / 413 / 400), then answers
 * JSON with `cache-control: no-store`. Handlers never throw and never leak a
 * stack: failures answer `{ error: { code, message } }` with the status the
 * condition deserves (400/404/409 validation, protection, and conflicts; 503
 * structurally-unavailable backends; 500 genuinely unexpected failures).
 *
 * One route record owns every method of its path: the host webServer keys its
 * route table by (kind, path) and THROWS on a duplicate (research doc §2.12;
 * ext lost its whole route scope at boot to three registrations of one path),
 * so the registration builds exactly one record per path from the exported
 * {@link ROUTES} contract and holds the records by a scope effect so a bundle
 * switch off unregisters them before a switch on re-registers.
 *
 * The dreaming triggers (Q4 split: the card's Dreaming section manages DSH
 * schedule tasks; the plugin runs no timer of its own) go through the
 * reflection gateway `ctx.get('schedule')`, the same trio the
 * `schedule_create` tool calls — verified against the installed
 * @deepseek-ai/dsh-schedule 0.2.1-alpha.3 lib on 2026-11-12:
 * `create(sessionId, request)`, `catalog()`, `delete({ sessionId, id })`.
 * Ownership is the namespaced title: this plugin's entries carry
 * `obsidian-mem dream:<id>`, the list filters that prefix, and a delete
 * proves the tag against the live catalog per request. Honest limitation
 * (research §2.12): a foreign entry titled exactly this is visible and
 * removable here too. Without the service all three answer 503
 * `schedule_unavailable`; the row config's persisted
 * `config.dreaming.schedules` definitions echo in the catalog read for
 * read-only display (applying those as live tasks is a profile-config
 * action, not a card one).
 * @module dsh-plugin-obsidian-mem/ui
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CardSettingsPatch, CardSettingsView, ObsidianMemStatus, VaultAddRequest, VaultEntry } from '../../service/lib/index.js';
import type { AuditReport, AuditRequest } from '../../service/lib/audit.js';
import type { DreamEngineResult, DreamRequest } from '../../service/lib/dream.js';
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js';
/** The methods the route template dispatches. */
export type RouteMethod = 'GET' | 'POST' | 'DELETE';
/** RouteContract is one line of the card-facing API contract TASK-051 fetches against. */
export interface RouteContract {
    readonly method: RouteMethod;
    /** Exact-match pathname on the host web server, no trailing slash. */
    readonly path: string;
    /** What the endpoint answers, including its success payload shape. */
    readonly description: string;
}
/**
 * ROUTES is the single card contract: every `/obsidian-mem/*` endpoint with
 * its method and answer shape. The registration derives its route records
 * (paths plus method maps) from this list, and the card and its tests import
 * it, so the fetched paths and the registered paths cannot drift.
 */
export declare const ROUTES: readonly RouteContract[];
/** ROUTE_ERROR_CODES is the stable envelope-code vocabulary every error answer uses. */
export declare const ROUTE_ERROR_CODES: {
    readonly invalidJsonBody: "invalid_json_body";
    readonly unsupportedMediaType: "unsupported_media_type";
    readonly payloadTooLarge: "payload_too_large";
    readonly vaultInvalid: "vault_invalid";
    readonly vaultConflict: "vault_conflict";
    readonly vaultProtected: "vault_protected";
    readonly vaultNotFound: "vault_not_found";
    readonly settingsInvalid: "settings_invalid";
    readonly settingsBusy: "settings_busy";
    readonly auditInvalidView: "audit_invalid_view";
    readonly auditInvalidLimit: "audit_invalid_limit";
    readonly auditFailed: "audit_failed";
    readonly dreamUnavailable: "dream_unavailable";
    readonly dreamBusy: "dream_busy";
    readonly dreamFailed: "dream_failed";
    readonly scheduleUnavailable: "schedule_unavailable";
    readonly scheduleInvalid: "schedule_invalid";
    readonly scheduleNotFound: "schedule_not_found";
    readonly scheduleFailed: "schedule_failed";
    readonly searchInvalid: "search_invalid";
    readonly indexOffline: "index_offline";
    readonly searchFailed: "search_failed";
    readonly internalError: "internal_error";
};
/** ErrorEnvelope is the one error answer shape every route shares. */
export interface ErrorEnvelope {
    error: {
        code: string;
        message: string;
    };
}
/** ErrorEnvelopeOf builds the `{ error: { code, message } }` answer. */
declare function errorEnvelope(code: string, message: string): ErrorEnvelope;
/**
 * RouteError is a route failure that carries its own status and stable code,
 * so a domain refusal (a protected vault, a rejected schedule rule) answers
 * as itself instead of a blanket 500.
 */
export declare class RouteError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** IncomingLike is the request slice the handlers read; the web server hands a node IncomingMessage. */
export interface IncomingLike extends AsyncIterable<Buffer> {
    method: string;
    url: string;
    headers: Readonly<Record<string, string | undefined>>;
    /** Abandon the body stream past the ceiling (the open-in-app drain rule). */
    destroy(): void;
}
/** OutgoingLike is the response slice the handlers write (the node ServerResponse's used members). */
export interface OutgoingLike {
    writeHead(status: number, headers?: Record<string, string>): OutgoingLike;
    end(body?: string): void;
}
/** ConnectionGateway is the composition's `connection` service, read structurally. */
export interface ConnectionGateway {
    /** Answer the status that rejects this request, or undefined when it is trusted. */
    requestRejection(req: IncomingLike): number | undefined;
}
/** WebServerService is the host route table; dsh-specific, so the Context type is narrowed locally. */
export interface WebServerService {
    register(route: WebServerRoute): () => void;
}
/** WebServerRoute is one exact-match registration; it owns every method of its path. */
export interface WebServerRoute {
    readonly kind: 'exact';
    readonly path: string;
    readonly name: string;
    handler(req: IncomingLike, res: OutgoingLike): void | Promise<void>;
}
/**
 * RouteService is the seam slice the routes call. Declared here so the card
 * API is testable against a fake and the real `ObsidianMemService` only has
 * to keep satisfying it structurally.
 */
export interface RouteService {
    status(): ObsidianMemStatus;
    listVaults(): VaultEntry[];
    addVault(request: VaultAddRequest): VaultEntry;
    removeVault(path: string): Promise<void>;
    cardSettings(): CardSettingsView;
    updateCardSettings(patch: CardSettingsPatch): Promise<CardSettingsView>;
    resetCardSettings(): Promise<CardSettingsView>;
    audit(request?: AuditRequest): Promise<AuditReport>;
    dream(request?: DreamRequest): Promise<DreamEngineResult>;
    search(request: SearchRequest): Promise<MemorySearchResult[]>;
}
/** RouteLogger is the named-logger slice the routes log failures through. */
export interface RouteLogger {
    warn(message: string): void;
    info(message: string): void;
}
/** RouteDeps carries what a handler run needs. */
interface RouteDeps {
    readonly ctx: Context;
    readonly service: RouteService;
    readonly log: RouteLogger;
}
/** Scoped context narrowed to the two services {@link apply} waits for. */
export type ObsidianMemRouteScope = Context & {
    webServer: WebServerService;
    obsidianMem: RouteService;
};
/** ScheduleCatalogRow is the catalog-entry slice the routes read (structurally typed; the schedule package stays a reflection-only peer). */
interface ScheduleCatalogRow {
    id: string;
    title: string;
    prompt: string;
    kind: string;
    scheduledAt: string;
    sessionId: string;
    status?: 'active' | 'inactive';
}
/** ScheduleCreateBody is the `create` request as @deepseek-ai/dsh-schedule declares it (title required, exactly one timing). */
type ScheduleCreateBody = {
    prompt: string;
    title: string;
} & ({
    every_seconds: number;
    cron?: never;
} | {
    cron: {
        expression: string;
        time_zone: string;
    };
    every_seconds?: never;
});
/** ScheduleGateway is the trio the `schedule_create` tool calls, read through `ctx.get('schedule')`. */
export interface ScheduleGateway {
    create(sessionId: string, request: ScheduleCreateBody): Promise<unknown>;
    catalog(): Promise<ScheduleCatalogRow[]>;
    delete(request: {
        sessionId: string;
        id: string;
    }): Promise<{
        deleted: boolean;
    }>;
}
/**
 * BuildRoutes turns {@link ROUTES} into one webServer record per path: the
 * contract's methods (in contract order, which becomes the `allow` header)
 * joined through the {@link routeHandlers} map. An endpoint the handlers do
 * not cover throws at build time, which cordis reports as the ui fiber
 * failing, never as a half-mounted route table.
 */
export declare function buildRoutes(deps: RouteDeps): WebServerRoute[];
/**
 * RegisterObsidianMemRoutes mounts every route record under one scope effect
 * so a bundle switch off unregisters them before a switch on re-registers
 * (the local-infer / ext route-holding idiom).
 */
export declare function registerObsidianMemRoutes(scope: ObsidianMemRouteScope, ctx: Context): void;
export declare const name = "obsidian-mem-ui";
/** Static wait for the seam (mirrors the tools/events rows); webServer joins as a scoped inject so a headless profile never mounts the routes. */
export declare const inject: string[];
/**
 * Mount the `/obsidian-mem/*` routes. The scoped inject waits for `webServer`
 * plus the seam, so a profile without the web carrier keeps the service and
 * tools untouched; the `connection` trust fence is read by reflection inside
 * the handlers when the composition carries one.
 */
export declare function apply(ctx: Context): void;
/**
 * The dreaming trigger trio's structural gateway type plus the envelope and
 * contract surface TASK-051's card mirrors; exported so the card tests pin
 * them against the routes.
 */
export { errorEnvelope };
export type { ObsidianMemStatus, ScheduleCatalogRow };
declare const plugin: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default plugin;
//# sourceMappingURL=index.d.ts.map
