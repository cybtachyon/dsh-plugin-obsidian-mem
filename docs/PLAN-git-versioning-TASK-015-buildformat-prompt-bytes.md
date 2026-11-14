# TASK-015-buildformat-prompt-bytes

Follow-up to TASK-007, execute before TASK-008. Keep the prepared prompt
constants byte-identical between src and the tracked lib emit.

Problem (TASK-007 finding): `scripts/build-format.mjs` strips per-line
trailing whitespace from every lib artifact. The tracked lib `.js` copies
of the prepared prompt constants have already lost load-bearing bytes vs
src: `service/lib/dream.js` DEFAULT_DREAM_PROMPT 5019 vs src 5021;
`tools/lib/audit.js` AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT 2284 vs 2285.
Runtime `loadPrompt()` seeds `<dbDir>/dream-prompt.md` from the lib
constant, so the shipped seeded prompt silently differs from the user's
prepared source-of-truth bytes.

Fix:
- Teach `scripts/build-format.mjs` to skip the six prepared-prompt
  carriers (the same set prek.toml's trailing-whitespace exclude names:
  `packages/service/{src,lib}/dream.{ts,js}` and
  `packages/tools/{src,lib}/{prompt,audit}.{ts,js}`) from its newline
  normalization/strip pass, keyed by a named constant list that cites
  prek.toml (single home for the six-path set lives in
  scripts/build-format.mjs; add a comment cross-referencing the prek
  regex).
- Rebuild so the lib `.js` re-emits carry the exact src bytes, and commit
  src script + the refreshed lib emit together.
- Pin: extend `scripts/verify-emit.mjs` (or a tiny node test if the
  scripts are untested) with a byte-equality check that, for the six
  carrier constants, the lib `.js` file contains the src constant's
  exact UTF-8 bytes (extract by name markers, compare `Buffer.compare`).
  Failing the build on drift is the goal.
- Verify: `node scripts/build-format.mjs` then `git diff` shows the two
  lib files gained the lost trailing bytes and nothing else moved;
  `pnpm build` twice leaves the tree clean; the constants still match
  a113305's src ranges byte-for-byte.

Definition of Done: script skip + byte-pin committed; lib == src bytes
for all six carriers; build/test gates green as in TASK-014 fashion for
the touched surface.
