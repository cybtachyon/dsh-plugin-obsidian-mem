/**
 * Deterministic trigger extraction: the wake_keywords,
 * trigger_extensions, and trigger_frameworks every indexed chunk carries.
 * Heuristics only, exactly the Q3 decision ("heuristics always + optional
 * LLM upgrade"); the LLM pass lives in the service indexer and merges
 * onto these results.
 *
 * Pure text analysis over one chunk plus its note frontmatter and the
 * workspace-manifest vocabulary: no fs, no env, no @deepseek-ai imports.
 * Lists are deduplicated, lowercased, and capped to the collection's
 * MILVUS_ARRAY_CAPACITIES / MILVUS_ARRAY_ELEMENT_MAX_LENGTHS so a
 * returned row can never overflow the Array<VarChar> columns. Field names
 * mirror the Milvus columns, as in chunk.ts.
 * @module dsh-plugin-obsidian-mem/core/triggers
 */
import { INTENT_MARKERS, MILVUS_ARRAY_CAPACITIES, MILVUS_ARRAY_ELEMENT_MAX_LENGTHS, } from './constants.js';
// Fenced-block language token to the file extension it signals. A
// deliberate allowlist: unknown fence languages (mermaid, text, console
// transcripts, plain) carry no file-type signal and are dropped rather
// than turned into a fabricated ".mermaid" trigger.
const FENCE_LANGUAGE_EXTENSIONS = {
    'javascript': '.js',
    'js': '.js',
    'mjs': '.mjs',
    'cjs': '.cjs',
    'jsx': '.jsx',
    'typescript': '.ts',
    'ts': '.ts',
    'mts': '.mts',
    'cts': '.cts',
    'tsx': '.tsx',
    'python': '.py',
    'py': '.py',
    'python3': '.py',
    'ruby': '.rb',
    'rb': '.rb',
    'go': '.go',
    'golang': '.go',
    'rust': '.rs',
    'rs': '.rs',
    'java': '.java',
    'kotlin': '.kt',
    'kt': '.kt',
    'scala': '.scala',
    'swift': '.swift',
    'php': '.php',
    'csharp': '.cs',
    'cs': '.cs',
    'c#': '.cs',
    'cpp': '.cpp',
    'c++': '.cpp',
    'c': '.c',
    'h': '.h',
    'bash': '.sh',
    'sh': '.sh',
    'shell': '.sh',
    'zsh': '.sh',
    'powershell': '.ps1',
    'ps1': '.ps1',
    'bat': '.bat',
    'batch': '.bat',
    'sql': '.sql',
    'html': '.html',
    'css': '.css',
    'scss': '.scss',
    'less': '.less',
    'yaml': '.yaml',
    'yml': '.yaml',
    'json': '.json',
    'jsonc': '.json',
    'toml': '.toml',
    'xml': '.xml',
    'ini': '.ini',
    'conf': '.conf',
    'dockerfile': '.dockerfile',
    'docker': '.dockerfile',
    'makefile': '.mk',
    'make': '.mk',
    'cmake': '.cmake',
    'lua': '.lua',
    'r': '.r',
    'perl': '.pl',
    'pl': '.pl',
    'elixir': '.ex',
    'ex': '.ex',
    'exs': '.exs',
    'erlang': '.erl',
    'dart': '.dart',
    'zig': '.zig',
    'haskell': '.hs',
    'julia': '.jl',
    'vue': '.vue',
    'svelte': '.svelte',
    'graphql': '.graphql',
    'proto': '.proto',
    'protobuf': '.proto',
    'terraform': '.tf',
    'tf': '.tf',
    'hcl': '.tf',
    'gradle': '.gradle',
    'groovy': '.groovy',
    'tex': '.tex',
    'latex': '.tex',
};
// Extensions accepted from inline file-path mentions. Broader than the
// fence map (a note can name a file the fence map has no language for)
// and a hard allowlist: "example.com" and "1.2.3" must not become
// triggers, so only known file-type suffixes qualify.
const KNOWN_INLINE_EXTENSIONS = new Set([
    ...Object.values(FENCE_LANGUAGE_EXTENSIONS),
    '.md',
    '.txt',
    '.log',
    '.csv',
    '.lock',
    '.env',
    '.ipynb',
    '.htm',
]);
// Framework aliases mapped to their canonical lowercase label. Mirrors
// the manifest.ts framework set and adds the data/infra names memory
// notes most often carry. Presence-gated (see collectFrameworks), so a
// common word like "spring" only fires when it actually appears.
const FRAMEWORK_ALIASES = {
    'react': 'react',
    'vue': 'vue',
    'angular': 'angular',
    'svelte': 'svelte',
    'solidjs': 'solidjs',
    'next': 'next',
    'nextjs': 'next',
    'nuxt': 'nuxt',
    'express': 'express',
    'nest': 'nest',
    'nestjs': 'nest',
    'vite': 'vite',
    'webpack': 'webpack',
    'vitest': 'vitest',
    'jest': 'jest',
    'django': 'django',
    'flask': 'flask',
    'fastapi': 'fastapi',
    'rails': 'rails',
    'laravel': 'laravel',
    'symfony': 'symfony',
    'doctrine': 'doctrine',
    'spring': 'spring',
    'springboot': 'spring',
    'gin': 'gin',
    'actix': 'actix',
    'tokio': 'tokio',
    'axum': 'axum',
    'milvus': 'milvus',
    'postgres': 'postgres',
    'postgresql': 'postgres',
    'mysql': 'mysql',
    'sqlite': 'sqlite',
    'redis': 'redis',
    'mongodb': 'mongodb',
    'mongo': 'mongodb',
    'kafka': 'kafka',
    'elasticsearch': 'elasticsearch',
    'docker': 'docker',
    'kubernetes': 'kubernetes',
    'k8s': 'kubernetes',
    'terraform': 'terraform',
    'ansible': 'ansible',
    'grpc': 'grpc',
    'graphql': 'graphql',
    'protobuf': 'protobuf',
};
// ``` / ~~~ fence opening with its language token.
const FENCE_OPEN = /(?:^|\n)[ \t]*(?:```|~~~)[ \t]*([A-Za-z][A-Za-z0-9+#.+-]{0,15})[ \t]*$/gm;
// `foo.ts`, `notes/server.py`, `vite.config.mts`: a path-ish token ending
// in .<letters+digits>. The trailing lookahead keeps version fragments
// out; the KNOWN_INLINE_EXTENSIONS set does the rest.
const INLINE_PATH = /[\p{L}\p{N}][\p{L}\p{N}_./+-]*\.([A-Za-z][A-Za-z0-9]{0,7})(?![\p{L}\p{N}])/gu;
// ATX header lines inside chunk text (fence interiors included; a `#`
// comment inside a fence is a small over-capture the heuristics accept).
const ATX_HEADER = /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+([^\n]+)/g;
// Emphasis spans: bold first (** / __), then single * and _ with
// identifier guards so snake_case names and stray stars are not split.
const BOLD_SPAN = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g;
const EMPHASIS_SPAN = /(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])/gu;
// Punctuation a header or **span** clings to but that carries no
// retrieval meaning; trimmed from both ends of a wake keyword.
const KEYWORD_EDGES = /^[\s"'`([{:;,.!?—-]+|[\s"'`)\]}:;,.!?—-]+$/g;
// One maximal Han run of the chunk text, each a wake-key candidate
// (TASK-017). The default Milvus analyzer stores and queries Han as
// maximal runs (the sparseQueryText docblock in
// packages/service/src/search.ts owns that rule), so a gated zh query
// token can only match a chunk that stores the run itself.
const HAN_RUN = /[\p{Script=Han}]+/gu;
// Wake-keyword shape bounds: 8 words caps runaway sentences, and 64 chars
// is the schema element cap (MILVUS_ARRAY_ELEMENT_MAX_LENGTHS repeats it).
const MAX_WAKE_KEYWORD_WORDS = 8;
// Generic section labels the note house format sprinkles everywhere. The
// format mandates a "Why:" and a "How to apply:" line, and headers arrive
// as "Why:", "How:", "Where:", so these interrogative labels land in the
// wake list from headers, emphasis, and the intent-marker scan alike. The
// TASK-001 audit (spec §Pre-flight) measured them topping the whole
// corpus wake vocabulary (when 95, how 91, why 82, how to apply 31, where
// 23, what 20 rows of 210); they carry no retrieval signal and gate
// nothing, so they drop from wake output wherever found. The intent-marker
// list keeps the concrete markers (investigate, debug, troubleshoot).
const GENERIC_WAKE_TERMS = new Set([
    'who',
    'what',
    'when',
    'where',
    'why',
    'how',
    'how to apply',
]);
// Standalone Han function-word characters (TASK-017). A wake candidate
// made entirely of these is noise, mirroring the analyzer-strip rule
// that a Han run is removed only when the whole run is a function word
// (the sparseQueryText docblock in packages/service/src/search.ts).
// This is the frequent subset of the service's stopword `zho` list;
// core keeps its own copy because the domain model imports no packages.
// Content runs keep their content characters and survive (记忆,
// 智能体, 的共享记忆); single-character entries never reach this rule,
// the length-2 floor already rejects them.
const HAN_FUNCTION_CHARS = new Set([
    '的', '地', '得', '了', '着', '是', '在', '和', '与', '及', '或', '之',
    '也', '都', '就', '很', '不', '有', '这', '那', '我', '你', '他', '她',
    '们', '个',
]);
// Unbalanced parens/brackets/braces mark an extraction fragment (a cut
// header like "dialog open flow (ordering" or "2/(k+1"), not a term; a
// real identifier or phrase closes what it opens. Each pair is counted
// over the whole key and must match.
const BALANCED_PAIRS = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
];
// A wake key is a term, so it opens with a letter. Digit- or symbol-led
// candidates ("0 of 54", "+ `field.field`", "2/(k+1") are line-fragment
// residue, not vocabulary.
const LED_BY_LETTER = /^\p{L}/u;
/**
 * ExtractTriggers computes the three trigger lists for one chunk.
 * Overrides win wholesale: a frontmatter `trigger_extensions:` or
 * `trigger_frameworks:` replaces the heuristics for that field (the
 * author's explicit vocabulary beats detection). `keywords:` only
 * prepends; text signals still contribute wake keywords. Order is
 * deterministic: frontmatter and file-name words first, then
 * fence/inline/manifest/header/emphasis/marker discovery order, then
 * the text's maximal Han runs, deduplicated, lowercased,
 * legality-filtered, capped.
 */
export function extractTriggers(input) {
    const meta = input.noteMeta ?? {};
    const text = input.sectionText;
    const manifestFrameworks = input.manifestVocabulary?.frameworks ?? [];
    return {
        trigger_extensions: extractExtensions(meta, text, input.filePath),
        trigger_frameworks: extractFrameworks(meta, text, manifestFrameworks),
        wake_keywords: extractWakeKeywords(meta, text, input.filePath),
    };
}
// Frontmatter override, else fenced-block languages, inline file paths,
// and the note's own file name (a note titled `server.ts.md` is about a
// .ts file) unioned in discovery order.
function extractExtensions(meta, text, filePath) {
    const override = frontmatterList(meta['trigger_extensions'])
        .map(normalizeExtension)
        .filter((ext) => ext !== null);
    if (override.length > 0) {
        return capColumn(override, 'triggerExtensions');
    }
    const extensions = [];
    for (const match of text.matchAll(FENCE_OPEN)) {
        const ext = FENCE_LANGUAGE_EXTENSIONS[(match[1] ?? '').toLowerCase()];
        if (ext !== undefined) {
            extensions.push(ext);
        }
    }
    for (const match of text.matchAll(INLINE_PATH)) {
        const ext = `.${(match[1] ?? '').toLowerCase()}`;
        if (KNOWN_INLINE_EXTENSIONS.has(ext)) {
            extensions.push(ext);
        }
    }
    const own = normalizeExtension(filePath.replace(/\.md$/i, '').match(/\.([A-Za-z][A-Za-z0-9]{0,7})$/)?.[1] ?? '');
    if (own !== null && KNOWN_INLINE_EXTENSIONS.has(own)) {
        extensions.push(own);
    }
    return capColumn(dedupe(extensions), 'triggerExtensions');
}
// Frontmatter override, else every framework alias and manifest label
// that appears as a word in the section text. Manifest labels are
// presence-gated on purpose: the workspace knows about react, but a note
// about vault CSS must not inherit the react trigger.
function extractFrameworks(meta, text, manifestFrameworks) {
    const override = frontmatterList(meta['trigger_frameworks'])
        .map((value) => value.toLowerCase());
    if (override.length > 0) {
        return capColumn(dedupe(override), 'triggerFrameworks');
    }
    const candidates = new Set();
    for (const alias of Object.keys(FRAMEWORK_ALIASES)) {
        if (wordPresent(text, alias)) {
            candidates.add(FRAMEWORK_ALIASES[alias]);
        }
    }
    for (const label of manifestFrameworks) {
        const canonical = label.trim().toLowerCase();
        if (canonical !== '' && wordPresent(text, canonical)) {
            candidates.add(canonical);
        }
    }
    return capColumn([...candidates], 'triggerFrameworks');
}
// Wake keywords in fixed source order: frontmatter keywords, the note
// file-name slug words, the chunker's "A > B > C" header-path first line,
// ATX headers, bold and emphasized spans, the non-generic intent-marker
// words present in the text, then the chunk text's maximal Han runs
// (TASK-017: the analyzer stores and gates Han by maximal runs, so the
// runs must be stored to keep zh rows reachable through the wake gate).
// The file-name slug carries the author's own title words (memory_write
// slugs index_title into the filename), so a chunk whose only wake
// signals were generic house-format labels still surfaces its topic;
// without it, dropping the marker labels would leave such chunks empty
// (TASK-001 pollution fix; see spec §Pre-flight).
function extractWakeKeywords(meta, text, filePath) {
    const keywords = frontmatterList(meta['keywords']).map(normalizePhrase);
    keywords.push(...fileNameWords(filePath));
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    if (!firstLine.trimStart().startsWith('#') && firstLine.includes(' > ')) {
        keywords.push(...firstLine.split(' > ').map(normalizePhrase));
    }
    for (const match of text.matchAll(ATX_HEADER)) {
        keywords.push(normalizePhrase(match[1] ?? ''));
    }
    for (const match of text.matchAll(BOLD_SPAN)) {
        keywords.push(normalizePhrase(match[1] ?? match[2] ?? ''));
    }
    for (const match of text.matchAll(EMPHASIS_SPAN)) {
        keywords.push(normalizePhrase(match[1] ?? match[2] ?? ''));
    }
    for (const marker of INTENT_MARKERS) {
        if (wordPresent(text, marker)) {
            keywords.push(marker);
        }
    }
    const usable = keywords.filter((keyword) => isUsableKeyword(keyword));
    // Han runs rank after every existing entry: dedupe keeps the earlier
    // occurrence, so a frontmatter keyword equal to a run holds its
    // frontmatter slot, and the capColumn cut trims runs first.
    for (const [run] of text.matchAll(HAN_RUN)) {
        if (isUsableKeyword(run)) {
            usable.push(run);
        }
    }
    return capColumn(dedupe(usable), 'wakeKeywords');
}
// Splits the note's file name (minus ".md") into alphanumeric words: the
// title slug memory_write derived from index_title. Path directories and
// the extension drop out; "server.ts" yields "server" and "ts". A word
// still has to pass isUsableKeyword, so digit-led slug parts like "301"
// in "route-normalizer-301" fall away like any other fragment.
function fileNameWords(filePath) {
    const base = filePath.split('/').pop() ?? '';
    const slug = /\.md$/i.test(base) ? base.slice(0, -3) : base;
    return slug
        .split(/[^\p{L}\p{N}]+/u)
        .map((word) => word.toLowerCase())
        .filter((word) => word !== '');
}
// Frontmatter list values arrive as YAML arrays, comma lists, or a single
// scalar; all three normalize to a trimmed string list.
function frontmatterList(value) {
    if (Array.isArray(value)) {
        return value
            .filter((item) => typeof item === 'string' || typeof item === 'number')
            .map((item) => String(item).trim())
            .filter((item) => item !== '');
    }
    if (typeof value === 'string') {
        return value.split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== '');
    }
    return [];
}
/**
 * NormalizeExtension renders ".ts", "ts", ".TS ", and " .tsx" to one dotted
 * lowercase form, and returns null for anything left of that. It defines the
 * canonical spelling of a trigger extension: the extractor stores values
 * through it, so a search filter must normalize its candidate the same way to
 * match a stored trigger_extensions element.
 */
export function normalizeExtension(raw) {
    const core = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9+#]/g, '');
    return core === '' ? null : `.${core}`;
}
// IsHanFunctionRun reports whether every character of a keyword is a
// standalone Han function-word character: pure-function shapes (是的,
// 我们的) are harvested noise, while a run that keeps any content
// character (时代, 的共享记忆) is a term.
function isHanFunctionRun(keyword) {
    return [...keyword].every((character) => HAN_FUNCTION_CHARS.has(character));
}
// Word-boundary presence test, case-insensitive, with identifier-aware
// boundaries so "kubernetes" does not match inside "kubernetes-cli".
function wordPresent(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
// Keyword canonical form: lowercase, inner whitespace collapsed, edge
// punctuation trimmed (headers arrive as "**Why:**").
function normalizePhrase(raw) {
    return raw
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(KEYWORD_EDGES, '');
}
// isUsableKeyword is the ONE legality gate every wake candidate passes,
// whichever path harvested it (frontmatter, file name, header, emphasis,
// intent marker, Han run). A keyword must be at least 2 chars, at most the
// schema element cap, and few enough words to behave like a keyword, not a
// sentence; must not be a generic house-format label (the TASK-001 audit
// showed those dominating the corpus wake vocabulary); must not be entirely
// Han function-word characters (the TASK-017 Han harvest mirrors the
// analyzer-strip's whole-run noise rule); must open with a letter, balance
// its parens/brackets/braces, and carry no internal em dash, so digit- and
// symbol-led cut fragments cannot pass (the same audit's tail: "0 of 54",
// "2/(k+1", "+ `field.field`", a 54-char em-dashed sentence fragment).
function isUsableKeyword(keyword) {
    if (keyword.length < 2 || keyword.length > MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords) {
        return false;
    }
    if (keyword.split(' ').length > MAX_WAKE_KEYWORD_WORDS) {
        return false;
    }
    if (GENERIC_WAKE_TERMS.has(keyword)) {
        return false;
    }
    if (isHanFunctionRun(keyword)) {
        return false;
    }
    if (!LED_BY_LETTER.test(keyword)) {
        return false;
    }
    // normalizePhrase already trims em dashes at the edges; one surviving
    // inside means two clauses were glued, i.e. a harvested cut.
    if (keyword.includes('—')) {
        return false;
    }
    return BALANCED_PAIRS.every(([open, close]) => keyword.split(open).length === keyword.split(close).length);
}
function dedupe(values) {
    return [...new Set(values)];
}
/**
 * CapColumn enforces one column's contract on a trigger list: it drops
 * elements longer than the column's max_length, then keeps
 * max_capacity entries. Both limits are read from the same column key, so a
 * list can never be capped against the wrong column (constants.ts).
 */
function capColumn(values, column) {
    return values
        .filter((value) => value.length <= MILVUS_ARRAY_ELEMENT_MAX_LENGTHS[column])
        .slice(0, MILVUS_ARRAY_CAPACITIES[column]);
}
//# sourceMappingURL=triggers.js.map
