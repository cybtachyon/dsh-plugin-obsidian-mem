# TASK-001: verbiage-carrier-rebuild

Phase 1: Launch-side isolation (service).

Ship the user's already-staged verbiage tweaks: the launch text heading
"# Work plan for this run" became "# Work plan for Step 1 of this run" in
`packages/service/src/dream.ts` (drive's `launchText`) and its two
`packages/service/tests/dream.spec.ts` pins. The heading steers the dream
agent to run the work plan as Step 1 of the protocol, so later plan steps
are not forgotten.

## Steps

1. Commit the staged hunks as their own commit (message style:
   `fix(dream): name the launch work plan as Step 1 of the run`).
2. Run `pnpm build`; commit the rebuilt `packages/service/lib/dream.js`
   carrier emit (carrier byte-fidelity rule in the plan header) in the same
   commit or an immediate follow-up so `git status` ends clean.
3. `pnpm test` (dream suite at minimum) green.

## Definition of Done

- The two spec pins read `# Work plan for Step 1 of this run`.
- `pnpm build` passes with verify-emit's prompt-carrier byte check green.
- Working tree clean; commit exists on main (pre-push).
