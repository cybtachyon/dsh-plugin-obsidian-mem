# TASK-22 Untrack the coverage output

## Finding: the premise was wrong, no action needed

Phase 1 reported "507 vitest coverage files tracked under an ignored
`coverage/`". That number is the on-disk file count of the local working
directory, not the index:

- `git ls-files coverage | wc -l` is 0.
- `git log --oneline -- coverage` has no history, so nothing was ever committed.
- `git check-ignore -v coverage/index.html` matches `.gitignore:18:coverage/`.

Coverage is test output and stays ignored. No `git rm --cached`, no commit.

## Definition of Done

- `git ls-files coverage | wc -l` is 0. (Met.)
- `.gitignore` keeps the `coverage/` row. (Met.)
