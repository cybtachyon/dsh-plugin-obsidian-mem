# TASK-19 Verify DSH loads the post-clean runtime files

With the profile install being the symlink
`~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem`:

1. Resolve every root `exports` subpath from the profile path
   (`node -e "require.resolve(...)"` / ESM equivalent) for `.`, `./client`,
   `./core`, `./service`, `./ui`, `./tools`, `./events`, `./icon`,
   `./locale/en.json`.
2. Import each host entry point in a throwaway node process and assert the
   module exposes its Cordis plugin default export (no side effects that touch
   the live Milvus vault: import only, do not activate).
3. Load `dsh/client.js` through the existing carrier test
   (`packages/client` or the vitest spec that fakes
   `window.__ModuleLoader__.load`) rather than a browser.
4. Live check: `plugin_manager list_plugins` shows the `obsidian-mem*`
   entries for this profile and `cordis_inspect_list` still reports the
   plugin's providers, proving the running host's graph matches disk.

## Definition of Done

- All nine `exports` targets resolve from the symlink.
- Host entry imports succeed with no throw.
- `plugin_manager list_plugins` shows the plugin rows enabled.
- Findings recorded here.
