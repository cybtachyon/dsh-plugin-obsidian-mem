import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// PreparedPromptCarriers: names the six files that hold the prepared prompt
// constants (PLAN-git-versioning source of truth). The trailing spaces
// inside those prompt literals are load-bearing bytes, so this script's
// per-line strip pass must pass over them. The set mirrors the prek.toml
// trailing-whitespace exclude regex
// ^packages/(service/(src|lib)/dream\.(ts|js)|tools/(src|lib)/(prompt|audit)\.(ts|js))$
// and is the build's single home for that path set; the src entries are
// no-ops here (this script only visits emitted trees) and keep the two
// lists name-for-name. scripts/verify-emit.mjs fails the build when a lib
// carrier ever stops matching its src constant's exact bytes.
export const PREPARED_PROMPT_CARRIERS = new Set([
    'packages/service/src/dream.ts',
    'packages/service/lib/dream.js',
    'packages/tools/src/prompt.ts',
    'packages/tools/lib/prompt.js',
    'packages/tools/src/audit.ts',
    'packages/tools/lib/audit.js',
]);

// Target directories: the hand-written dsh/ carriers plus every workspace
// package's tsc outDir. Package lib dirs are derived from the packages/ tree
// so a new package is covered without editing this script: lib IS tracked, so
// an unformatted package lib would break the clean-tree build gate.
const TARGET_DIRS = [
    'dsh',
    ...readdirSync(path.join(process.cwd(), 'packages'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join('packages', entry.name, 'lib')),
].map(dir => path.join(process.cwd(), dir));

async function processDirectory(dir) {
    try {
        // Check if path exists using stat instead of existsSync
        const stat = await fs.stat(dir).catch(() => null);
        if (!stat || !stat.isDirectory()) return;

        const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });

        // Map entries to a list of promises so they run concurrently
        const tasks = entries.map(async (entry) => {
            const currentDir = entry.parentPath;
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                return processDirectory(fullPath);
            }

            const isEmitted = entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')
                || entry.name.endsWith('.js.map') || entry.name.endsWith('.d.ts.map');
            if (entry.isFile() && isEmitted) {
                const content = await fs.readFile(fullPath, 'utf8');

                // Never rewrite a blank artifact: normalizing "" to "\n" is
                // how a read racing a mid-write emitter persists an emptied
                // 1-byte file. Leave it for verify-emit.mjs to fail on.
                if (content.trim() === '') {
                    return;
                }

                // Strip per-line trailing whitespace (tsc emits some after
                // collapsed multi-line calls) and keep the final newline, so
                // the trailing-whitespace and end-of-file-fixer hooks stay
                // no-ops for lib files. The prompt carriers skip only the
                // strip: their load-bearing trailing spaces must survive to
                // the shipped lib copy, exactly as the prek.toml
                // trailing-whitespace exclude leaves them; the final-newline
                // fix keeps end-of-file-fixer (which does exclude nothing)
                // satisfied for them too.
                const isPromptCarrier = PREPARED_PROMPT_CARRIERS.has(
                    path.relative(process.cwd(), fullPath).split(path.sep).join('/'));
                let normalized = isPromptCarrier
                    ? content
                    : content
                        .split('\n')
                        .map(line => line.replace(/[ \t]+$/, ''))
                        .join('\n');
                if (!normalized.endsWith('\n')) {
                    normalized += '\n';
                }

                if (normalized !== content) {
                    await fs.writeFile(fullPath, normalized, 'utf8');
                }
            }
        });

        // Wait for all files/subdirectories in this folder to complete in parallel
        await Promise.all(tasks);
    } catch (err) {
        console.error(`Error processing directory ${dir}:`, err);
    }
}

// Kick off all root-level directories concurrently. The entry guard lets a
// spec import PREPARED_PROMPT_CARRIERS without running the pass.
if (process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await Promise.all(TARGET_DIRS.map(dir => processDirectory(dir)));
}
