/**
 * Ok centralizes the Milvus response guard. The @zilliz/milvus2-sdk-node
 * 3.0.6 SDK resolves on server errors instead of rejecting, so every
 * response must pass assertOk before its payload is trusted.
 * @module dsh-plugin-obsidian-mem/service/milvus/ok
 */
/**
 * AssertOk returns the response when its status is Success and throws
 * otherwise. Status placement differs per method (findings G1, G2):
 * createCollection/dropCollection/createIndex resolve to a bare ResStatus,
 * while insert/delete/query/search/get/count nest it under .status; the
 * `response.status ?? response` read covers both shapes.
 */
export declare function assertOk<T>(response: T, what: string): T;
//# sourceMappingURL=ok.d.ts.map
