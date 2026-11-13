/**
 * Shared test kit for the ui route specs: a fake webServer that reproduces
 * the host's (kind, path) duplicate-throw table, a fake cordis context whose
 * scoped `inject` only fires when every named service is present, a fake
 * RouteService with per-run failure and result knobs, a fake schedule
 * gateway trio, node-http-shaped request/response doubles, and the request
 * driver every spec asserts through.
 * @module dsh-plugin-obsidian-mem/ui/tests/testkit
 */

import { Buffer } from 'node:buffer'
import type { IncomingLike, OutgoingLike, RouteService, ScheduleGateway, WebServerRoute } from '../src/index.ts'
import { ROUTES } from '../src/index.ts'
import type { ObsidianMemStatus, VaultEntry } from '../../service/lib/index.js'
import type { AuditReport, AuditRequest } from '../../service/lib/audit.js'
import type { DreamEngineResult, DreamRequest, DreamRunSummary } from '../../service/lib/dream.js'
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js'

/** One registered record of the fake route table. */
export type FakeRouteRecord = WebServerRoute

/**
 * FakeWebServer mirrors @deepseek-ai/dsh-host-webserver's contract: register
 * keys by (kind, path), THROWS on a duplicate, and returns the disposer that
 * removes the record. A route scope registering one path twice therefore
 * fails here exactly as it does at boot on the host.
 */
export class FakeWebServer {
  readonly records: FakeRouteRecord[] = []

  register(route: WebServerRoute): () => void {
    const clash = this.records.some(
      (record) => record.kind === route.kind && record.path === route.path,
    )
    if (clash) {
      throw new Error(`duplicate route (${route.kind}, ${route.path})`)
    }
    const record: FakeRouteRecord = { ...route }
    this.records.push(record)
    return () => {
      const index = this.records.indexOf(record)
      if (index >= 0) this.records.splice(index, 1)
    }
  }
}

/** FakeLogger records warn/info lines the routes log through. */
export class FakeLogger {
  readonly warns: string[] = []
  readonly infos: string[] = []

  logger(): {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    debug(message: string): void
  } {
    return {
      info: (message) => { this.infos.push(message) },
      warn: (message) => { this.warns.push(message) },
      error: (message) => { this.warns.push(`error: ${message}`) },
      debug: () => undefined,
    }
  }
}

/** Knobs of the fake RouteService; each error fires the seam throw under test. */
export interface RouteServiceOptions {
  status?: () => ObsidianMemStatus
  vaults?: VaultEntry[]
  addVaultError?: Error
  removeVaultError?: Error
  auditError?: Error
  auditReport?: AuditReport
  dreamError?: Error
  dreamResult?: DreamEngineResult
  searchError?: Error
  searchResults?: MemorySearchResult[]
}

/** Recorded seam calls the specs assert pass-through shapes on. */
export interface RouteServiceCalls {
  addVault: { path: string, mode?: string }[]
  removeVault: string[]
  audit: AuditRequest[]
  dream: DreamRequest[]
  search: SearchRequest[]
}

/** FakeRouteService is the seam slice behind the routes, with call recording. */
export interface FakeRouteService {
  service: RouteService
  calls: RouteServiceCalls
}

/** MakeRouteService builds the fake seam from the run's knobs. */
export function makeRouteService(options: RouteServiceOptions = {}): RouteService {
  return makeRouteServiceWithCalls(options).service
}

/** MakeRouteServiceWithCalls also hands back the call recorder. */
export function makeRouteServiceWithCalls(options: RouteServiceOptions = {}): FakeRouteService {
  const calls: RouteServiceCalls = { addVault: [], removeVault: [], audit: [], dream: [], search: [] }
  const service: RouteService = {
    status: options.status ?? (() => baseStatus()),
    listVaults: () => options.vaults ?? [],
    addVault: (request) => {
      calls.addVault.push(request)
      if (options.addVaultError !== undefined) throw options.addVaultError
      return { path: '/vault/added', mode: 'shared', source: 'card' }
    },
    removeVault: async (path) => {
      calls.removeVault.push(path)
      if (options.removeVaultError !== undefined) throw options.removeVaultError
    },
    audit: async (request = {}) => {
      calls.audit.push(request)
      if (options.auditError !== undefined) throw options.auditError
      return options.auditReport ?? ({ view: request.view ?? 'full' } as unknown as AuditReport)
    },
    dream: async (request = {}) => {
      calls.dream.push(request)
      if (options.dreamError !== undefined) throw options.dreamError
      return options.dreamResult ?? {
        operation: 'plan',
        plan: { generatedAt: 1_700_000_000_000, lastDreamAt: null } as never,
      }
    },
    search: async (request) => {
      calls.search.push(request)
      if (options.searchError !== undefined) throw options.searchError
      return options.searchResults ?? []
    },
  }
  return { service, calls }
}

/** Complete ObsidianMemStatus with the ready-state defaults every spec starts from. */
export function baseStatus(overrides: Partial<ObsidianMemStatus> = {}): ObsidianMemStatus {
  return {
    state: 'ready',
    notice: null,
    defaultVaultPath: null,
    vaults: [{ path: '/home/u/.dsh/obsidian-mem', mode: 'shared', source: 'default' }],
    vectorDim: 384,
    model: { id: 'Xenova/multilingual-e5-small', dtype: 'q8' },
    milvus: {
      mode: 'spawn',
      address: '127.0.0.1:19530',
      dbPath: '/home/u/.dsh/obsidian-mem-db',
      version: '3.2.2',
      degraded: false,
      error: null,
      readinessTimeoutMs: 600_000,
    },
    indexer: { indexed: 12, pending: 0, errors: 0, llmErrors: 0 },
    budgets: {
      turnStartRecallTokens: 600,
      globalMemoryTokens: 20_000,
      readSections: 4,
      readSectionTokens: 250,
      searchTopK: 6,
      thinkShotsPerTurn: 1,
    },
    dreaming: {
      schedules: [{ id: 'nightly', label: 'Nightly sweep', everySeconds: 86_400 }],
      model: '',
      nearDuplicateThreshold: 0.9,
    },
    dream: { state: 'idle', blocked: null, lastDreamAt: 1_700_000_000_000, lastRun: null },
    ...overrides,
  }
}

/** Recorded schedule-gateway calls. */
export interface ScheduleGatewayCalls {
  create: { sessionId: string, request: unknown }[]
  delete: { sessionId: string, id: string }[]
}

/** Catalog rows the fake gateway serves; defaults to one owned plus one foreign entry. */
export interface FakeScheduleOptions {
  entries?: {
    id: string
    title: string
    prompt?: string
    kind?: string
    scheduledAt?: string
    sessionId?: string
    status?: 'active' | 'inactive'
  }[]
  createError?: Error
  deleteResult?: { deleted: boolean }
}

/** FakeScheduleGateway records create/delete and serves the catalog list. */
export function makeScheduleGateway(options: FakeScheduleOptions = {}): {
  gateway: ScheduleGateway
  calls: ScheduleGatewayCalls
} {
  const calls: ScheduleGatewayCalls = { create: [], delete: [] }
  const entries = (options.entries ?? [
    { id: 'task-1', title: 'obsidian-mem dream:nightly', prompt: 'wake', scheduledAt: '2026-11-13T08:00:00Z', sessionId: 'sess-1', status: 'active' as const },
    { id: 'foreign-1', title: 'someone elses reminder', prompt: 'other', scheduledAt: '2026-11-14T08:00:00Z', sessionId: 'sess-2', status: 'active' as const },
  ]).map((entry) => ({
    prompt: 'wake',
    kind: 'every',
    scheduledAt: '2026-11-13T08:00:00Z',
    sessionId: 'sess-1',
    status: 'active' as const,
    ...entry,
  }))
  return {
    calls,
    gateway: {
      catalog: async () => entries.map((entry) => ({ ...entry })),
      create: async (sessionId, request) => {
        calls.create.push({ sessionId, request })
        if (options.createError !== undefined) throw options.createError
        return { id: 'made-1', sessionId, ...request }
      },
      delete: async (request) => {
        calls.delete.push(request)
        if (options.deleteResult !== undefined) return options.deleteResult
        return { deleted: true }
      },
    },
  }
}

/** FakeCordisContextOptions carry the services the faked mount resolves. */
export interface FakeCordisContextOptions {
  obsidianMem: RouteService
  /** Omit (or pass a FakeWebServer) for a web profile; pass undefined for headless. */
  webServer?: FakeWebServer | undefined
  schedule?: ScheduleGateway | undefined
  connection?: { requestRejection(req: IncomingLike): number | undefined } | undefined
}

/**
 * FakeCordisContext reproduces the mount mechanics the ui row exercises:
 * scoped `ctx.inject(names, cb)` runs the callback only when every named
 * service resolves, `ctx.effect(fn)` runs fn now and keeps the disposer, and
 * `ctx.get(name)` answers for the reflection gateways.
 */
export class FakeCordisContext {
  readonly webServer: FakeWebServer
  readonly obsidianMem: RouteService
  readonly connection?: { requestRejection(req: IncomingLike): number | undefined }
  readonly loggerService = new FakeLogger()
  readonly disposers: (() => void)[] = []
  private readonly services: Record<string, unknown>

  constructor(options: FakeCordisContextOptions) {
    this.webServer = options.webServer ?? new FakeWebServer()
    this.obsidianMem = options.obsidianMem
    if (options.connection !== undefined) this.connection = options.connection
    const headless = 'webServer' in options && options.webServer === undefined
    this.services = {
      obsidianMem: options.obsidianMem,
      webServer: headless ? undefined : this.webServer,
      schedule: options.schedule,
      connection: options.connection,
    }
  }

  /** Scoped inject: fires the callback only when every named service exists. */
  inject(names: string[], callback: (scope: unknown) => void): void {
    if (names.every((dep) => this.services[dep] !== undefined)) {
      callback(this)
    }
  }

  /** Effect: run the setup now; keep the disposer for the mount's teardown. */
  effect(setup: () => void | (() => void), _label?: string): void {
    const dispose = setup()
    if (typeof dispose === 'function') this.disposers.push(dispose)
  }

  /** Reflection gateway: unknown names answer undefined, as on the host. */
  get(name: string): unknown {
    return this.services[name]
  }

  logger(_name: string): ReturnType<FakeLogger['logger']> {
    return this.loggerService.logger()
  }

  disposeAll(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}

/** Make a fake incoming request; body chunks default to one JSON buffer. */
export function makeRequest(options: {
  method: string
  url: string
  body?: unknown
  chunks?: Buffer[]
  /** null omits the content-type header entirely. */
  contentType?: string | null
}): { req: IncomingLike, destroyed: () => boolean } {
  const chunks = options.chunks
    ?? (options.body !== undefined ? [Buffer.from(JSON.stringify(options.body))] : [])
  let destroyed = false
  const headers: Record<string, string> = {}
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json'
  }
  const req: IncomingLike = {
    method: options.method,
    url: options.url,
    headers,
    destroy: () => { destroyed = true },
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: async (): Promise<IteratorResult<Buffer>> => index < chunks.length
          ? { value: chunks[index++] as Buffer, done: false }
          : { value: undefined as never, done: true },
      }
    },
  }
  return { req, destroyed: () => destroyed }
}

/** FakeResponse doubles the node ServerResponse members the routes write. */
export class FakeResponse implements OutgoingLike {
  status = 0
  headers: Record<string, string> = {}
  body: string | undefined = undefined

  writeHead(status: number, headers?: Record<string, string>): OutgoingLike {
    this.status = status
    Object.assign(this.headers, headers ?? {})
    return this
  }

  end(body?: string): void {
    this.body = body ?? ''
  }

  /** Parse the written body; throws the assertion-friendly error when absent. */
  json<T = unknown>(): T {
    if (this.body === undefined) throw new Error('response never ended')
    return JSON.parse(this.body) as T
  }
}

/** A driven route answer: status, headers, and the parsed JSON envelope/payload. */
export interface RouteResponse {
  status: number
  headers: Record<string, string>
  text: string
  json: unknown
}

/**
 * Send drives one recorded route record by url pathname, mirroring how the
 * web server dispatches an exact match. It throws when no record owns the
 * path, which is itself the one-record-per-path assertion's teeth.
 */
export async function send(
  context: FakeCordisContext,
  method: string,
  url: string,
  body?: unknown,
): Promise<RouteResponse> {
  const response = await sendRaw(context, method, url, { body })
  return response
}

/** SendRaw is Send with the request-shaping knobs (chunked or malformed bodies). */
export async function sendRaw(
  context: FakeCordisContext,
  method: string,
  url: string,
  request: { body?: unknown, chunks?: Buffer[], contentType?: string | null } = {},
): Promise<RouteResponse> {
  const pathname = new URL(url, 'http://obsidian-mem.test').pathname
  const record = context.webServer.records.find((candidate) => candidate.path === pathname)
  if (record === undefined) {
    throw new Error(`no route record owns ${pathname}`)
  }
  const { req } = makeRequest({ method, url, ...request })
  const res = new FakeResponse()
  await record.handler(req, res)
  return {
    status: res.status,
    headers: res.headers,
    text: res.body ?? '',
    json: res.body === undefined || res.body === '' ? null : JSON.parse(res.body) as unknown,
  }
}

/** The error envelope shape the specs destructure. */
export interface ErrorBody {
  error: { code: string, message: string }
}

/** EnvelopeOf narrows a parsed answer to the `{ error: { code, message } }` shape. */
export function envelopeOf(json: unknown): ErrorBody {
  return json as ErrorBody
}

/** The twelve contract endpoints minus vault-list duplicates, for sweep tests. */
export const ALL_ENDPOINTS = ROUTES.map((route) => `${route.method} ${route.path}`)

/** A DreamRunSummary fixture for run-outcome assertions. */
export function dreamSummary(id: string): DreamRunSummary {
  return {
    id,
    startedAt: 1,
    finishedAt: 2,
    ok: true,
    notes: 0,
    bumped: 0,
    degraded: 0,
    archiveCandidates: [],
    summary: 'nothing to commit; bumped 0, degraded 0',
    error: null,
  }
}

/** A MemorySearchResult row for search answers. */
export function searchRow(path: string): MemorySearchResult {
  return {
    chunk_id: 1,
    source_path: path,
    section_header: 'H',
    chunk_text: 'text',
    scope: 'global',
    vault: '/home/u/.dsh/obsidian-mem',
    mode: 'shared',
    updated_at: 0,
    score: 0.5,
  }
}
