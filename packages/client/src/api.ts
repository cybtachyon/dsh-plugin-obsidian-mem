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

import type { ObsidianMemStatus, ScheduleCatalogRow } from '../../ui/lib/index.js'
import type { VaultMode } from '../../core/lib/index.js'
import type { AuditReport, AuditView } from '../../service/lib/audit.js'
import type { DreamPlan } from '../../service/lib/dream.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type { VaultEntry } from '../../service/lib/index.js'
import {
  PATH_AUDIT,
  PATH_DREAM_PLAN,
  PATH_DREAM_RUN,
  PATH_DREAM_STATE,
  PATH_SCHEDULES,
  PATH_SEARCH,
  PATH_STATUS,
  PATH_VAULTS,
} from './routes.js'

/**
 * ERROR_CODES mirrors the ROUTE_ERROR_CODES entries the card branches on
 * (a subset; tests/api.spec.ts asserts every value exists in the ui
 * vocabulary). Message text is shown verbatim, so most codes need no branch.
 */
export const ERROR_CODES = {
  vaultInvalid: 'vault_invalid',
  vaultConflict: 'vault_conflict',
  vaultProtected: 'vault_protected',
  dreamUnavailable: 'dream_unavailable',
  dreamBusy: 'dream_busy',
  scheduleUnavailable: 'schedule_unavailable',
  scheduleNotFound: 'schedule_not_found',
  indexOffline: 'index_offline',
} as const

/** ApiError is a failed route call: the status, the stable code, the verbatim message. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** ApiErrorOf reports whether a caught value is a failed route call. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** ReadErrorMessage answers a caught error's renderable text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** StatusPayload answers GET /obsidian-mem/status (the noticeActive banner flag). */
export type StatusPayload = ObsidianMemStatus & { noticeActive: boolean }

/** DreamStatePayload answers GET /obsidian-mem/dream/state. */
export interface DreamStatePayload {
  lastDreamAt: number | null
  promptPath: string
}

/** A live dreaming trigger: the catalog row plus the card-owned trigger id (the ownership-title suffix). */
export type DreamingScheduleEntry = ScheduleCatalogRow & { pluginId: string }

/** SchedulesPayload answers GET /obsidian-mem/dreaming/schedules. */
export interface SchedulesPayload {
  entries: DreamingScheduleEntry[]
  configured: StatusPayload['dreaming']['schedules']
}

/** AddVaultRequest is the POST /obsidian-mem/vaults body. */
export interface AddVaultRequest {
  path: string
  mode: VaultMode
}

/** SearchPayload answers GET /obsidian-mem/search. */
export interface SearchPayload {
  results: MemorySearchResult[]
  query: string
  topK: number
}

/** ScheduleUpsertRequest is the POST /obsidian-mem/dreaming/schedules body: exactly one of expression / everySeconds. */
export interface ScheduleUpsertRequest {
  id: string
  label: string
  sessionId: string
  expression?: string
  everySeconds?: number
  timeZone?: string
}

/** ErrorEnvelope is the one error answer shape every route shares. */
interface ErrorEnvelopeBody {
  error?: { code?: string, message?: string }
}

// request runs one fetch round trip and settles to the parsed JSON answer.
// A non-OK answer throws ApiError built from the route's error envelope (code
// and message verbatim; a body that is not the envelope degrades to HTTP
// <status>), so every caller's catch reads the host's own words.
async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const envelope = payload !== null && typeof payload === 'object'
      ? (payload as ErrorEnvelopeBody).error
      : undefined
    throw new ApiError(
      response.status,
      typeof envelope?.code === 'string' ? envelope.code : '',
      typeof envelope?.message === 'string' ? envelope.message : `HTTP ${String(response.status)} ${method} ${path}`,
    )
  }
  return payload as T
}

/** RouteExists probes GET /obsidian-mem/status: any answer but a 404 proves the host serves the card's routes; a network failure reads absent. */
export function routeExists(): Promise<boolean> {
  return fetch(PATH_STATUS)
    .then((response) => response.status !== 404)
    .catch(() => false)
}

/** FetchStatus reads the polling snapshot (state, vaults, index, dream orchestrator). */
export function fetchStatus(): Promise<StatusPayload> {
  return request<StatusPayload>('GET', PATH_STATUS)
}

/** AddVault registers a card vault (409 duplicate/shadowing answers with the service's own message). */
export function addVault(vault: AddVaultRequest): Promise<VaultEntry> {
  return request<VaultEntry>('POST', PATH_VAULTS, vault)
}

/** RemoveVault drops a card-added vault (protected and unknown paths answer 409/404 verbatim). */
export function removeVault(path: string): Promise<{ removed: boolean, path: string }> {
  return request('DELETE', PATH_VAULTS, { path })
}

/** FetchAudit runs the read-only audit pass for one view. */
export function fetchAudit(view: AuditView): Promise<{ report: AuditReport }> {
  return request('GET', `${PATH_AUDIT}?view=${encodeURIComponent(view)}`)
}

/** FetchDreamPlan reads the deterministic plan preview (no model call). */
export function fetchDreamPlan(): Promise<{ plan: DreamPlan }> {
  return request('GET', PATH_DREAM_PLAN)
}

/** RunDream launches the background dream run; the route answers 202 { started, id } and a busy guard answers 409 dream_busy. */
export function runDream(): Promise<{ started: boolean, id: string }> {
  return request('POST', PATH_DREAM_RUN, {})
}

/** FetchDreamState reads lastDreamAt and the editable prompt path. */
export function fetchDreamState(): Promise<DreamStatePayload> {
  return request('GET', PATH_DREAM_STATE)
}

/** FetchSchedules lists live triggers plus the read-only config echo (503 schedule_unavailable without the service). */
export function fetchSchedules(): Promise<SchedulesPayload> {
  return request<SchedulesPayload>('GET', PATH_SCHEDULES)
}

/** UpsertSchedule creates (or replaces, by ownership title) one trigger. */
export function upsertSchedule(requestBody: ScheduleUpsertRequest): Promise<{ id: string, label: string, replaced: boolean, entry: unknown }> {
  return request('POST', PATH_SCHEDULES, requestBody)
}

/** DeleteSchedule removes one owned trigger by card id (404 schedule_not_found otherwise). */
export function deleteSchedule(id: string): Promise<{ deleted: boolean, id: string }> {
  return request('DELETE', PATH_SCHEDULES, { id })
}

/** ProbeSearch runs the card's hybrid-search test with topK clamped to 1..10 (the route's own ceiling). */
export function probeSearch(query: string, topK: number): Promise<SearchPayload> {
  const bounded = Math.min(10, Math.max(1, Math.trunc(topK)))
  const path = `${PATH_SEARCH}?q=${encodeURIComponent(query)}&topK=${String(bounded)}`
  return request<SearchPayload>('GET', path)
}
