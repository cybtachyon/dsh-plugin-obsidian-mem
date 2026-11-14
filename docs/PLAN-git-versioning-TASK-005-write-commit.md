# TASK-005-write-commit

`memory_write` lands a git commit at the end of its process (Q3 default:
one commit per successful write; per-vault serialized by TASK-004's
manager).

Hook point: `ObsidianMemService.applyWrite` (the ONE write-through
primitive every `memory_write` flows through, tools/write.ts:304). After
the atomic write, read-registry update, and write-through reindex, and
before the return, call
`commitVault(classified.vault.path, \`obsidian-mem: memory_write ${relPath} ${isoStamp}\`)`
where `isoStamp` is the ISO 8601 time of the call. Archive writes commit
like any other. A clean tree (no staged diff, e.g. an identical rewrite)
commits nothing and returns null quietly (the wrapper's `commitAll`
contract).

Failure policy: a commit throw is `log.warn`-only; the write already
succeeded and still returns `written` (warn-don't-die; the memory file is
the source of truth, git is the history book). Git disabled or a vault the
manager never adopted (adoption failed earlier) resolve to null no-ops.

The `write()` wrapper path (service API, used by the UI) flows through the
same seam, so it commits identically; the tools layer gains NO new fields
(this keeps the `memory_write` closed output union untouched).

Tests (service spec family, fake `GitRunner`): successful write triggers
exactly one commit with the message shape (regex pin:
`obsidian-mem: memory_write <rel> <ISO>`); disabled config commits
nothing; commit throw still returns the write result and logs; read-only
vault path (already refused pre-write) never reaches git.

Definition of Done: build + service suite green; src+lib committed
together.
