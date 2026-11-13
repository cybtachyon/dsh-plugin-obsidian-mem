# TASK-012 (metrics-gated): bge-reranker-base cross-encoder

Investigation task for a post-fusion semantic reranker. Run only per the
A4 scope answer, and only if radius/fusion tuning alone still admits
semantically-off-topic rows that survive all floors.

Scope:
1. Model: https://huggingface.co/Xenova/bge-reranker-base via
   @huggingface/transformers (already a runtime dep). Check the model
   loads under the existing transformers.js version (transformers.js
   cross-encoder support: `pipeline('text-classification', ...)` style
   usage for Xenova rerankers; verify current API from the installed
   package, not memory).
2. Prototype in the harness first: score fused top-2N with the
   cross-encoder (query, chunk_text) pairs, apply a calibrated cutoff on
   the softmax probability or raw logit (user's suggested example: score
   > 0.35) and re-rank. Calibrate the cutoff on the labeled set: pick the
   threshold maximizing noise-removal at zero relevant-source loss.
3. Cost check: CPU latency per query (model size, cache dir under the
   plugin model cache `<dbDir>/models/`) fits the turn-start budget
   (turnStart recall runs fire-and-forget but the host process is the
   user's machine).
4. Only after a metrics win: production integration behind the existing
   embedder/model-cache patterns, new dependency rows kept in lockstep per
   AGENTS.md, feature-flagged in config, live-tested after restart.

Definition of Done: latency + precision table in the plan file;
adopted/rejected verdict; if adopted, full gates + live test; the
calibrated cutoff constant documented where users tune it.

## CLOSED: REJECTED for production (2026-11-13, adopted by nobody)

Prototype + full sweep live in scripts/eval/cross-encoder-rerank.mjs
and docs/research/cross-encoder-findings.md (commit 41dacb0).
Verdict per the A4 gate ("substantial positive impact"): reject.
The zero-labeled-relevant-loss optimum is sigmoid p >= 0.0028
(forbRate 0.206 -> 0.133, 6 of 13 forbidden rows survive); killing
them needs p >= 0.07 at recall 0.636 -> 0.409. The re-sort is a no-op
(best-relevant index 1.286 before and after). Cost paid on every
recall in every channel: ~0.5 s CPU/query warm + 283 MB model cache.
And a cutoff past 0.003 would kill the exact live-loop planted-POS
pattern (typescript-simulation-style.md scores p 0.0029 on its
machinae query: a zero-shot multilingual reranker rates a
design-relevance note near zero). Reopen conditions: a fine-tuned
reranker, or the residual forbidden class surviving the TASK-015
query-hygiene fix. Integration trap noted for any future attempt:
transformers.js 4.3.2 softmaxes single-logit models to a constant 1.0;
production code must sigmoid the raw logit itself.
