# TASK-06 Verify the npm tarball contents

Run the pack dry-run and compare the file list against what DSH resolves at
load time. No file changes unless the audit finds a gap.

```
npm pack --dry-run --json > /tmp/obsidian-mem-pack.json
```

Required in the tarball:

- `package.json`, `README.md`, `LICENSE`
- `cordis.patch.yml`, `icon.svg`, `locale/en.json`
- `dsh/host.js`, `dsh/client.js`
- `packages/{core,service,ui,tools,events}/package.json`
- for each of those five: `lib/**/*[!.].js` and `lib/**/*.d.ts`

Must NOT be in the tarball: `packages/*/src/**`, `packages/client/**`,
`packages/bundle/**` (unless `exports` references it), `tsconfig*`,
`tests/**`, `coverage/**`, `.github/**`.

Note: `packages/*/lib/**` only appears once TASK-08 has built it. If the pack
audit runs before the build, build first (`pnpm build`) or record the gap and
re-run the audit in TASK-08.

## Definition of Done

- Every required path is present in the pack list; every forbidden path absent.
- The findings (including intentional exclusions) are written into this file
  under a `## Findings` heading.
