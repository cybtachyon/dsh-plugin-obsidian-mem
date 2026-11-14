/**
 * The card's route table: every `/obsidian-mem/*` endpoint the card fetches,
 * as one {method, path} entry per use. The paths are typed strings here (the
 * bundle must not import the node-side ui package); tests/routes.spec.ts
 * asserts this table against the ui package's ROUTES contract, so a fetched
 * path and a registered path can never drift apart silently.
 * @module dsh-plugin-obsidian-mem/client/routes
 */
/** The request methods the card's routes dispatch. */
export type CardRouteMethod = 'GET' | 'POST' | 'DELETE';
/** One card-side route use: the method it calls with and the path it calls. */
export interface CardRoute {
    readonly method: CardRouteMethod;
    readonly path: string;
}
export declare const PATH_STATUS = "/obsidian-mem/status";
export declare const PATH_VAULTS = "/obsidian-mem/vaults";
export declare const PATH_AUDIT = "/obsidian-mem/audit";
export declare const PATH_DREAM_PLAN = "/obsidian-mem/dream/plan";
export declare const PATH_DREAM_RUN = "/obsidian-mem/dream/run";
export declare const PATH_DREAM_STATE = "/obsidian-mem/dream/state";
export declare const PATH_SCHEDULES = "/obsidian-mem/dreaming/schedules";
export declare const PATH_SEARCH = "/obsidian-mem/search";
export declare const PATH_SETTINGS = "/obsidian-mem/settings";
/**
 * ALL_CARD_ROUTES lists every route use the card performs. The contract test
 * proves each entry exists in the ui ROUTES table and that the ui table
 * contains no `/obsidian-mem/*` endpoint the card forgot to reach.
 */
export declare const ALL_CARD_ROUTES: readonly CardRoute[];
//# sourceMappingURL=routes.d.ts.map
