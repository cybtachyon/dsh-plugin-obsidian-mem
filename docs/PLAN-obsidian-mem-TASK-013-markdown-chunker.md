# TASK-013 Markdown header-aware chunker + noise stripping

Depends: TASK-010. `packages/core/src/chunk.ts`.

## Scope

- Port of langchain `MarkdownHeaderTextSplitter`
  (https://github.com/langchain-ai/langchain/blob/e2db474707c90248f74b1398ea6f13883605f7e7/libs/text-splitters/langchain_text_splitters/markdown.py;
  fetch it during implementation) to TypeScript: headers_to_split_on `#..######`, header
  stack, emit chunks at each header boundary, header path joined as
  `section_header` ("A > B > C"), and each chunk's text begins with the header line(s) so
  context survives embedding.
- Respect fenced code blocks: `#` inside fences is never a header.
- Noise stripping BEFORE embedding: YAML frontmatter, HTML comments `<!-- -->`, raw image
  base64/data URIs, autolink junk; repeated blank-line collapse. Stripping is applied to a
  copy; the stored `chunk_text` keeps markdown headers and code fences.
- `splitLongChunk(chunk, maxTokens)` secondary pass (paragraph → sentence boundaries) when
  a section exceeds chunk maxTokens (from constants); chunks numbered so chunk ids are
  unique per (source_path, header_hash, part).
- Output `Chunk = { source_path, section_header, header_hash, part, chunk_text,
  approxTokens }`.

## DoD

Tests over fixtures: nested headers, code fence with `#`, frontmatter stripped, oversized
section split, stable header_hash; commit.
