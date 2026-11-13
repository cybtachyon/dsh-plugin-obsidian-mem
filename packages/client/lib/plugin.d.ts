/**
 * The browser card bootstrap: registerCard and mountCard.
 *
 * The Obsidian Mem config (vault registry, Dreaming triggers, index state)
 * had no way in from the browser; the card is contributed through a slot
 * rather than a settings schema: `plugins.bundle.config`, keyed by the
 * bundle's package name, on the Plugins page, with the `settings.plugin.item`
 * registration for older hosts. It reads and writes only the plugin's own
 * `/obsidian-mem/*` routes, so the browser never sees a value it did not
 * store.
 *
 * React and @deepseek-ai/dsh-client-ui-primitives come from the shell's
 * frozen platform module table (PLATFORM_MODULES): esbuild keeps the two
 * require calls external, so inside the lazy-CJS factory they resolve against
 * the injected require. A missing react skips the card (the throw is caught
 * by mountWhenRouteExists, which logs the skip line); a missing primitives
 * seed is a fallback, not an error, and the card renders with native controls.
 * @module dsh-plugin-obsidian-mem/client/plugin
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * The slots service is dsh-specific and absent from the cordis Context type,
 * so the card narrows the scoped context to the members it needs.
 */
export interface SlotsService {
    /**
     * Wait until the named slot is declared, then run the body. The host calls
     * the body as a plain function (the working plugins register this way), so
     * a generator body is never driven and its register would not run.
     */
    inject(name: string, body: () => void): void;
    /** Register a component into the named slot; returns the registration handle. */
    register(spec: SlotSpec, component: unknown): unknown;
}
/** The slot registration spec: the slot name plus the host-specific keys. */
export interface SlotSpec {
    name: string;
    key?: string;
    id?: string;
    order?: number;
}
/**
 * Apply is the plugin entry point: it wires the card into the host. `slots`
 * is optional, so nothing is required here; registerCard takes it on its own
 * scoped inject.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=plugin.d.ts.map
