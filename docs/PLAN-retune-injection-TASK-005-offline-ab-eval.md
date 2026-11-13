# TASK-005 offline-ab-eval

Run the labeled 17-query set against the LIVE collection (read-only
discipline per scripts/eval/README.md) at production knobs
(dense radius 0.78, range 1.0, ef 64, sparse floor 2.5, k 60, topK 6,
oversample 2):
1. Baseline: `--mode split-rrf --keep-stopwords --label strip-off-d078-s25-k60`.
2. Treatment: `--mode split-rrf --label strip-on-d078-s25-k60`.

Commit both artifacts deliberately:
`--out docs/research/eval-split-strip-off-d078-s25-k60.json` and
`--out docs/research/eval-split-strip-on-d078-s25-k60.json`. Write a new
findings doc `docs/research/stopword-strip-findings.md`: aggregate P@k,
forbidden-rate, recall, per-query deltas, and the sparse-route score
distribution shift (how much BM25 mass disappeared). Verdict framing:
strip is DECIDED work, so the doc decides knob follow-ups (TASK-006), not
whether the feature ships; record any query that regressed and why.

Definition of Done:
- Two committed artifacts + findings doc with the comparison table.
- Note the label-honesty caveat if the live vault drifted since
  `queries-labels.mjs` was cut (README "Collections drift").

Interpretation notes carried from TASK-002/003 (read before writing the
findings doc):
- `zho` list membership VERIFIED against the installed list: contains
  日/月/年/时/分/秒/一/等 but NOT traditional 時, nor 二, nor 间/間.
  Traditional-Chinese queries strip far less than simplified. Japanese-
  adjacent Han text loses only the shared simplified shapes (日本語 loses
  日). `eng` is a minimal 108-entry list (`do` yes, `does` no), so English
  strip rates are lower than a naive reading suggests. Attribute any
  query-level CJK regression here, not to the general strip.
- Han query text is re-joined per codepoint; whether those tokens match
  the default analyzer's index-time output is THIS task's empirical check.
  If a CJK probe query provably cannot match, adopt the documented
  fallback (CJK left UNSTRIPPED) and record it.
- Comparability (TASK-004 finding): the committed pre-strip baselines
  (docs/research/eval-split-d078-s25-k60*.json) carry RAW sparse queries;
  compare THIS task's strip-off vs strip-on pair, not the older committed
  baselines. Legacy-hybrid artifacts post-TASK-004 also have stripped
  route-membership probes; do not mix eras in one table.
- Label re-verification FIRST (README "Collections drift"): the vault is
  live, so dump a fresh `chunk_id >= 0` read-only projection and re-check
  the relevant/forbidden labels still exist before trusting deltas;
  record any re-label in the findings doc.
- Early smoke signal (no production knobs, NOT a verdict): strip P@k
  0.196 vs keep 0.216 at equal recall 15/24. If the with-knobs A/B
  confirms a precision regression, the A2 domain-list follow-up and the
  TASK-006 floor re-sweep are the remedy path; the strip itself is
  decided work.

Depends on: TASK-004.
