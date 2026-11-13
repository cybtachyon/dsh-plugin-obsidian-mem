/**
 * QueryLabels is the committed eval data: 17 labeled queries replayed by
 * scripts/eval/recall-eval.mjs against the LIVE production `obsidian_mem`
 * collection (read-only).
 *
 * Provenance (see scripts/eval/README.md for the honest-uncertainty note):
 * - origin "transcript:<slug>/<session-id>" means the query text is the
 *   first `user/message` with `source.kind == "user"` of that session's
 *   `session.v4.jsonl.zstd` transcript (truncated to its leading
 *   request text; @-mention sigils and later paragraphs dropped). These
 *   are real turn-start queries the recall system faced in production.
 * - origin "in-domain:<topic>" means a hand-written query phrased like
 *   work in that project, to probe one known note on purpose.
 * - Cross-project control: lywa and guestwi.se queries measure whether
 *   one project's notes pollute another project's recall. The machinae-
 *   game queries originally had NO game-specific note (verified by
 *   read-only `chunk_text like "%machinae%"` on 2026-11-12); two planted
 *   tuning-test notes were indexed 2026-11-13
 *   (machinae-game/machinae-game-bitecs-query-registration-for-sim-
 *   tests.md, machinae-game/machinae-game-three-js-instanced-render-
 *   batching.md) and are labeled relevant below; the planted decoys
 *   (unity-dots-entity-query-chunk-iteration.md, react-three-fiber-
 *   gallery-viewer-memoization.md) are labeled forbidden. All four are
 *   ARCHIVED after the live tuning loop ends, which returns this set to
 *   its pre-plant ground truth.
 *
 * Label semantics (all three lists are disjoint intents, not a partition):
 * - relevant: expected-relevant sources; a hit counts toward precision
 *   AND toward recall-of-labeled.
 * - acceptable: topically defensible but not a designed answer; counted
 *   separately, never as a hit and never as noise.
 * - forbidden: known-noise sources observed polluting this query (mostly
 *   cross-project notes); any appearance counts against forbidden-rate.
 * - Anything unlisted is neutral: returned, printed, scored 0 in metrics.
 *
 * Matching: labels are vault-RELATIVE source_paths exactly as stored
 * (the collection keeps source_path vault-relative; the single production
 * vault is /home/derek/.dsh/obsidian-mem). A label ending in `*` is a
 * path prefix (e.g. "guestwise/*"). A label object {source_path,
 * section_header} additionally requires the returned chunk's
 * section_header to START WITH the given section prefix; most labels here
 * are file-level (section_header "") because most notes are one section.
 */

/** @typedef {{source_path: string, section_header?: string}} SectionLabel */
/** @typedef {string | SectionLabel} SourceLabel */

/**
 * @typedef {object} EvalQuery
 * @property {string} id stable slug, used in JSON artifacts
 * @property {string} origin provenance string (transcript slug/session or topic)
 * @property {string} query the text sent to embedder + BM25, verbatim
 * @property {SourceLabel[]} relevant expected-relevant sources
 * @property {SourceLabel[]} acceptable relevant-ish, never counted as hits or noise
 * @property {SourceLabel[]} forbidden known-noise sources for this query
 * @property {string} [note] labeling rationale
 */

/** @type {EvalQuery[]} */
export const EVAL_QUERIES = [
  {
    id: 'milvus-irrelevant-context',
    origin: 'transcript:--home-derek-src-dsh-plugin-obsidian-mem--/session-46361e57-aa6c-4397-95f7-e7efd5f150c8',
    query: 'The Milvus vector search is returning too much irrelevant context, clouding agent sessions.',
    relevant: [
      'milvus-lite-verified-bootstrap-command-and-stack-traps.md',
    ],
    acceptable: [
      'memory-hooks-name-the-activity.md',
      'obsidian-mem-subagent-zero-recall-is-budget-not-gating.md',
      'obsidian-mem-global-budget-number-is-injected-tokens-cumulative-not-note-size.md',
      'dsh-session-transcript-probe.md',
      'dsh-session-cwd-header-gate.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
      'archive/*',
      'npm-cli-lockout-devengines-onfail-download-ebaddevengines.md',
      'api-docs-html-to-markdown.md',
    ],
    note: 'The tuning-plan request itself; the milvus stack-traps note is the one real answer, other memory-system notes are adjacent.',
  },
  {
    id: 'dream-plan-runs-actually',
    origin: 'transcript:--home-derek-src-dsh-plugin-obsidian-mem--/session-a3bc8865-48b6-4cbf-b0df-d2e1a7e68331',
    query: 'The Dream tool in the client reports a successful generation of the dream PLAN, but it fails to run an actual dream.',
    relevant: [
      'obsidian-mem-dream-run-agentoptions-fix-launchroute-failed-turn-session-log-scan.md',
    ],
    acceptable: [
      'obsidian-mem-dream-plan-text-budget-lines-need-a-candidate.md',
      'dsh-session-cwd-header-gate.md',
      'obsidian-mem-global-budget-number-is-injected-tokens-cumulative-not-note-size.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
      'mise-shim-no-version.md',
      'dsh-local-infer-bundle-text-pins.md',
      'dsh-local-infer-profile-symlink.md',
    ],
  },
  {
    id: 'budget-reminder-end-of-turn',
    origin: 'transcript:--home-derek-src-dsh-plugin-obsidian-mem--/session-9287a0d5-24b5-4791-9158-317bd820cbaa',
    query: 'Update the global memory budget reminder to only run at the end of a turn alongside the memory_write reminder. It should only run on the root agent, not any subagents.',
    relevant: [
      'obsidian-mem-global-budget-number-is-injected-tokens-cumulative-not-note-size.md',
    ],
    acceptable: [
      'obsidian-mem-dream-plan-text-budget-lines-need-a-candidate.md',
      'obsidian-mem-subagent-zero-recall-is-budget-not-gating.md',
      'obsidian-mem-dream-run-agentoptions-fix-launchroute-failed-turn-session-log-scan.md',
    ],
    forbidden: [
      'drupal/drupal-update-hook-schema-8000-baseline.md',
      'guestwise/drupal-installs-uid-1-has-no-global-roles-group-locked-entities-403-for-it.md',
      'lywa/lywa-php-lint-tooling.md',
      'drupal/*',
      'guestwise/*',
      'lywa/*',
    ],
    note: 'BM25 crosses "global" (roles) and "update" (hooks) into Drupal notes; those two exact files were observed polluting.',
  },
  {
    id: 'milvus-goaway-keepalive',
    origin: 'in-domain:milvus-client-channel',
    query: 'milvus-lite keepalive GOAWAY excess pings channel UNAVAILABLE',
    relevant: [
      'milvus-lite-verified-bootstrap-command-and-stack-traps.md',
    ],
    acceptable: [
      'dsh-plugin-obsidian-mem-lib-is-tracked-post-clean-build-contract.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
    ],
  },
  {
    id: 'lib-tracked-build-contract',
    origin: 'in-domain:obsidian-mem-build-layout',
    query: 'packages/*/lib is committed so a git install ships the runtime entry points; pnpm build must leave the tree clean',
    relevant: [
      'dsh-plugin-obsidian-mem-lib-is-tracked-post-clean-build-contract.md',
    ],
    acceptable: [
      'dsh-local-infer-build-newline-churn.md',
      'pnpm12-allowbuilds.md',
    ],
    forbidden: [
      'guestwise/*',
      'archive/*',
    ],
    note: 'dsh-local-infer carries the same lib-tracked pattern, so its churn note is defensible, not a designed answer.',
  },
  {
    id: 'typecheck-test-trees',
    origin: 'in-domain:obsidian-mem-test-typechecking',
    query: 'type checking the vitest test trees with a throwaway tsconfig',
    relevant: [
      'dsh-plugin-obsidian-mem-type-checking-the-test-trees-with-a-throwaway-tsconfig.md',
    ],
    acceptable: [
      'vitest-lazy-cjs-require-carrier.md',
      'typescript-verify-before-done.md',
      'typescript-declarative-best-practices.md',
      'ts-installed-types-are-api-truth.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
    ],
  },
  {
    id: 'session-transcript-probe',
    origin: 'in-domain:session-transcripts',
    query: 'session transcript probe session.v4.jsonl.zstd first user message',
    relevant: [
      'dsh-session-transcript-probe.md',
    ],
    acceptable: [
      'dsh-session-cwd-header-gate.md',
      'obsidian-mem-subagent-zero-recall-is-budget-not-gating.md',
      'memory-hooks-name-the-activity.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
      'archive/*',
    ],
  },
  {
    id: 'subagent-zero-recall',
    origin: 'in-domain:recall-budget',
    query: 'subagent zero memory recall is the per-session budget not gating',
    relevant: [
      'obsidian-mem-subagent-zero-recall-is-budget-not-gating.md',
    ],
    acceptable: [
      'obsidian-mem-global-budget-number-is-injected-tokens-cumulative-not-note-size.md',
      'dsh-session-transcript-probe.md',
      'dsh-session-cwd-header-gate.md',
      'memory-hooks-name-the-activity.md',
    ],
    forbidden: [
      'guestwise/*',
      'lywa/*',
      'drupal/*',
    ],
  },
  {
    id: 'layout-sidecar-model-cache',
    origin: 'in-domain:vault-layout',
    query: 'where do the indexer sidecar files and the model cache live for a vault',
    relevant: [
      'vault-layout-r2-the-phase-2-seam-map-after-commit-b630628.md',
      'milvus-lite-verified-bootstrap-command-and-stack-traps.md',
    ],
    acceptable: [
      'hf-cli-no-cross-run-resume.md',
    ],
    forbidden: [
      'drupal-discovery-cache-clear.md',
      'drupal/*',
      'lywa/*',
      'guestwise/*',
      'samk3s-samdrive-mount-topology.md',
    ],
    note: 'The dense route pulled the Drupal "discovery cache" note onto a model-cache question at rank 1 in the labeling probe.',
  },
  {
    id: 'machinae-combat-systems',
    origin: 'transcript:--home-derek-src-machinae-game--/295b6f41-821c-4ffe-9356-72acdba1b9ad',
    query: 'In `/home/derek/src/machinae-game`, add Machine-versus-Machine combat to the simulation layer: a ground-mode Machine fires a laser with a reload cycle, a fighter-mode Machine fires from a finite missile supply, and target selection is a deterministic system that engages the nearest live enemy within range.',
    relevant: [
      'typescript-simulation-style.md',
      'machinae-game/machinae-game-bitecs-query-registration-for-sim-tests.md',
    ],
    acceptable: [
      'typescript-verify-before-done.md',
      'typescript-declarative-best-practices.md',
      'ts-installed-types-are-api-truth.md',
    ],
    forbidden: [
      'drupal/*',
      'guestwise/*',
      'lywa/*',
      'unity-dots-entity-query-chunk-iteration.md',
      'react-three-fiber-gallery-viewer-memoization.md',
      {
        source_path: 'data-model-leak-clean-seam.md',
      },
    ],
    note: 'Updated 2026-11-13: the planted machinae note on ECS query registration is relevant here; before that the TS style note was the only expected-relevant source. data-model-leak-clean-seam.md is Drupal service-split lore that the dense route serves onto ECS queries.',
  },
  {
    id: 'machinae-save-restore',
    origin: 'transcript:--home-derek-src-machinae-game--/8f8fa1e3-6674-4315-8359-1b7587105e53',
    query: 'In `/home/derek/src/machinae-game`, add save and restore for the simulation: serialize the live world into a plain JSON-safe snapshot and rebuild an equivalent world from one.',
    relevant: [
      'typescript-simulation-style.md',
    ],
    acceptable: [
      'typescript-verify-before-done.md',
      'typescript-declarative-best-practices.md',
      'ts-installed-types-are-api-truth.md',
    ],
    forbidden: [
      'drupal/*',
      'guestwise/*',
      'lywa/*',
      'archive/*',
      'npm-publish-404-not-maintainer.md',
    ],
  },
  {
    id: 'machinae-threejs-renderer',
    origin: 'transcript:--home-derek-src-machinae-game--/ec373666-a187-4f42-8cda-627d222aa746',
    query: 'In `/home/derek/src/machinae-game`, replace the renderer stub with a real three.js-backed renderer that draws each Machine (ground and air forms must be visually distinguishable), each Deposit, and each Building from component state. The renderer must be strictly read-only with respect to simulation state.',
    relevant: [
      'typescript-simulation-style.md',
      'machinae-game/machinae-game-three-js-instanced-render-batching.md',
    ],
    acceptable: [
      'vitest-lazy-cjs-require-carrier.md',
      'typescript-verify-before-done.md',
      'typescript-declarative-best-practices.md',
      'ts-installed-types-are-api-truth.md',
    ],
    forbidden: [
      'drupal/*',
      'guestwise/*',
      'lywa/*',
      'unity-dots-entity-query-chunk-iteration.md',
      'react-three-fiber-gallery-viewer-memoization.md',
    ],
    note: 'Updated 2026-11-13 with the planted three.js render-batching note (relevant) and planted decoys (forbidden). The labeling probe surfaced drupal/bigpipe (a browser-JS note) three times on this query; drupal/* is forbidden as a family.',
  },
  {
    id: 'lywa-synonym-service-di',
    origin: 'transcript:--home-derek-src-lywa--/session-d74fa7bc-c43c-4193-9606-9c2c11b4539e',
    query: 'Update public_html/modules/custom/lywa_solr/src/Synonym/SynonymSchemaInstaller.php to use dependency injection for the `entityTypeManager`. Ensure that it takes the service in the constructor and saves it as a protected variable.',
    relevant: [
      'lywa/procedural-hook-service-statics.md',
      'drupal/drupal11-entity-form-di.md',
      'drupal/drupal11-hook-class-di.md',
    ],
    acceptable: [
      'lywa/lywa-index.md',
      'drupal/drupal11-plugin-discovery.md',
    ],
    forbidden: [
      'guestwise/*',
    ],
    note: 'drupal/ is the cross-repo Drupal-platform family; DI-knowledge notes there are deliberate relevant labels, the rest of drupal/* stays neutral.',
  },
  {
    id: 'lywa-glossary-synonyms',
    origin: 'transcript:--home-derek-src-lywa--/session-1045efc1-267b-42dc-a83b-31d3c8e69985',
    query: 'The `glossary_term` content type has a field `field_term_translation` that includes additional synonyms for the `title` field.',
    relevant: [],
    acceptable: [
      'lywa/lywa-solr-pywsd-runner.md',
      'lywa/lywa-index.md',
    ],
    forbidden: [
      'guestwise/*',
    ],
    note: 'No glossary/solr-synonym note exists in the collection (verified read-only), so recall-of-labeled is not defined for this query; it exists to measure forbidden cross-project pollution (guestwise/event-entity-label-field-name.md was observed at rank 1).',
  },
  {
    id: 'lywa-lightbox-pause',
    origin: 'transcript:--home-derek-src-lywa--/session-89f9f84b-c1f0-4790-a28f-1459c31d518c',
    query: 'Update public_html/themes/barrio_lywa/js/node.gallery.full.js to add a pause button to the lightbox3 image caption box.',
    relevant: [
      'lywa/lightbox3-gallery-integration-facts.md',
    ],
    acceptable: [
      'lywa/lywa-frontend-test-and-lint-invocation.md',
      'lywa/lywa-index.md',
      'drupal/svg-overlay-swallowed-clicks.md',
    ],
    forbidden: [
      'guestwise/*',
      'api-docs-html-to-markdown.md',
    ],
  },
  {
    id: 'guestwise-ci-playwright',
    origin: 'transcript:--home-derek-src-guestwi.se--/session-2d511499-813e-4770-a611-9c99054e6a35',
    query: 'The CI / CD process failed on the "Run the Playwright tests" step in .github/workflows/ci-cd.yml with error "The ticket type edit form should be reachable for the site admin" Expected: 200 Received: 403.',
    relevant: [
      'guestwise/theme-playwright-harness.md',
      'guestwise/ci-css-aggregation-404.md',
      'guestwise/ddev-playwright-pnpm.md',
    ],
    acceptable: [
      'guestwise/guestwise-plan-tasks.md',
      'guestwise/drupal-installs-uid-1-has-no-global-roles-group-locked-entities-403-for-it.md',
    ],
    forbidden: [
      'lywa/*',
      'npm-publish-404-not-maintainer.md',
      'npm-cli-lockout-devengines-onfail-download-ebaddevengines.md',
      'obsidian-mem-dream-run-agentoptions-fix-launchroute-failed-turn-session-log-scan.md',
    ],
  },
  {
    id: 'guestwise-ticket-type-form',
    origin: 'transcript:--home-derek-src-guestwi.se--/session-99d3cc37-502c-4a70-9894-469332287b98',
    query: 'Update the Price and You Receive ticket type form fields in web/modules/custom/guestwise_orgs/src/Form/TicketTypeForm.php.',
    relevant: [
      'guestwise/group-relationship-query-limitation.md',
      'guestwise/group-config-entity-access-install.md',
    ],
    acceptable: [
      'guestwise/guestwise-demo-feature-gaps.md',
      'guestwise/ticket-cart-availability-kernel-trap.md',
      'guestwise/order-item-type-purchasable-target.md',
      'guestwise/logged-in-ticket-view-403.md',
      'guestwise/commerce-cart-db-probe-traps.md',
      'guestwise/php-round-ceiling-absent.md',
      'drupal/drupal11-media-library-widget-uncached-form.md',
      'drupal/drupal-number-element-step-default.md',
    ],
    forbidden: [
      'lywa/*',
    ],
    note: 'No note documents TicketTypeForm itself; the ticket-type/config-entity knowledge lives in the two relevant labels.',
  },
]

/**
 * MatchesLabel reports whether one returned row satisfies a source label.
 * Strings are vault-relative paths, or path prefixes when ending in `*`;
 * objects pin a section_header prefix on top of the path rule.
 */
export function matchesLabel(label, row) {
  const path = typeof label === 'string' ? label : label.source_path
  const pathMatch = path.endsWith('*')
    ? row.source_path.startsWith(path.slice(0, -1))
    : row.source_path === path
  if (!pathMatch) {
    return false
  }
  if (typeof label === 'string' || label.section_header === undefined) {
    return true
  }
  return String(row.section_header ?? '').startsWith(label.section_header)
}
