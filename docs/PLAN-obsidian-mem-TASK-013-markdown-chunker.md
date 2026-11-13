# TASK-013 Markdown header-aware chunker + noise stripping

Status: done

Depends: TASK-010. `packages/core/src/chunk.ts`.

## Scope

- Port of langchain `MarkdownHeaderTextSplitter` to TypeScript using the load-bearing
  port spec in docs/research/milvus-transformers-findings.md §7 (authoritative; source
  https://github.com/langchain-ai/langchain/blob/e2db474707c90248f74b1398ea6f13883605f7e7/libs/text-splitters/langchain_text_splitters/markdown.py
  ): headers sorted by token length DESC; fence tracking BEFORE header matching with the
  `count("```")===1` rule; metadata snapshot taken BEFORE a header mutates the stack
  (content before a header flushes with PRE-header metadata); header-stack pop on
  `level >=` with key deletion from initial_metadata; blank line flushes the entry;
  aggregation joins same-metadata runs with `"  \n"` (hard break; blank lines are lost);
  `#Header` (no space) is content; front matter is NOT special — strip YAML before
  calling. Header path joined as `section_header` ("A > B > C") and PREPENDED to stored
  chunk text so embedding retains context.
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
