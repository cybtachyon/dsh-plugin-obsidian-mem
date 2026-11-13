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
