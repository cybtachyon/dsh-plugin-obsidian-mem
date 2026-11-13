import fs from 'node:fs';
import path from 'node:path';

// VerifyEmit asserts every tsc-expected artifact exists and is non-empty.
// Runs last in `pnpm build`: a truncated or missing lib output must fail the
// build here, not later as a runtime ESM link error in the dsh host. The
// corruption this guards (see the dsh-plugin-local-infer release of 0.1.4)
// left whole output directories as 1-byte files while tsbuildinfo still
// reported "up to date".

const ROOT = process.cwd();

const PACKAGE_JSON = 'packages';

// Emitted siblings for each source file, keyed by source extension.
// The base tsconfig turns on declaration, sourceMap and declarationMap
// for every package, so all four land for each source.
const EMITTED = ['js', 'js.map', 'd.ts', 'd.ts.map'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

// The browser-card marker scripts/build-client.mjs keys its bundle on: once
// one exists, dsh/client.js is a required artifact (TASK-052). Before that
// (the Phase 1 scaffold) the client package is a plugin stub only and the
// artifact legitimately does not exist yet.
const CARD_MARKERS = [
    'packages/client/src/card.ts',
    'packages/client/src/card.tsx',
];

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

const packages = fs.readdirSync(path.join(ROOT, PACKAGE_JSON), { withFileTypes: true })
    .filter(entry => entry.isDirectory()
        && fs.existsSync(path.join(ROOT, PACKAGE_JSON, entry.name, 'tsconfig.json')))
    .map(entry => path.join(ROOT, PACKAGE_JSON, entry.name));

const broken = packages.flatMap(pkg => inspectArtifacts(expectedOutputs(pkg)));

// The hand-written carrier the bare package-root export resolves to; the
// Loader mounts it to key the `dsh.client` scan, so a truncated copy breaks
// every install of the bundle.
const hostCarrier = path.join(ROOT, 'dsh', 'host.js');
if (!fs.existsSync(hostCarrier) || fs.statSync(hostCarrier).size < 2) {
    broken.push('dsh/host.js (missing or truncated)');
}

// dsh/client.js: required once the browser card exists, tolerated before.
const cardLanded = CARD_MARKERS.some(marker => fs.existsSync(path.join(ROOT, marker)));
const clientArtifact = path.join(ROOT, 'dsh', 'client.js');
if (cardLanded && (!fs.existsSync(clientArtifact) || fs.statSync(clientArtifact).size < 2)) {
    broken.push('dsh/client.js (missing or truncated)');
}

if (broken.length > 0) {
    console.error(`verify-emit: ${broken.length} broken artifact(s):`);
    for (const item of broken) {
        console.error(`  ${item}`);
    }
    console.error('Delete packages/*/tsconfig.tsbuildinfo and rerun the build.');
    process.exit(1);
}

const total = packages.reduce(
    (count, pkg) => count + expectedOutputs(pkg).length, 0);
console.log(`verify-emit: ${total} tsc artifacts intact across ${packages.length} packages`);
if (!cardLanded) {
    console.log('verify-emit: dsh/client.js not required yet (client card lands with TASK-051/052)');
}
