/**
 * The `ctx.obsidianMem` Cordis service row: the vault registry, embedder,
 * Milvus-Lite lifecycle, indexer manager, and hybrid search behind the
 * memory_* tools. Activation stays side-effect free; `ensureMemoryAccess()`
 * provisions the default vault, the database, and the collection lazily on
 * the first memory access (Decision log "Lazy default vault").
 *
 * Row shape (verified against the installed @deepseek-ai/cordis 4.1.0):
 * the default export is the `ObsidianMemService` class. cordis treats a
 * class as a plugin (`RegistryService.resolve` → callback = the class;
 * `Fiber` runs `new callback(ctx, config)` then `[Service.init]()`), reads
 * the static `Config` (a Standard-Schema) in the `internal/config`
 * waterfall, and reads the static `inject` with {@link OBSIDIAN_MEM_SEAM}
 * left to its empty default so the row also loads inertly in profiles
 * without consumers. The seam itself is published by the constructor's
 * `super(ctx, 'obsidianMem')`; the patch rows carrying
 * `inject: ['obsidianMem']` (tools, events) resolve against it. This is the
 * engramory-ext §2.2 shape, so the `apply(ctx, config)` fallback was not
 * needed.
 * @module dsh-plugin-obsidian-mem/service
 */

import { ObsidianMemService } from './service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The obsidianMem seam: lazy-provisioned shared-markdown-vault memory. */
    obsidianMem: ObsidianMemService
  }
}

export {
  nodeServiceFs,
  OBSIDIAN_MEM_SEAM,
  ObsidianMemService,
  VAULTS_FILE_NAME,
} from './service.js'
export type {
  GlobalMemoryIndex,
  IndexerLike,
  MilvusLauncherLike,
  ObsidianMemHooks,
  ObsidianMemReadResult,
  ObsidianMemStatus,
  ObsidianMemWriteRequest,
  ObsidianMemWriteResult,
  ReadRegistryEntry,
  ServiceFs,
  VaultAddRequest,
  VaultEntry,
  VaultSource,
} from './service.js'

export {
  DEFAULT_READINESS_TIMEOUT_MS,
  ObsidianMemConfigSchema,
  resolveServiceConfig,
  UNKNOWN_CONFIG_KEYS,
  validateObsidianMemConfig,
  vaultKey,
} from './config.js'
export type {
  DreamingSchedule,
  ObsidianMemConfig,
  ObsidianMemResolvedConfig,
  ResolvedObsidianMemConfig,
} from './config.js'

export default ObsidianMemService
