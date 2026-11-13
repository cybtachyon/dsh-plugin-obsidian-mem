# TASK-01 Un-ignore the lib build output

Edit `.gitignore`: delete the `packages/*/lib/` row and replace its comment
with one stating that `packages/*/lib` is committed so a git or npm install
ships the runtime entry points.

Keep ignored: `node_modules/`, `packages/*/tsconfig.tsbuildinfo`,
`dsh/.build/`, `coverage/`, `.idea/workspace.xml`, `.idea/tasks.xml`,
`.DS_Store`, `*.log`.

## Definition of Done

- `git check-ignore -v packages/core/lib/index.js` exits non-zero (not ignored).
- `git check-ignore packages/core/tsconfig.tsbuildinfo dsh/.build/client.cjs coverage/index.html node_modules`
  still lists all four.
