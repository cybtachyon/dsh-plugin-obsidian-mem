/**
 * The host web routes for the Obsidian Mem settings card: the JSON API under
 * `/obsidian-mem/*` the browser card (TASK-051) calls to manage the vault
 * registry, read index/audit/dream state, edit dreaming triggers, and probe
 * search. Response discipline has one home: every handler first asks the
 * composition's `connection` service for a rejection when one is reachable,
 * then dispatches on the request method against the path's declared method
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

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AUDIT_MAX_LIMIT, DREAM_PROMPT_FILE, isVaultMode, VAULT_MODES } from '../../core/lib/index.js'
import { OBSIDIAN_MEM_SEAM } from '../../service/lib/index.js'
import type { ObsidianMemStatus, VaultAddRequest, VaultEntry } from '../../service/lib/index.js'
import { AUDIT_VIEWS } from '../../service/lib/audit.js'
import type { AuditReport, AuditRequest, AuditView } from '../../service/lib/audit.js'
import { DreamBlockedError, DreamBusyError } from '../../service/lib/dream.js'
import type { DreamEngineResult, DreamRequest } from '../../service/lib/dream.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js'

/** The methods the route template dispatches. */
export type RouteMethod = 'GET' | 'POST' | 'DELETE'

/** RouteContract is one line of the card-facing API contract TASK-051 fetches against. */
export interface RouteContract {
  readonly method: RouteMethod
  /** Exact-match pathname on the host web server, no trailing slash. */
  readonly path: string
  /** What the endpoint answers, including its success payload shape. */
  readonly description: string
}

/**
 * ROUTES is the single card contract: every `/obsidian-mem/*` endpoint with
 * its method and answer shape. The registration derives its route records
 * (paths plus method maps) from this list, and the card and its tests import
 * it, so the fetched paths and the registered paths cannot drift.
 */
export const ROUTES: readonly RouteContract[] = [
  {
    method: 'GET',
    path: '/obsidian-mem/status',
    description: 'Reports the seam status (service.status(): state, vaults, milvus, model, vectorDim, budgets, dreaming config, indexer progress, dream orchestrator state) plus noticeActive: boolean for the one-time default-vault banner. Never provisions.',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/vaults',
    description: 'Lists the vault registry as { vaults: [{ path, mode, source }] }.',
  },
  {
    method: 'POST',
    path: '/obsidian-mem/vaults',
    description: 'Registers a vault from the JSON body { path, mode? ("shared" | "read-only", default "shared") }; answers 201 { vault }. Duplicates and settings/default shadowing answer 409, unusable paths 400; the service restarts the indexer in the background.',
  },
  {
    method: 'DELETE',
    path: '/obsidian-mem/vaults',
    description: 'Removes the card-added vault named in the JSON body { path }; answers { removed: true, path }. Settings-row and auto-provisioned default vaults answer 409 vault_protected with the actionable place to remove them; unknown paths 404.',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/audit',
    description: 'Runs the read-only audit pass with the query params view ("full" | "topStale" | "oldestUnread") and limit (clamped to 500) and answers { report } (service.audit(); never writes, never provisions).',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/dream/plan',
    description: 'Answers { plan } (service dream operation "plan": the deterministic analysis, no model call, no run). Without a host agents gateway the run this plan drives can never launch, so the route answers 503 dream_unavailable instead.',
  },
  {
    method: 'POST',
    path: '/obsidian-mem/dream/run',
    description: 'Launches the background dream agent through the service single-flight guard from the optional JSON body { model? } and answers 202 { started: true, id } without awaiting the run. Without a host agents gateway answers 503 dream_unavailable (the card shows the hint); a run already in flight answers 409 dream_busy.',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/dream/state',
    description: 'Answers { lastDreamAt: number | null, promptPath: string } from the dream stamp and the editable prompt location under the database directory.',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/dreaming/schedules',
    description: 'Lists the live dreaming triggers as { entries: [{ pluginId, scheduleId, title, prompt, kind, scheduledAt, sessionId, status? }], configured: DreamingSchedule[] } (the read-only echo of config.dreaming.schedules). 503 schedule_unavailable without the host schedule service.',
  },
  {
    method: 'POST',
    path: '/obsidian-mem/dreaming/schedules',
    description: 'Upserts one trigger from the JSON body { id, label, sessionId, expression? | everySeconds?, timeZone? } (exactly one timing; everySeconds >= 60; expression is cron evaluated in timeZone, default UTC). Creates through the DSH schedule service under the ownership title "obsidian-mem dream:<id>" (replacing any prior entry with that title) and answers { id, label, replaced, entry }. 503 schedule_unavailable without the service; rejected inputs answer 400/409 with the service code.',
  },
  {
    method: 'DELETE',
    path: '/obsidian-mem/dreaming/schedules',
    description: 'Removes the trigger named in the JSON body { id } after proving the ownership title against the live catalog; answers { deleted: true, id }. Unknown or unowned ids answer 404 schedule_not_found; 503 schedule_unavailable without the service.',
  },
  {
    method: 'GET',
    path: '/obsidian-mem/search',
    description: 'Probes the hybrid index for the card test panel with the query params q (required) and topK (default 10, clamped to 10) and answers { results, query, topK }. An offline or degraded index answers 503 index_offline.',
  },
] as const

/** ROUTE_ERROR_CODES is the stable envelope-code vocabulary every error answer uses. */
export const ROUTE_ERROR_CODES = {
  invalidJsonBody: 'invalid_json_body',
  unsupportedMediaType: 'unsupported_media_type',
  payloadTooLarge: 'payload_too_large',
  vaultInvalid: 'vault_invalid',
  vaultConflict: 'vault_conflict',
  vaultProtected: 'vault_protected',
  vaultNotFound: 'vault_not_found',
  auditInvalidView: 'audit_invalid_view',
  auditInvalidLimit: 'audit_invalid_limit',
  auditFailed: 'audit_failed',
  dreamUnavailable: 'dream_unavailable',
  dreamBusy: 'dream_busy',
  dreamFailed: 'dream_failed',
  scheduleUnavailable: 'schedule_unavailable',
  scheduleInvalid: 'schedule_invalid',
  scheduleNotFound: 'schedule_not_found',
  scheduleFailed: 'schedule_failed',
  searchInvalid: 'search_invalid',
  indexOffline: 'index_offline',
  searchFailed: 'search_failed',
  internalError: 'internal_error',
} as const

/** The status every unexpected handler failure answers with after the envelope is logged. */
const INTERNAL_ERROR_STATUS = 500

/** Schedules minimum fixed interval; mirrors @deepseek-ai/dsh-schedule MIN_EVERY_INTERVAL_SECONDS (0.2.1-alpha.3). */
const SCHEDULE_MIN_INTERVAL_SECONDS = 60

/** Title prefix that marks a schedule entry as this plugin's; the title IS the ownership tag (research §2.12). */
const SCHEDULE_TITLE_PREFIX = 'obsidian-mem dream:'

/** Card trigger ids are safe slugs so the namespaced title stays computable and 120-char-safe. */
const SCHEDULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Upper bound on a trigger label embedded in the wake prompt. */
const SCHEDULE_LABEL_MAX_LENGTH = 80

/** Search probe result cap; the card test panel reads at most ten rows. */
const SEARCH_PROBE_MAX_TOP_K = 10

/** Route bodies are tiny JSON objects; anything past this ceiling is hostile, not a request. */
const MAX_BODY_BYTES = 64 * 1024

/** ErrorEnvelope is the one error answer shape every route shares. */
export interface ErrorEnvelope {
  error: { code: string, message: string }
}

/** ErrorEnvelopeOf builds the `{ error: { code, message } }` answer. */
function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}

/**
 * RouteError is a route failure that carries its own status and stable code,
 * so a domain refusal (a protected vault, a rejected schedule rule) answers
 * as itself instead of a blanket 500.
 */
export class RouteError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}

/** IncomingLike is the request slice the handlers read; the web server hands a node IncomingMessage. */
export interface IncomingLike extends AsyncIterable<Buffer> {
  method: string
  url: string
  headers: Readonly<Record<string, string | undefined>>
  /** Abandon the body stream past the ceiling (the open-in-app drain rule). */
  destroy(): void
}

/** OutgoingLike is the response slice the handlers write (the node ServerResponse's used members). */
export interface OutgoingLike {
  writeHead(status: number, headers?: Record<string, string>): OutgoingLike
  end(body?: string): void
}

/** ConnectionGateway is the composition's `connection` service, read structurally. */
export interface ConnectionGateway {
  /** Answer the status that rejects this request, or undefined when it is trusted. */
  requestRejection(req: IncomingLike): number | undefined
}

/** WebServerService is the host route table; dsh-specific, so the Context type is narrowed locally. */
export interface WebServerService {
  register(route: WebServerRoute): () => void
}

/** WebServerRoute is one exact-match registration; it owns every method of its path. */
export interface WebServerRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly name: string
  handler(req: IncomingLike, res: OutgoingLike): void | Promise<void>
}

/**
 * RouteService is the seam slice the routes call. Declared here so the card
 * API is testable against a fake and the real `ObsidianMemService` only has
 * to keep satisfying it structurally.
 */
export interface RouteService {
  status(): ObsidianMemStatus
  listVaults(): VaultEntry[]
  addVault(request: VaultAddRequest): VaultEntry
  removeVault(path: string): Promise<void>
  audit(request?: AuditRequest): Promise<AuditReport>
  dream(request?: DreamRequest): Promise<DreamEngineResult>
  search(request: SearchRequest): Promise<MemorySearchResult[]>
}

/** RouteLogger is the named-logger slice the routes log failures through. */
export interface RouteLogger {
  warn(message: string): void
  info(message: string): void
}

/** RouteDeps carries what a handler run needs. */
interface RouteDeps {
  readonly ctx: Context
  readonly service: RouteService
  readonly log: RouteLogger
}

/** RouteInput is what a method run receives: the query params and the validated JSON body. */
interface RouteInput {
  readonly params: URLSearchParams
  readonly body: Record<string, unknown>
}

/** RouteAnswer is a route's success answer: a status plus a JSON payload. */
interface RouteAnswer {
  readonly status: number
  readonly json: unknown
}

type RouteRun = (input: RouteInput) => Promise<RouteAnswer>

/** Scoped context narrowed to the two services {@link apply} waits for. */
export type ObsidianMemRouteScope = Context & {
  webServer: WebServerService
  obsidianMem: RouteService
}

/** Ok answers 200 with a JSON payload. */
function ok(json: unknown, status = 200): RouteAnswer {
  return { status, json }
}

/** RequiredString reads a non-blank string body field or answers the named 400 code. */
function requiredString(body: Record<string, unknown>, key: string, code: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RouteError(400, code, `${key} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * VaultAnswer maps a service add/remove refusal onto the code the card
 * branches on. The service refuses with plain Errors whose stable message
 * wording its own specs pin (addVault/removeVault prefixes, owner phrases);
 * the substrings below are the coupling, and the message passes through
 * verbatim because it names the actionable place (row config, card, default
 * vault) to act.
 */
function vaultAnswer(error: unknown): never {
  const message = errorText(error)
  if (message.includes('is already registered')) {
    throw new RouteError(409, ROUTE_ERROR_CODES.vaultConflict, message)
  }
  if (message.includes('managed by the obsidian-mem-service') || message.includes('auto-provisioned default vault')) {
    throw new RouteError(409, ROUTE_ERROR_CODES.vaultProtected, message)
  }
  if (message.includes('is not a registered vault')) {
    throw new RouteError(404, ROUTE_ERROR_CODES.vaultNotFound, message)
  }
  throw new RouteError(400, ROUTE_ERROR_CODES.vaultInvalid, message)
}

/** ErrorText renders an unknown failure's message only, never its stack. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** BoundedInt reads a query int within [1, ceiling]; default when absent; throws the named 400 code when unusable. */
function boundedIntParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
  ceiling: number,
  code: string,
): number {
  const raw = params.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RouteError(400, code, `${key} must be a positive integer, got "${raw}"`)
  }
  return Math.min(value, ceiling)
}

/**
 * StatusPayload answers the status route: the seam's sync status plus the
 * noticeActive flag the card's banner gates on. It never provisions.
 */
function statusPayload(service: RouteService): RouteAnswer {
  const status = service.status()
  return ok({ ...status, noticeActive: status.notice !== null })
}

/** DreamStatePayload answers { lastDreamAt, promptPath } from the sync status snapshot. */
function dreamStatePayload(service: RouteService): RouteAnswer {
  const status = service.status()
  return ok({
    lastDreamAt: status.dream.lastDreamAt,
    promptPath: join(status.milvus.dbPath, DREAM_PROMPT_FILE),
  })
}

/**
 * DreamRunOutcome attaches the swallowing logging catch to a launched run's
 * `done` (the ext discipline: the route never awaits it inline, never drops
 * it), then answers 202 with the run id.
 */
function dreamRunOutcome(result: DreamEngineResult, log: RouteLogger): RouteAnswer {
  if (result.operation !== 'run') {
    throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.dreamFailed, 'dream run request answered a plan')
  }
  result.done.then(
    (summary) => {
      log.info(`dream run ${summary.id} finished: ok=${String(summary.ok)} ${summary.summary}`)
    },
    (error: unknown) => {
      log.warn(`dream run ${result.id} failed: ${errorText(error)}`)
    },
  )
  return ok({ started: true, id: result.id }, 202)
}

/** RequireJsonMediaType answers 415 unless the request names the application/json media type. */
function requireJsonMediaType(req: IncomingLike): void {
  const mediaType = String(req.headers['content-type'] ?? '')
    .split(';', 1)
    .join('')
    .trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    throw new RouteError(415, ROUTE_ERROR_CODES.unsupportedMediaType, 'request body must be application/json')
  }
}

/** CollectBody reads the request stream up to the ceiling; past it the body is destroyed and 413 thrown. */
async function collectBody(req: IncomingLike): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      throw new RouteError(413, ROUTE_ERROR_CODES.payloadTooLarge, 'request body exceeds the 64 KiB ceiling')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** ReadBody enforces the wire contract every body route shares: a JSON object under the ceiling. */
async function readBody(req: IncomingLike): Promise<Record<string, unknown>> {
  requireJsonMediaType(req)
  const text = await collectBody(req)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RouteError(400, ROUTE_ERROR_CODES.invalidJsonBody, 'request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouteError(400, ROUTE_ERROR_CODES.invalidJsonBody, 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * DefineRoute builds the one webServer record for one path: trust fence first
 * (the `connection` service's rejection answered as-is, skipped when the
 * composition carries none), then method dispatch against the declared
 * method map (a method it omits answers 405 with the declared methods as
 * `allow`; the own-property test keeps inherited Object members from reading
 * as handlers), then the bounded JSON body for every non-GET method, then
 * the run's answer as JSON with `cache-control: no-store`. A RouteError
 * answers its own status and envelope; anything else answers 500 with
 * `internal_error` and the logged message, and no stack ever reaches the
 * wire.
 */
function defineRoute(ctx: Context, spec: {
  readonly name: string
  readonly path: string
  readonly methods: Readonly<Partial<Record<RouteMethod, RouteRun>>>
}): WebServerRoute {
  return {
    kind: 'exact',
    path: spec.path,
    name: spec.name,
    handler: async (req, res) => {
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(json))
      }
      try {
        const connection = Reflect.get(ctx, 'connection') as ConnectionGateway | undefined
        if (connection !== undefined) {
          const rejection = connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'cache-control': 'no-store' }).end()
            return
          }
        }
        const run = Object.hasOwn(spec.methods, req.method)
          ? spec.methods[req.method as RouteMethod]
          : undefined
        if (run === undefined) {
          res.writeHead(405, {
            allow: Object.keys(spec.methods).join(', '),
            'cache-control': 'no-store',
          }).end()
          return
        }
        try {
          const body = req.method === 'GET' ? {} : await readBody(req)
          const answer = await run({
            params: new URL(req.url, 'http://obsidian-mem.invalid').searchParams,
            body,
          })
          send(answer.status, answer.json)
        } catch (error) {
          if (error instanceof RouteError) {
            send(error.status, errorEnvelope(error.code, error.message))
            return
          }
          ctx.logger('obsidian-mem').warn(`route ${spec.name} failed: ${errorText(error)}`)
          send(INTERNAL_ERROR_STATUS, errorEnvelope(ROUTE_ERROR_CODES.internalError, errorText(error)))
        }
      } catch (error) {
        // The fence/dispatch path itself failed; still an envelope, still no stack.
        ctx.logger('obsidian-mem').warn(`route ${spec.name} envelope failure: ${errorText(error)}`)
        try {
          send(INTERNAL_ERROR_STATUS, errorEnvelope(ROUTE_ERROR_CODES.internalError, errorText(error)))
        } catch {
          res.end()
        }
      }
    },
  }
}

/** ScheduleCatalogRow is the catalog-entry slice the routes read (structurally typed; the schedule package stays a reflection-only peer). */
interface ScheduleCatalogRow {
  id: string
  title: string
  prompt: string
  kind: string
  scheduledAt: string
  sessionId: string
  status?: 'active' | 'inactive'
}

/** ScheduleCreateBody is the `create` request as @deepseek-ai/dsh-schedule declares it (title required, exactly one timing). */
type ScheduleCreateBody = { prompt: string, title: string } & (
  | { every_seconds: number, cron?: never }
  | { cron: { expression: string, time_zone: string }, every_seconds?: never }
)

/** ScheduleGateway is the trio the `schedule_create` tool calls, read through `ctx.get('schedule')`. */
export interface ScheduleGateway {
  create(sessionId: string, request: ScheduleCreateBody): Promise<unknown>
  catalog(): Promise<ScheduleCatalogRow[]>
  delete(request: { sessionId: string, id: string }): Promise<{ deleted: boolean }>
}

/** The ScheduleInputError codes the service throws on a rejected create; subagent_session answers 409, the rest 400. */
const SCHEDULE_REJECTION_CODES: readonly string[] = [
  'invalid_prompt',
  'invalid_selector',
  'invalid_rule',
  'invalid_time_zone',
  'not_future',
  'time_out_of_range',
  'frequency_too_high',
  'subagent_session',
]

/** ScheduleGatewayOf resolves the optional host service; presence is read through this ONE function. */
function scheduleGatewayOf(ctx: Context): ScheduleGateway | undefined {
  return ctx.get('schedule') as ScheduleGateway | undefined
}

/** DreamSchedulePrompt renders the wake instruction; the trigger name rides in it because the title is the ownership tag. */
function dreamSchedulePrompt(label: string): string {
  return `Scheduled obsidian-mem dreaming "${label}": call the memory_dream tool with operation "run" now. `
    + 'Do not await the run in this turn; the dream continues in the background.'
}

/**
 * ParseScheduleUpsert validates the card body: a safe-slug id, a bounded
 * label, a named target sessionId (a browser caller has none, so the body
 * names it, the ext rule), and exactly one of expression / everySeconds at
 * the wire bound here (the service owns the deep cron and time-zone
 * semantics and its ScheduleInputError answers them).
 */
function parseScheduleUpsert(body: Record<string, unknown>): {
  id: string
  label: string
  sessionId: string
  request: { every_seconds: number } | { cron: { expression: string, time_zone: string } }
} {
  const rawId = body['id']
  if (typeof rawId !== 'string' || !SCHEDULE_ID_PATTERN.test(rawId)) {
    throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid,
      'id must match [a-z0-9][a-z0-9._-]{0,63} (case-insensitive)')
  }
  const rawLabel = body['label']
  if (typeof rawLabel !== 'string' || rawLabel.trim() === '' || rawLabel.length > SCHEDULE_LABEL_MAX_LENGTH) {
    throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid,
      `label must be a non-empty string of at most ${String(SCHEDULE_LABEL_MAX_LENGTH)} characters`)
  }
  const sessionId = requiredString(body, 'sessionId', ROUTE_ERROR_CODES.scheduleInvalid)
  const expression = body['expression']
  const everySeconds = body['everySeconds']
  if ((expression === undefined) === (everySeconds === undefined)) {
    throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid,
      'exactly one of expression or everySeconds is required')
  }
  if (everySeconds !== undefined) {
    if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds)) {
      throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid, 'everySeconds must be an integer number of seconds')
    }
    if (everySeconds < SCHEDULE_MIN_INTERVAL_SECONDS) {
      throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid,
        `everySeconds must be at least ${String(SCHEDULE_MIN_INTERVAL_SECONDS)}`)
    }
    return { id: rawId, label: rawLabel.trim(), sessionId, request: { every_seconds: everySeconds } }
  }
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid, 'expression must be a non-empty cron expression')
  }
  const timeZone = body['timeZone']
  if (timeZone !== undefined && (typeof timeZone !== 'string' || timeZone.trim() === '')) {
    throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid, 'timeZone must be a non-empty IANA zone name')
  }
  return {
    id: rawId,
    label: rawLabel.trim(),
    sessionId,
    request: { cron: { expression: expression.trim(), time_zone: typeof timeZone === 'string' ? timeZone.trim() : 'UTC' } },
  }
}

/** ScheduleRejection maps a service throw: a known ScheduleInputError code answers 400 (subagent_session 409); anything else is schedule_failed. */
function scheduleRejection(error: unknown): never {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && SCHEDULE_REJECTION_CODES.includes(code)) {
    throw new RouteError(
      code === 'subagent_session' ? 409 : 400,
      code,
      errorText(error),
    )
  }
  throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.scheduleFailed, errorText(error))
}

/** ScheduleRuns is the dreaming-trigger trio: list, upsert, and remove. */
interface ScheduleRuns {
  readonly list: RouteRun
  readonly upsert: RouteRun
  readonly remove: RouteRun
}

/**
 * ScheduleRuns builds the dreaming-trigger trio over the reflection gateway,
 * mounted as the three methods of one route record: list shows the
 * plugin-owned live entries and echoes the row-config definitions read-only;
 * upsert replaces the entry carrying the same ownership title, then creates
 * through the service; remove proves the title against the live catalog
 * before removing through the service. Every run answers 503
 * `schedule_unavailable` while the profile carries no schedule service.
 */
function scheduleRuns(deps: RouteDeps): ScheduleRuns {
  const gateway = (): ScheduleGateway => {
    const service = scheduleGatewayOf(deps.ctx)
    if (service === undefined) {
      throw new RouteError(503, ROUTE_ERROR_CODES.scheduleUnavailable,
        'this host provides no schedule service, so dreaming triggers cannot be listed or edited')
    }
    return service
  }
  return {
    list: async () => {
      const service = gateway()
      const entries = (await service.catalog())
        .filter((entry) => entry.title.startsWith(SCHEDULE_TITLE_PREFIX))
        .map((entry) => ({
          ...entry,
          pluginId: entry.title.slice(SCHEDULE_TITLE_PREFIX.length),
        }))
      return ok({ entries, configured: deps.service.status().dreaming.schedules })
    },
    upsert: async ({ body }) => {
      const service = gateway()
      const parsed = parseScheduleUpsert(body)
      const title = `${SCHEDULE_TITLE_PREFIX}${parsed.id}`
      const prompt = dreamSchedulePrompt(parsed.label)
      const request: ScheduleCreateBody = 'every_seconds' in parsed.request
        ? { title, prompt, every_seconds: parsed.request.every_seconds }
        : { title, prompt, cron: parsed.request.cron }
      try {
        const owned = (await service.catalog()).filter((entry) => entry.title === title)
        for (const entry of owned) {
          await service.delete({ sessionId: entry.sessionId, id: entry.id })
        }
        const created = await service.create(parsed.sessionId, request)
        return ok({ id: parsed.id, label: parsed.label, replaced: owned.length > 0, entry: created })
      } catch (error) {
        return scheduleRejection(error)
      }
    },
    remove: async ({ body }) => {
      const service = gateway()
      const rawId = body['id']
      if (typeof rawId !== 'string' || !SCHEDULE_ID_PATTERN.test(rawId)) {
        throw new RouteError(400, ROUTE_ERROR_CODES.scheduleInvalid,
          'id must match [a-z0-9][a-z0-9._-]{0,63} (case-insensitive)')
      }
      const title = `${SCHEDULE_TITLE_PREFIX}${rawId}`
      const owned = (await service.catalog()).find((entry) => entry.title === title)
      if (owned === undefined) {
        throw new RouteError(404, ROUTE_ERROR_CODES.scheduleNotFound,
          `no dreaming trigger is registered for id "${rawId}"`)
      }
      const result = await service.delete({ sessionId: owned.sessionId, id: owned.id })
      if (!result.deleted) {
        throw new RouteError(404, ROUTE_ERROR_CODES.scheduleNotFound,
          `the trigger for id "${rawId}" was already removed`)
      }
      return ok({ deleted: true, id: rawId })
    },
  }
}

/**
 * RouteHandlers maps every `${method} ${path}` in {@link ROUTES} to its
 * factory. The registration refuses to mount when the two ever disagree, so
 * a contract entry without a handler is a build-time-visible error, not a
 * silently missing route.
 */
function routeHandlers(deps: RouteDeps): Map<string, RouteRun> {
  const planDream: RouteRun = async () => {
    const blocked = deps.service.status().dream.blocked
    if (blocked !== null) {
      // The plan only matters for a run; without an agents gateway that run
      // can never launch, so the card gets the structured hint, never a 500.
      throw new RouteError(503, ROUTE_ERROR_CODES.dreamUnavailable, blocked)
    }
    try {
      const result = await deps.service.dream({ operation: 'plan' })
      if (result.operation !== 'plan') {
        throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.dreamFailed, 'dream plan request answered a run')
      }
      return ok({ plan: result.plan })
    } catch (error) {
      if (error instanceof DreamBlockedError) {
        throw new RouteError(503, ROUTE_ERROR_CODES.dreamUnavailable, error.message)
      }
      if (error instanceof RouteError) throw error
      throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.dreamFailed, errorText(error))
    }
  }
  const runDream: RouteRun = async ({ body }) => {
    const blocked = deps.service.status().dream.blocked
    if (blocked !== null) {
      throw new RouteError(503, ROUTE_ERROR_CODES.dreamUnavailable, blocked)
    }
    const model = body['model']
    if (model !== undefined && typeof model !== 'string') {
      throw new RouteError(400, ROUTE_ERROR_CODES.invalidJsonBody, 'model must be a string model id')
    }
    try {
      const request: DreamRequest = { operation: 'run', ...(model !== undefined ? { model } : {}) }
      return dreamRunOutcome(await deps.service.dream(request), deps.log)
    } catch (error) {
      if (error instanceof DreamBusyError) {
        throw new RouteError(409, ROUTE_ERROR_CODES.dreamBusy, error.message)
      }
      if (error instanceof DreamBlockedError) {
        // A gateway that vanished between the status read and the guard.
        throw new RouteError(503, ROUTE_ERROR_CODES.dreamUnavailable, error.message)
      }
      if (error instanceof RouteError) throw error
      throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.dreamFailed, errorText(error))
    }
  }
  const handlers = new Map<string, RouteRun>()
  const add = (method: RouteMethod, path: string, run: RouteRun): void => {
    handlers.set(`${method} ${path}`, run)
  }

  add('GET', '/obsidian-mem/status', async () => statusPayload(deps.service))
  add('GET', '/obsidian-mem/vaults', async () => ok({ vaults: deps.service.listVaults() }))
  const schedules = scheduleRuns(deps)
  add('POST', '/obsidian-mem/vaults', async ({ body }) => {
    const path = requiredString(body, 'path', ROUTE_ERROR_CODES.vaultInvalid)
    const mode = body['mode']
    if (mode !== undefined && (typeof mode !== 'string' || !isVaultMode(mode))) {
      throw new RouteError(400, ROUTE_ERROR_CODES.vaultInvalid,
        `mode must be one of ${VAULT_MODES.join(' | ')}, got ${JSON.stringify(mode ?? null)}`)
    }
    const request: VaultAddRequest = { path, ...(mode !== undefined ? { mode } : {}) }
    try {
      return ok({ vault: deps.service.addVault(request) }, 201)
    } catch (error) {
      return vaultAnswer(error)
    }
  })
  add('DELETE', '/obsidian-mem/vaults', async ({ body }) => {
    const path = requiredString(body, 'path', ROUTE_ERROR_CODES.vaultInvalid)
    try {
      await deps.service.removeVault(path)
      return ok({ removed: true, path })
    } catch (error) {
      return vaultAnswer(error)
    }
  })
  add('GET', '/obsidian-mem/audit', async ({ params }) => {
    const rawView = params.get('view')
    let view: AuditView | undefined
    if (rawView !== null) {
      if (!(AUDIT_VIEWS as readonly string[]).includes(rawView)) {
        throw new RouteError(400, ROUTE_ERROR_CODES.auditInvalidView,
          `view must be one of ${AUDIT_VIEWS.join(' | ')}, got "${rawView}"`)
      }
      view = rawView as AuditView
    }
    const limit = params.has('limit')
      ? boundedIntParam(params, 'limit', 1, AUDIT_MAX_LIMIT, ROUTE_ERROR_CODES.auditInvalidLimit)
      : undefined
    try {
      const report = await deps.service.audit({
        ...(view !== undefined ? { view } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
      return ok({ report })
    } catch (error) {
      throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.auditFailed, errorText(error))
    }
  })
  add('GET', '/obsidian-mem/dream/plan', planDream)
  add('POST', '/obsidian-mem/dream/run', runDream)
  add('GET', '/obsidian-mem/dream/state', async () => dreamStatePayload(deps.service))
  add('GET', '/obsidian-mem/dreaming/schedules', schedules.list)
  add('POST', '/obsidian-mem/dreaming/schedules', schedules.upsert)
  add('DELETE', '/obsidian-mem/dreaming/schedules', schedules.remove)
  add('GET', '/obsidian-mem/search', async ({ params }) => {
    const query = params.get('q')
    if (query === null || query.trim() === '') {
      throw new RouteError(400, ROUTE_ERROR_CODES.searchInvalid, 'q must be a non-empty query string')
    }
    const topK = boundedIntParam(params, 'topK', SEARCH_PROBE_MAX_TOP_K, SEARCH_PROBE_MAX_TOP_K,
      ROUTE_ERROR_CODES.searchInvalid)
    try {
      const results = await deps.service.search({ query: query.trim(), topK })
      return ok({ results, query: query.trim(), topK })
    } catch (error) {
      if (error instanceof IndexOfflineError) {
        // 503: the index is cold, crashed, or terminal-degraded in this
        // process (a retry or a host restart may bring it back).
        throw new RouteError(503, ROUTE_ERROR_CODES.indexOffline, error.message)
      }
      throw new RouteError(INTERNAL_ERROR_STATUS, ROUTE_ERROR_CODES.searchFailed, errorText(error))
    }
  })
  return handlers
}

/**
 * BuildRoutes turns {@link ROUTES} into one webServer record per path: the
 * contract's methods (in contract order, which becomes the `allow` header)
 * joined through the {@link routeHandlers} map. An endpoint the handlers do
 * not cover throws at build time, which cordis reports as the ui fiber
 * failing, never as a half-mounted route table.
 */
export function buildRoutes(deps: RouteDeps): WebServerRoute[] {
  const handlers = routeHandlers(deps)
  const methodsByPath = new Map<string, RouteMethod[]>()
  for (const route of ROUTES) {
    const listed = methodsByPath.get(route.path)
    if (listed === undefined) {
      methodsByPath.set(route.path, [route.method])
    } else {
      listed.push(route.method)
    }
  }
  return [...methodsByPath.entries()].map(([path, declared]) => {
    const methods: Partial<Record<RouteMethod, RouteRun>> = {}
    for (const method of declared) {
      const run = handlers.get(`${method} ${path}`)
      if (run === undefined) {
        throw new Error(`obsidian-mem ui: ROUTES declares ${method} ${path} but no handler covers it`)
      }
      methods[method] = run
    }
    return defineRoute(deps.ctx, {
      name: `obsidian-mem: ${path.slice('/obsidian-mem/'.length)}`,
      path,
      methods,
    })
  })
}

/**
 * RegisterObsidianMemRoutes mounts every route record under one scope effect
 * so a bundle switch off unregisters them before a switch on re-registers
 * (the local-infer / ext route-holding idiom).
 */
export function registerObsidianMemRoutes(scope: ObsidianMemRouteScope, ctx: Context): void {
  const log = ctx.logger('obsidian-mem')
  const routes = buildRoutes({ ctx, service: scope.obsidianMem, log })
  scope.effect(() => {
    const disposers = routes.map((route) => scope.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        dispose()
      }
    }
  }, 'obsidian-mem: settings routes')
}

export const name = 'obsidian-mem-ui'

/** Static wait for the seam (mirrors the tools/events rows); webServer joins as a scoped inject so a headless profile never mounts the routes. */
export const inject: string[] = [OBSIDIAN_MEM_SEAM]

/**
 * Mount the `/obsidian-mem/*` routes. The scoped inject waits for `webServer`
 * plus the seam, so a profile without the web carrier keeps the service and
 * tools untouched; the `connection` trust fence is read by reflection inside
 * the handlers when the composition carries one.
 */
export function apply(ctx: Context): void {
  ctx.inject([OBSIDIAN_MEM_SEAM, 'webServer'], (scope) => {
    const target = scope as unknown as ObsidianMemRouteScope
    registerObsidianMemRoutes(target, ctx)
  })
}

/**
 * The dreaming trigger trio's structural gateway type plus the envelope and
 * contract surface TASK-051's card mirrors; exported so the card tests pin
 * them against the routes.
 */
export { errorEnvelope }
export type { ObsidianMemStatus, ScheduleCatalogRow }

const plugin = { name, inject, apply }
export default plugin
