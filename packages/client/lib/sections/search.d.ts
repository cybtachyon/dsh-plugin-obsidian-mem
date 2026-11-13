/**
 * The Search test panel: run one hybrid query (q + topK capped at 10)
 * against the live index and show the ranked results, so the operator can
 * see what recall actually retrieves before trusting the lifecycle
 * injections. An offline or degraded index answers 503 index_offline: the
 * panel shows that as a quiet note (the index, not the query, is down), any
 * other error renders verbatim.
 * @module dsh-plugin-obsidian-mem/client/sections/search
 */
import type { ReactNode } from 'react';
export declare function SearchSection(): ReactNode;
//# sourceMappingURL=search.d.ts.map
