/**
 * Route contract tests: every route the client card fetches must exist in
 * the ui package's ROUTES table with the same method, and the only route
 * the host registers that the card does not fetch is GET /vaults (the row
 * list already rides the status poll). The error codes the card branches on
 * must exist in the host's ROUTE_ERROR_CODES vocabulary.
 * @module dsh-plugin-obsidian-mem/client/tests/routes
 */

import { describe, expect, it } from 'vitest'

import { ROUTES, ROUTE_ERROR_CODES } from '../../ui/lib/index.js'
import { ERROR_CODES } from '../src/api.ts'
import { ALL_CARD_ROUTES } from '../src/routes.ts'

describe('card routes vs the ui ROUTES contract', () => {
  it('every card route exists in ROUTES with the same method', () => {
    for (const route of ALL_CARD_ROUTES) {
      const match = ROUTES.some(
        (declared) => declared.method === route.method && declared.path === route.path,
      )
      expect(
        match,
        `card fetches ${route.method} ${route.path}, which is not in ROUTES`,
      ).toBe(true)
    }
  })

  it('the host registers no obsidian-mem route the card forgot to reach', () => {
    const fetched = new Set(ALL_CARD_ROUTES.map((route) => `${route.method} ${route.path}`))
    const unread = ROUTES
      .filter((declared) => !fetched.has(`${declared.method} ${declared.path}`))
      .map((declared) => `${declared.method} ${declared.path}`)
    // One deliberate exception: GET /vaults answers other consumers, but the
    // card's vault rows come from the /status poll it already runs.
    expect(unread).toEqual(['GET /obsidian-mem/vaults'])
  })
})

describe('card error-code branches vs ROUTE_ERROR_CODES', () => {
  it('every code the card branches on exists in the host vocabulary', () => {
    const known = new Set<string>(Object.values(ROUTE_ERROR_CODES))
    for (const [name, code] of Object.entries(ERROR_CODES)) {
      expect(known.has(code), `card code "${name}" -> "${code}" is not in ROUTE_ERROR_CODES`).toBe(true)
    }
  })
})
