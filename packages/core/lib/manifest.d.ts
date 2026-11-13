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
/** The scan outcome for one workspace root. Every list is sorted. */
export interface WorkspaceManifest {
    /** The workspace root the scan started from, verbatim. */
    cwd: string;
    /** Language labels detected from manifest files, alphabetical. */
    languages: string[];
    /** Framework labels detected from dependency names, alphabetical. */
    frameworks: string[];
    /** Build-system labels detected from build files, alphabetical. */
    buildSystems: string[];
    /** Workspace-relative manifest/build files found, lexicographic. */
    dependencyFiles: string[];
    /** Up to 8 most common file extensions by count (count DESC, then alpha). */
    topExtensions: string[];
    /** Recognized directory names present, each suffixed with "/", alpha. */
    dirSignals: string[];
}
/** One directory entry as the scan needs it. */
export interface ManifestDirEntry {
    name: string;
    directory: boolean;
}
/**
 * ManifestFs is the read-only fs surface the scanner needs. The service
 * implements it over node:fs; tests pass an in-memory tree.
 */
export interface ManifestFs {
    /** Lists a directory's direct entries; null when unreadable (skip it). */
    listDirectory(path: string): ManifestDirEntry[] | null;
    /** Reads a UTF-8 file; null when missing or unreadable (skip content). */
    readFile(path: string): string | null;
}
/**
 * scanManifest walks cwd to MAX_DEPTH directories deep, skipping vendored
 * and generated trees, and records only what dependency/manifest and
 * build-system files prove. Every output list is sorted so identical
 * trees always produce byte-identical manifests (and stable query text).
 */
export declare function scanManifest(cwd: string, fsLike: ManifestFs): WorkspaceManifest;
/**
 * manifestQueryText renders the manifest as fixed-order "key: value"
 * lines with sorted lists, the compact deterministic form embedded
 * alongside the user prompt at turn start.
 */
export declare function manifestQueryText(manifest: WorkspaceManifest): string;
//# sourceMappingURL=manifest.d.ts.map
