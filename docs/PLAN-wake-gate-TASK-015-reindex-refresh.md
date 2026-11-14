# TASK-015: reindex-refresh + re-audit (live wake arrays)

Phase A2 close-out. Stored `wake_keywords` are computed at index time,
so TASK-014's fix only helps rows the indexer rewrites. This task makes
the LIVE collection reflect the fix, then re-runs the Step 1.1 gate.

1. Investigate the safe reindex seam, in this order:
   a. Drive `IndexerManager.reindexAll()` (packages/service/lib, the
      same code the settings card calls) from a one-off script, built
      the way `scripts/eval/recall-eval.mjs` builds its standalone
      stack: live {port,pid} from `.memlite.json`, real embedder, real
      vault registry config. Writes happen ONLY through the indexer's
      own code path (per-file chunk delete + re-upsert), never a raw
      collection mutation, and NEVER drop/rebuild the collection (dim
      unchanged). Run once against every registered vault.
   b. If (a) cannot be assembled safely without a running Cordis host,
       STOP and report to the parent agent; do not improvise raw
       upserts or delete state files under the live watcher.
2. Watcher note: the running host also has watchers; a concurrent extra
   index run is acceptable waste, not corruption. Do not restart or
   kill the host.
3. Re-run `node docs/research/probes/wake-audit-probe.mjs` (read-only,
   range-split windows). Record the new FINAL (rows, empty rows, rate)
   and new TERMS top-20 in the spec doc §Pre-flight measurements.
   Reconciliation from TASK-014: the vault replay counted 211 chunks vs
   the collection's 210 rows (and TERMS `how` 91 vs 92); the fresh
   post-reindex count is the truth, note the reconciled numbers.
4. GATE: empty rate <= 5% AND markers no longer dominate TERMS. Not met
   -> report the residual distribution (which vaults/notes still empty)
   for a follow-on fix task; do NOT proceed to TASK-002 on a failing
   gate.
5. Commit: the one-off script ONLY if it is durable enough to keep
   (prefer keeping it: `scripts/eval/` is eval-only; a maintenance
   script belongs where you can justify it, e.g. `scripts/`), plus the
   spec doc update. Git hygiene as usual (porcelain check before
   commit, prek, no attribution).

Definition of Done: live collection reindexed through the indexer code
path; re-audit recorded with rate <= 5%; decision "Phase B unblocked"
written into the spec doc.
