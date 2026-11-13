# TASK-26 Ignore the whole `.idea/` directory

`.gitignore` lists only `.idea/workspace.xml` and `.idea/tasks.xml`, so the
remaining IDE files (`modules.xml`, `vcs.xml`, `*.iml`, `inspectionProfiles/`)
keep `git status --porcelain` permanently dirty with `?? .idea/`. The
`git status --porcelain` empty-tree gates in TASK-09, TASK-18, and TASK-21 are
unreadable while that stands.

Replace the two rows with a single `.idea/` row under the "Editor / OS noise"
heading.

`git clean -fxd` in TASK-18 still removes the directory because `-x` includes
ignored files, which is the outcome the questionnaire accepted; the IDE
regenerates it on next open.

## Definition of Done

- `git check-ignore -v .idea/modules.xml .idea/vcs.xml .idea/workspace.xml`
  matches the new `.idea/` row for all three.
- `git status --porcelain` prints nothing on an otherwise clean tree.
