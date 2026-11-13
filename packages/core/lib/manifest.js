/**
 * Scans a workspace tree into a WorkspaceManifest: languages, frameworks,
 * build systems, dependency files, top file extensions, and directory
 * signals, plus manifestQueryText, the compact sorted string embedded
 * alongside the user prompt at turn start.
 *
 * Detection comes only from dependency/manifest files (package.json,
 * tsconfig.json, go.mod, Cargo.toml, requirements*.txt, pyproject.toml,
 * setup.py, Pipfile, composer.json, Gemfile, pom.xml, build.gradle(.kts),
 * CMakeLists.txt, mix.exs, *.csproj) and build-system files (Makefile,
 * justfile, mise.toml, Taskfile.yml), never from ad-hoc sources. Pure
 * against an injected fs; no env, no @deepseek-ai imports.
 * @module dsh-plugin-obsidian-mem/core/manifest
 */
import { join } from 'node:path';
// Directory nesting cap: files at workspace-relative depth 1..3 are
// scanned; deeper paths are left out to bound the walk on huge trees.
const MAX_DEPTH = 3;
// Vendored, generated, virtualenv, and VCS caches hold other projects'
// manifests; scanning them would misattribute dependencies.
const SKIP_DIRECTORIES = new Set([
    'node_modules',
    'vendor',
    'dist',
    'build',
    'target',
    '.git',
    'venv',
    '.venv',
    '__pycache__',
    '.next',
    'coverage',
    '.cache',
]);
// Layout conventions worth telling the embedder about even when no
// manifest names the language (a cmd/ tree alone says Go-style layout).
const DIR_SIGNAL_NAMES = new Set([
    'app',
    'cmd',
    'internal',
    'migrations',
    'packages',
    'src',
    'tests',
]);
const TOP_EXTENSIONS_LIMIT = 8;
const NO_FRAMEWORKS = () => [];
// JS/TS framework packages mapped to canonical labels; dev-only tools
// count too (vite) because they shape the workspace's shape vocabulary.
const JS_FRAMEWORK_PACKAGES = {
    'react': 'react',
    'react-dom': 'react',
    'vue': 'vue',
    'nuxt': 'nuxt',
    'svelte': 'svelte',
    'next': 'next',
    '@angular/core': 'angular',
    'vite': 'vite',
    '@nestjs/core': 'nest',
    'express': 'express',
};
// Content-regex detectors for ecosystems whose dependency declarations
// are plain text; the vendor prefix disambiguates PHP package names.
const PYTHON_FRAMEWORKS = contentRegexFrameworks([
    [/\bdjango\b/i, 'django'],
    [/\bflask\b/i, 'flask'],
    [/\bfastapi\b/i, 'fastapi'],
]);
const PHP_FRAMEWORKS = contentRegexFrameworks([
    [/\blaravel\//i, 'laravel'],
    [/\bsymfony\//i, 'symfony'],
    [/\bdoctrine\//i, 'doctrine'],
]);
const RUBY_FRAMEWORKS = contentRegexFrameworks([
    [/^\s*gem\s+['"]rails['"]/im, 'rails'],
]);
function contentRegexFrameworks(pairs) {
    return (content) => pairs.filter(([pattern]) => pattern.test(content)).map(([, label]) => label);
}
// Dependency maps across the four package.json dependency fields.
// Malformed JSON yields no frameworks but keeps the file itself.
function jsFrameworksFromPackageJson(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return [];
    }
    const records = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .map((field) => parsed[field])
        .filter((record) => typeof record === 'object' && record !== null);
    const labels = [];
    for (const record of records) {
        for (const name of Object.keys(record)) {
            const label = JS_FRAMEWORK_PACKAGES[name];
            if (label !== undefined) {
                labels.push(label);
            }
        }
    }
    return labels;
}
// Exact-name rules. package.json proves the JavaScript ecosystem even
// for TypeScript-only repos (tsconfig.json adds typescript on top).
const EXACT_FILE_RULES = {
    'package.json': { languages: ['javascript'], frameworks: jsFrameworksFromPackageJson },
    'tsconfig.json': { languages: ['typescript'], frameworks: NO_FRAMEWORKS },
    'deno.json': { languages: ['typescript'], frameworks: NO_FRAMEWORKS },
    'go.mod': { languages: ['go'], frameworks: NO_FRAMEWORKS },
    'go.work': { languages: ['go'], frameworks: NO_FRAMEWORKS },
    'Cargo.toml': { languages: ['rust'], frameworks: NO_FRAMEWORKS },
    'pyproject.toml': { languages: ['python'], frameworks: PYTHON_FRAMEWORKS },
    'setup.py': { languages: ['python'], frameworks: PYTHON_FRAMEWORKS },
    'Pipfile': { languages: ['python'], frameworks: PYTHON_FRAMEWORKS },
    'composer.json': { languages: ['php'], frameworks: PHP_FRAMEWORKS },
    'Gemfile': { languages: ['ruby'], frameworks: RUBY_FRAMEWORKS },
    // Any kotlin reference (org.jetbrains.kotlin, the kotlin plugin, a
    // kotlin-stdlib coordinate) proves kotlin next to java.
    'pom.xml': {
        languages: ['java'],
        contentLanguages: [[/\bkotlin\b/i, 'kotlin']],
        frameworks: NO_FRAMEWORKS,
    },
    'build.gradle': {
        languages: ['java'],
        contentLanguages: [[/\bkotlin\b/i, 'kotlin']],
        frameworks: NO_FRAMEWORKS,
    },
    'build.gradle.kts': { languages: ['java', 'kotlin'], frameworks: NO_FRAMEWORKS },
    'CMakeLists.txt': { languages: ['cpp'], frameworks: NO_FRAMEWORKS },
    'mix.exs': { languages: ['elixir'], frameworks: NO_FRAMEWORKS },
    'Makefile': { languages: [], buildSystem: 'make', frameworks: NO_FRAMEWORKS },
    'justfile': { languages: [], buildSystem: 'just', frameworks: NO_FRAMEWORKS },
    'mise.toml': { languages: [], buildSystem: 'mise', frameworks: NO_FRAMEWORKS },
    'Taskfile.yml': { languages: [], buildSystem: 'task', frameworks: NO_FRAMEWORKS },
};
// Name-pattern rules that exact matching cannot express.
const PATTERN_FILE_RULES = [
    [/^requirements[\w.-]*\.txt$/i, { languages: ['python'], frameworks: PYTHON_FRAMEWORKS }],
    [/\.csproj$/i, { languages: ['csharp'], frameworks: NO_FRAMEWORKS }],
];
function fileRuleFor(name) {
    const exact = EXACT_FILE_RULES[name];
    if (exact !== undefined) {
        return exact;
    }
    for (const [pattern, rule] of PATTERN_FILE_RULES) {
        if (pattern.test(name)) {
            return rule;
        }
    }
    return null;
}
/**
 * scanManifest walks cwd to MAX_DEPTH directories deep, skipping vendored
 * and generated trees, and records only what dependency/manifest and
 * build-system files prove. Every output list is sorted so identical
 * trees always produce byte-identical manifests (and stable query text).
 */
export function scanManifest(cwd, fsLike) {
    const languages = new Set();
    const frameworks = new Set();
    const buildSystems = new Set();
    const dependencyFiles = [];
    const dirSignals = new Set();
    const extensionCounts = new Map();
    // `depth` is the relative depth of dirAbs itself (0 == cwd), so listed
    // entries sit at depth + 1; recursion into a directory at relative
    // depth d is allowed only while its children stay within MAX_DEPTH.
    const applyFileRule = (absPath, relPath, rule) => {
        // Every recognized manifest/build file belongs in dependencyFiles:
        // it is workspace metadata the query text should name.
        dependencyFiles.push(relPath);
        for (const language of rule.languages) {
            languages.add(language);
        }
        if (rule.buildSystem !== undefined) {
            buildSystems.add(rule.buildSystem);
        }
        const content = fsLike.readFile(absPath);
        if (content === null) {
            return;
        }
        if (rule.contentLanguages !== undefined) {
            for (const [pattern, language] of rule.contentLanguages) {
                if (pattern.test(content)) {
                    languages.add(language);
                }
            }
        }
        for (const framework of rule.frameworks(content)) {
            frameworks.add(framework);
        }
    };
    const walk = (dirAbs, relDir, depth) => {
        const entries = fsLike.listDirectory(dirAbs);
        if (entries === null) {
            return;
        }
        for (const entry of entries) {
            const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
            const absPath = join(dirAbs, entry.name);
            if (entry.directory) {
                if (SKIP_DIRECTORIES.has(entry.name)) {
                    continue;
                }
                if (DIR_SIGNAL_NAMES.has(entry.name)) {
                    dirSignals.add(`${entry.name}/`);
                }
                if (depth + 1 < MAX_DEPTH) {
                    walk(absPath, relPath, depth + 1);
                }
            }
            else {
                countExtension(extensionCounts, entry.name);
                const rule = fileRuleFor(entry.name);
                if (rule !== null) {
                    applyFileRule(absPath, relPath, rule);
                }
            }
        }
    };
    walk(cwd, '', 0);
    return {
        cwd,
        languages: [...languages].sort(),
        frameworks: [...frameworks].sort(),
        buildSystems: [...buildSystems].sort(),
        dependencyFiles: dependencyFiles.sort(),
        topExtensions: topExtensions(extensionCounts),
        dirSignals: [...dirSignals].sort(),
    };
}
/**
 * manifestQueryText renders the manifest as fixed-order "key: value"
 * lines with sorted lists, the compact deterministic form embedded
 * alongside the user prompt at turn start.
 */
export function manifestQueryText(manifest) {
    return [
        `cwd: ${manifest.cwd}`,
        `languages: ${manifest.languages.join(', ')}`,
        `frameworks: ${manifest.frameworks.join(', ')}`,
        `build systems: ${manifest.buildSystems.join(', ')}`,
        `dependency files: ${manifest.dependencyFiles.join(', ')}`,
        `top extensions: ${manifest.topExtensions.join(', ')}`,
        `directory signals: ${manifest.dirSignals.join(', ')}`,
    ].join('\n');
}
function countExtension(counts, fileName) {
    const dot = fileName.lastIndexOf('.');
    // A leading dot marks an extensionless dotfile (.env), not "env".
    if (dot <= 0) {
        return;
    }
    const extension = fileName.slice(dot + 1).toLowerCase();
    if (extension !== '') {
        counts.set(extension, (counts.get(extension) ?? 0) + 1);
    }
}
function topExtensions(counts) {
    return [...counts.entries()]
        .sort(([extA, countA], [extB, countB]) => countB - countA || extA.localeCompare(extB))
        .slice(0, TOP_EXTENSIONS_LIMIT)
        .map(([extension]) => extension);
}
//# sourceMappingURL=manifest.js.map
