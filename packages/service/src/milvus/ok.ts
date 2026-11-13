/**
 * Ok centralizes the Milvus response guard. The @zilliz/milvus2-sdk-node
 * 3.0.6 SDK resolves on server errors instead of rejecting, so every
 * response must pass assertOk before its payload is trusted.
 * @module dsh-plugin-obsidian-mem/service/milvus/ok
 */

import type { ResStatus } from '@zilliz/milvus2-sdk-node'

/**
 * AssertOk returns the response when its status is Success and throws
 * otherwise. Status placement differs per method (findings G1, G2):
 * createCollection/dropCollection/createIndex resolve to a bare ResStatus,
 * while insert/delete/query/search/get/count nest it under .status; the
 * `response.status ?? response` read covers both shapes.
 */
export function assertOk<T>(response: T, what: string): T {
  const status = ((response as { status?: ResStatus } | null)?.status
    ?? response) as Partial<ResStatus> | null | undefined
  if (status?.error_code && status.error_code !== 'Success') {
    const reason = status.reason ?? status.detail ?? ''
    throw new Error(`milvus ${what}: ${status.error_code} ${reason}`.trim())
  }
  return response
}
