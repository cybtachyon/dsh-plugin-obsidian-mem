/**
 * The fetch wrapper's contract, run against a stubbed global fetch: the
 * error envelope becomes an ApiError with the host code and VERBATIM
 * message (or an HTTP fallback for bodies that are not the envelope), POST
 * bodies are JSON with the content-type the routes require, query paths
 * encode q and clamp topK, and the probe reads any non-404 as present.
 * @module dsh-plugin-obsidian-mem/client/tests/api
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  addVault,
  ApiError,
  fetchAudit,
  probeSearch,
  removeVault,
  routeExists,
} from '../src/api.ts'

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/** StubFetch queues JSON answers (status + body) and records every call. */
function stubFetch(answers: Array<{ status: number, body: unknown | typeof NOT_JSON }>) {
  const calls: FetchCall[] = []
  let next = 0
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const answer = answers[Math.min(next, answers.length - 1)]!
    next += 1
    const ok = answer.status >= 200 && answer.status < 300
    return Promise.resolve({
      status: answer.status,
      ok,
      json: () => (answer.body === NOT_JSON
        ? Promise.reject(new Error('not json'))
        : Promise.resolve(answer.body)),
    } as Response)
  })
  return calls
}

const NOT_JSON = Symbol('not-json')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('error envelope handling', () => {
  it('turns the route envelope into an ApiError with the verbatim message', async () => {
    stubFetch([{
      status: 409,
      body: {
        error: {
          code: 'vault_protected',
          message: 'this vault comes from the plugin config; remove it there',
        },
      },
    }])
    const error = await removeVault('/home/test/vault').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(409)
    expect(apiError.code).toBe('vault_protected')
    expect(apiError.message).toBe('this vault comes from the plugin config; remove it there')
  })

  it('degrades a non-envelope body to an HTTP fallback message', async () => {
    stubFetch([{ status: 500, body: NOT_JSON }])
    const error = await removeVault('/x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('')
    expect((error as ApiError).message).toContain('HTTP 500')
  })

  it('passes the parsed answer through on success', async () => {
    const vault = { path: '/home/test/vault', mode: 'shared', source: 'card' }
    const calls = stubFetch([{ status: 201, body: vault }])
    await expect(addVault({ path: '/home/test/vault', mode: 'shared' })).resolves.toEqual(vault)
    expect(calls[0]!.url).toBe('/obsidian-mem/vaults')
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/vault', mode: 'shared' }),
    })
  })
})

describe('query construction', () => {
  it('encodes the audit view', async () => {
    const calls = stubFetch([{ status: 200, body: { report: {} } }])
    await fetchAudit('topStale')
    expect(calls[0]!.url).toBe('/obsidian-mem/audit?view=topStale')
  })

  it('encodes q and clamps topK to 1..10', async () => {
    const calls = stubFetch([{ status: 200, body: { results: [], query: 'a b', topK: 10 } }])
    await probeSearch('a b', 999)
    await probeSearch('caf\u00e9 na\u00efve', 0)
    expect(calls[0]!.url).toBe('/obsidian-mem/search?q=a%20b&topK=10')
    expect(calls[1]!.url).toBe('/obsidian-mem/search?q=caf%C3%A9%20na%C3%AFve&topK=1')
  })
})

describe('routeExists probe', () => {
  it('reads any answer but a 404 as present, and a network failure as absent', async () => {
    stubFetch([{ status: 404, body: {} }])
    expect(await routeExists()).toBe(false)
    stubFetch([{ status: 200, body: {} }])
    expect(await routeExists()).toBe(true)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    expect(await routeExists()).toBe(false)
  })
})
