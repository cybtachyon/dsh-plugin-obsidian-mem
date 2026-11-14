import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// VerifyEmit asserts every tsc-expected artifact exists and is non-empty.
// Runs last in `pnpm build`: a truncated or missing lib output must fail the
// build here, not later as a runtime ESM link error in the dsh host. The
// corruption this guards (see the dsh-plugin-local-infer release of 0.1.4)
// left whole output directories as 1-byte files while tsbuildinfo still
// reported "up to date".

const ROOT = process.cwd();

const PACKAGE_JSON = 'packages';

// PromptByteCarriers: the three prepared prompt constants
// (PLAN-git-versioning source of truth) and their src/lib carrier pair.
// Each lib .js must hold the src constant's exact UTF-8 bytes: the
// trailing spaces inside those literals are load-bearing, and
// scripts/build-format.mjs's PREPARED_PROMPT_CARRIERS skip-list is what
// keeps its strip pass off them. This check fails the build when a
// build-format edit ever restrips a carrier, so the lib copy the runtime
// seeds (loadPrompt writes <dbDir>/dream-prompt.md from the lib constant)
// can never silently differ from the prepared source. The six files are
// the set prek.toml's trailing-whitespace exclude names:
// ^packages/(service/(src|lib)/dream\.(ts|js)|tools/(src|lib)/(prompt|audit)\.(ts|js))$.
export const PROMPT_BYTE_CARRIERS = [
    {
        src: 'packages/service/src/dream.ts',
        lib: 'packages/service/lib/dream.js',
        constant: 'DEFAULT_DREAM_PROMPT',
    },
    {
        src: 'packages/tools/src/prompt.ts',
        lib: 'packages/tools/lib/prompt.js',
        constant: 'MEMORY_PROMPT_SECTION_TEXT',
    },
    {
        src: 'packages/tools/src/audit.ts',
        lib: 'packages/tools/lib/audit.js',
        constant: 'AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT',
    },
];

// extractPromptConstant returns the exact bytes of one template-literal
// constant, between the backticks of its `export const NAME = ` declaration,
// or null when the text does not declare it. Backslash escapes are skipped,
// so the \` pairs inside the prompt literals do not end the scan early.
function extractPromptConstant(text, constant) {
    const declaration = text.indexOf(`export const ${constant} = `);
    if (declaration < 0) {
        return null;
    }
    const open = text.indexOf('`', declaration + `export const ${constant} = `.length);
    if (open < 0) {
        return null;
    }
    let i = open + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2;
            continue;
        }
        if (text[i] === '`') {
            break;
        }
        i += 1;
    }
    return Buffer.from(text.slice(open + 1, i), 'utf8');
}

// promptConstantDrifts lists, for a tree rooted at rootDir, one message per
// carrier pair whose lib .js no longer holds the src constant's exact bytes
// (or whose declaration vanished, which extraction alone cannot tell apart
// from a rename). Returns [] when the six carriers are byte-faithful.
export function promptConstantDrifts(rootDir) {
    const drifts = [];
    for (const { src, lib, constant } of PROMPT_BYTE_CARRIERS) {
        let srcBytes;
        let libBytes;
        try {
            srcBytes = extractPromptConstant(fs.readFileSync(path.join(rootDir, src), 'utf8'), constant);
            libBytes = extractPromptConstant(fs.readFileSync(path.join(rootDir, lib), 'utf8'), constant);
        } catch {
            drifts.push(`${lib}: cannot read src/lib pair for ${constant}`);
            continue;
        }
        if (srcBytes === null || libBytes === null) {
            drifts.push(`${lib}: ${constant} declaration not found in ${srcBytes === null ? src : lib}`);
        } else if (Buffer.compare(srcBytes, libBytes) !== 0) {
            drifts.push(`${lib}: ${constant} is ${String(libBytes.length)} bytes vs `
                + `${src} ${String(srcBytes.length)}: a prompt carrier was restripped `
                + '(keep the scripts/build-format.mjs PREPARED_PROMPT_CARRIERS skip-list)');
        }
    }
    return drifts;
}

// Emitted siblings for each source file, keyed by source extension.
// The base tsconfig turns on declaration, sourceMap and declarationMap
// for every package, so all four land for each source.
const EMITTED = ['js', 'js.map', 'd.ts', 'd.ts.map'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

// readTsConfig parses a package tsconfig; it strips // comments because
// these files carry them and only compilerOptions.rootDir/outDir matter.
function readTsConfig(pkgDir) {
    const raw = fs.readFileSync(path.join(pkgDir, 'tsconfig.json'), 'utf8');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

// expectedOutputs lists the artifact paths one package must contain,
// derived from its own sources so the check never trusts lib/ itself.
function expectedOutputs(pkgDir) {
    const tsconfig = readTsConfig(pkgDir);
    const rootDir = path.join(pkgDir, tsconfig.compilerOptions.rootDir ?? 'src');
    const outDir = path.join(pkgDir, tsconfig.compilerOptions.outDir ?? 'lib');
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const sources = fs.readdirSync(rootDir, { recursive: true });
    const expected = [];
    for (const source of sources) {
        const sourcePath = path.join(rootDir, source);
        if (!fs.statSync(sourcePath).isFile()) {
            continue;
        }
        if (!SOURCE_EXTENSIONS.some(ext => source.endsWith(ext))
            || source.endsWith('.d.ts')) {
            continue;
        }
        const stem = path.join(outDir, source.replace(/\.[^./\\]+$/, ''));
        for (const ext of EMITTED) {
            expected.push(`${stem}.${ext}`);
        }
    }
    return expected;
}

function inspectArtifacts(expected) {
    const broken = [];
    for (const file of expected) {
        let size;
        try {
            size = fs.statSync(file).size;
        } catch {
            broken.push(`${path.relative(ROOT, file)} (missing)`);
            continue;
        }
        // A tsc artifact is never shorter than a JSON object or one
        // statement; 0 and 1 bytes are the truncation and blank-line
        // signatures of emptied outputs.
        if (size < 2) {
            broken.push(`${path.relative(ROOT, file)} (${size} bytes)`);
        }
    }
    return broken;
}

// main runs the checks and exits non-zero on any breakage.
function main() {
    const packages = fs.readdirSync(path.join(ROOT, PACKAGE_JSON), { withFileTypes: true })
        .filter(entry => entry.isDirectory()
            && fs.existsSync(path.join(ROOT, PACKAGE_JSON, entry.name, 'tsconfig.json')))
        .map(entry => path.join(ROOT, PACKAGE_JSON, entry.name));

    // One derivation per package, shared by the broken check and the total, so
    // the reported count and the verified set can never disagree.
    const expected = packages.flatMap(pkg => expectedOutputs(pkg));
    const broken = inspectArtifacts(expected);

    // The hand-written carrier the bare package-root export resolves to; the
    // Loader mounts it to key the `dsh.client` scan, so a truncated copy breaks
    // every install of the bundle.
    const hostCarrier = path.join(ROOT, 'dsh', 'host.js');
    if (!fs.existsSync(hostCarrier) || fs.statSync(hostCarrier).size < 2) {
        broken.push('dsh/host.js (missing or truncated)');
    }

    // The browser bundle scripts/build-client.mjs writes: a shipped half of the
    // install (the dsh.client manifest block loads it), always required from
    // TASK-052 on, with the same missing-or-truncated signature as the carrier.
    const clientArtifact = path.join(ROOT, 'dsh', 'client.js');
    if (!fs.existsSync(clientArtifact) || fs.statSync(clientArtifact).size < 2) {
        broken.push('dsh/client.js (missing or truncated)');
    }

    // Byte fidelity of the prepared prompt constants in their lib carriers.
    broken.push(...promptConstantDrifts(ROOT));

    if (broken.length > 0) {
        console.error(`verify-emit: ${broken.length} broken artifact(s):`);
        for (const item of broken) {
            console.error(`  ${item}`);
        }
        console.error('Delete packages/*/tsconfig.tsbuildinfo and rerun the build.');
        process.exit(1);
    }

    console.log(`verify-emit: ${expected.length} tsc artifacts intact across ${packages.length} packages; `
        + `${PROMPT_BYTE_CARRIERS.length} prompt carriers byte-exact`);
}

// Only run when invoked as a script; packages/tools/tests/prompt-emit-bytes
// .spec.ts imports promptConstantDrifts and the carrier list from here.
if (process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
