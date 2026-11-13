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

if (broken.length > 0) {
    console.error(`verify-emit: ${broken.length} broken artifact(s):`);
    for (const item of broken) {
        console.error(`  ${item}`);
    }
    console.error('Delete packages/*/tsconfig.tsbuildinfo and rerun the build.');
    process.exit(1);
}

console.log(`verify-emit: ${expected.length} tsc artifacts intact across ${packages.length} packages`);
