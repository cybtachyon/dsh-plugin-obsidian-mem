// Host carrier for the dsh-plugin-obsidian-mem client half.
//
// The bare package has no host logic of its own; its four host entries are the
// /service, /ui, /tools, and /events subpaths. This no-op module exists so
// the Loader mounts the bare package name, which is what the client-module
// scan keys the `dsh.client` declaration on. Without it the browser card in
// dsh/client.js is never added to the boot graph, because the scan only maps
// a bare package-root entry to its `dsh.client` field, never a subpath.
export const name = 'obsidian-mem'
export const inject = []
export function apply(ctx) {
  void ctx
}
const plugin = { name, inject, apply }
export default plugin
