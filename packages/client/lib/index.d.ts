/**
 * The browser card entry: the lazy-CJS factory exports.
 *
 * apply wires the Obsidian Mem settings card into the host (see ./plugin.ts).
 * inject is empty because `slots` is optional (registerCard takes it on its
 * own scoped inject), so the plugin loads in every profile.
 * @module dsh-plugin-obsidian-mem/client
 */
import { apply } from './plugin.js';
export declare const name = "obsidian-mem-client";
export declare const inject: string[];
declare const plugin: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default plugin;
export { apply };
//# sourceMappingURL=index.d.ts.map
