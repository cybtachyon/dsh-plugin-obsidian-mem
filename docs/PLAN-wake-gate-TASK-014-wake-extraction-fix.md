# TASK-014: wake-extraction-fix (core triggers.ts)

Phase A2 (spec Step 1.1 STOP consequence; same upstream bug the PARTIAL
rule names). Root evidence: TASK-001 audit
(`docs/research/probes/wake-audit-probe.mjs` FINAL/TERMS lines, recorded
in the spec doc §Pre-flight measurements): 18.57% of 210 rows have EMPTY
`wake_keywords`, and the 179 distinct terms are dominated by generic
intent markers (when 95, how 91, why 82, "how to apply" 31, where 23,
what 20) plus extraction fragments (`+ field.field`, `0 of 54`,
`2/(k+1`, a 54-char sentence fragment).

1. Read `packages/core/src/triggers.ts` end to end and identify exactly
   which extraction paths feed these shapes into `wake_keywords`
   (section-header phrases like "Why:" / "How to apply:", line-fragment
   harvest, whatever admits `0 of 54`). Note the memory-note house format
   LITERALLY mandates "Why:"/"How to apply:" lines, so every note seeds
   those markers; that is the pollution mechanism.
2. Design the minimal fix (TDD in the core triggers spec; look up the
   existing spec file first):
   - drop generic intent markers: single-word interrogatives/generic
     terms (when, where, why, what, how, and the marker phrases they
     arrive as, e.g. "how to apply", "why") from wake output;
   - bound wake-key SHAPE so fragments cannot pass (digit-led or
     symbol-led keys, unbalanced-token strings, sentence fragments);
     `isUsableKeyword`'s 2..64 length + word-count rules already exist
     and must keep one home;
   - CRITICAL constraint: the fix must not deepen the EMPTY-wake
     problem. Where a marker key is dropped, prefer that the existing
     content-word paths (identifiers, file/heading content words,
     whatever the extractor already computes) stand; do not invent a
     new vocabulary source. If, after honest extraction, a chunk has
     nothing left, leave it empty and report how many rows that would
     affect (measure against the vault, report the count in the commit
     message; TASK-015's re-audit is the verdict).
   - No LLM-refiner changes; if the live pollution partly comes from
     the optional LLM pass (`service` llmRefiner), record that as a
     follow-up note instead of expanding scope.
3. `pnpm build && pnpm test && pnpm lint` green; commit
   `packages/core/src`, rebuilt `packages/core/lib` (any downstream lib
   the build touches), and the core spec. `git status --porcelain`
   immediately before `git commit` (concurrent sibling sessions share
   this git index); `prek run --files` first; no assistant attribution
   in the message.

Definition of Done: unit tests pin marker-drop + shape bounds; gates
green; one commit; the spec doc §Pre-flight gains a short "Fix applied"
note with the commit hash. Re-audit + reindex is TASK-015 (this task
does NOT touch the live collection).
