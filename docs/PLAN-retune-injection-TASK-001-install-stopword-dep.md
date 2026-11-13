# TASK-001 install-stopword-dep

Add the `stopword` npm package (latest 3.x, currently 3.1.5) as a runtime
dependency. Per AGENTS.md "Runtime deps are declared at BOTH the root and
their owning package": add an identical semver row (`"^3.1.5"`) to the root
`package.json` `dependencies` AND `packages/service/package.json`
`dependencies`, then `pnpm install`. The root copy is what the installed
plugin materializes into `~/.dsh/profiles/<profile>/node_modules`; deleting
either half breaks one surface. Do not run dedupe tooling that prunes the
root copy.

Definition of Done:
- Both package.json files carry `stopword` with the same range.
- `pnpm install` succeeds; `pnpm-lock.yaml` updated and staged.
- `node -e "console.log(require.resolve('stopword'))"` resolves from the
  repo; inspect its shipped `.d.ts` and record the import shape
  (`removeStopwords(words, [en])` and the `en` list export) in this file.

Depends on: none.

## Shipped import shape (verified 2026-11-13 against stopword@3.1.5)

Installed resolution: `node -e "console.log(require.resolve('stopword'))"` →
`node_modules/.pnpm/stopword@3.1.5/node_modules/stopword/dist/stopword.cjs.js`
(the `main` CJS build). Both package.json files carry `"stopword": "^3.1.5"`
and `pnpm-lock.yaml` records 3.1.5 for the root and service importers.

Artifact layout: the shipped tarball ships NO `.d.ts` files and has no
`exports` map. `main` = `dist/stopword.cjs.js` (CJS), `module` =
`src/stopword.js` (ESM, bundler-only field; Node ignores it). Under this
repo's `moduleResolution: nodenext`, both `require('stopword')` and
`import { removeStopwords, eng, zho } from 'stopword'` resolve to the CJS
build through Node interop. Both forms verified working at runtime.

API (v3 signature, corrected from the v2-style sketch in the DoD above):

- `removeStopwords(tokens: string[], stopwords: string[] = eng): string[]`.
  The second parameter is ONE FLAT stopword array, not an array of language
  arrays. Combining lists is `removeStopwords(words, [...eng, ...zho])`.
  Matching is `stopwords.includes(token.toLowerCase())`, so English is
  case-insensitive and returned tokens keep their original casing. Throws on
  non-string entries and on a non-array second argument.
- Language lists are exported under ISO 639-3 codes, NOT v2 short codes:
  English is `eng` (108 entries), Chinese is `zho` (78 entries). There is
  no `en` or `zh` export in 3.1.5. Full export set: `removeStopwords` plus
  62 language-code arrays (`afr`…`zul`, also `_123`, `lggNd`, `porBr`).

CJK/zh notes for TASK-002:

- The `zho` list is 78 single-character function words only (`的 地 得 和 跟
  与 及 向 并 等` …). It contains zero multi-character entries, so a
  multi-character Chinese word never matches, and a character like `我` that
  is absent from the list survives removal.
- A `zho` removal only fires when the input token is exactly one of those
  characters. The README ("Languages with no space between words") states
  zho/jpn/tha require an external tokenizer (jieba, chinese-tokenizer, …)
  because stopword does not segment unspaced text. A whitespace-split zh
  query segment matches nothing; TASK-002 must decide the zh token-splitting
  itself (the BM25 route already receives pre-split or raw query text, so
  single-character splitting is the cheap option).

TypeScript: because no `.d.ts` ships, a strict nodenext import needs the
DefinitelyTyped package `@types/stopword` (npm latest 2.0.3). Its
declarations match the v3 flat-array signature (`removeStopwords: (text:
string[], stopwords?: string[]) => string[]` plus a `[LanguageCode]:
string[]` map, `export =`). TASK-002 must add
`@types/stopword@^2.0.3` as a devDependency at root AND
`packages/service` (same lockstep rule as the runtime row) or the first
import fails `pnpm build` with TS7016.
