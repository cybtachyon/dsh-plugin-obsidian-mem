# TASK-018 han-run-unstripped-fix

Fix the CJK shape of `sparseQueryText` per the ADOPTED fallback decided by
the TASK-005 zh probe (docs/research/stopword-strip-findings.md, follow-up
#1): the default Milvus analyzer stores MAXIMAL HAN RUNS on both index and
query sides, so per-codepoint re-joined tokens provably never match Han
words, and the current strip actively destroys the matching shape
(raw `记忆` hits; `记 忆` returns 0).

Implementation in packages/service/src/search.ts:
- Tokenize Han as MAXIMAL RUNS (regex change: `[\p{Script=Han}]+` capture,
  mirroring the analyzer), not per codepoint.
- A run is removed only when the WHOLE run is a stop word entry, so
  standalone single-character function-word runs (的, 和, 时 ...) still
  drop in mixed-language text while real words (智能体, 记忆) pass through.
- Latin/digit tokenization and the empty-result fail-open are unchanged.
- Kana/Hangul stay word characters as today; record in the docblock that
  Japanese run-shape under the default analyzer is unproven, same caveat
  class as the settled Han finding.
- Update the `sparseQueryText` docblock: state the empirical finding with
  the 2026-11-13 probe reference and point to the findings doc; this is
  the single home for the rule.

Tests in packages/service/tests/search.spec.ts (TASK-003 goldens pin the
OLD per-codepoint behavior; update them to the shipped shape):
- Han runs whole: '智能体的共享记忆' -> '智能体 共享记忆' (的 run removed,
  word runs kept), '我喜欢混合检索' unchanged (no single-char runs).
- Mixed: keep a kana-adjacent run golden ('テストの時間' behavior recorded
  explicitly; document whatever the shipped regex produces).
- Route-level goldens that used CJK: re-pin from the shipped lib.

Definition of Done:
- `pnpm build`, `pnpm test` (all suites), `pnpm lint` green; coverage
  thresholds clear.
- Findings doc's follow-up #1 annotated as shipped (edit the doc line in
  the same commit).

Depends on: TASK-005 (verdict). Feeds: TASK-006 (final code before the
sweep), TASK-008 (refactor review).
