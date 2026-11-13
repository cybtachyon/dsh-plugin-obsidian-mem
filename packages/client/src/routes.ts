/**
 * The card's route table: every `/obsidian-mem/*` endpoint the card fetches,
 * as one {method, path} entry per use. The paths are typed strings here (the
 * bundle must not import the node-side ui package); tests/routes.spec.ts
 * asserts this table against the ui package's ROUTES contract, so a fetched
 * path and a registered path can never drift apart silently.
 * @module dsh-plugin-obsidian-mem/client/routes
 */

/** The request methods the card's routes dispatch. */
export type CardRouteMethod = 'GET' | 'POST' | 'DELETE'

/** One card-side route use: the method it calls with and the path it calls. */
export interface CardRoute {
  readonly method: CardRouteMethod
  readonly path: string
}

// The single home of every fetched path string (api.ts reads these).
export const PATH_STATUS = '/obsidian-mem/status'
export const PATH_VAULTS = '/obsidian-mem/vaults'
export const PATH_AUDIT = '/obsidian-mem/audit'
export const PATH_DREAM_PLAN = '/obsidian-mem/dream/plan'
export const PATH_DREAM_RUN = '/obsidian-mem/dream/run'
export const PATH_DREAM_STATE = '/obsidian-mem/dream/state'
export const PATH_SCHEDULES = '/obsidian-mem/dreaming/schedules'
export const PATH_SEARCH = '/obsidian-mem/search'

/**
 * ALL_CARD_ROUTES lists every route use the card performs. The contract test
 * proves each entry exists in the ui ROUTES table and that the ui table
 * contains no `/obsidian-mem/*` endpoint the card forgot to reach.
 */
export const ALL_CARD_ROUTES: readonly CardRoute[] = [
  { method: 'GET', path: PATH_STATUS },
  { method: 'POST', path: PATH_VAULTS },
  { method: 'DELETE', path: PATH_VAULTS },
  { method: 'GET', path: PATH_AUDIT },
  { method: 'GET', path: PATH_DREAM_PLAN },
  { method: 'POST', path: PATH_DREAM_RUN },
  { method: 'GET', path: PATH_DREAM_STATE },
  { method: 'GET', path: PATH_SCHEDULES },
  { method: 'POST', path: PATH_SCHEDULES },
  { method: 'DELETE', path: PATH_SCHEDULES },
  { method: 'GET', path: PATH_SEARCH },
] as const
