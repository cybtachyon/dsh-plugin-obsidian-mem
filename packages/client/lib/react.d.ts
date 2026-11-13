/**
 * The module-scope `react` the classic JSX transform targets.
 *
 * The bundle keeps its require('react') in the bootstrap (requireRuntimeModules
 * in plugin.ts), not at module load: a host without react skips the card
 * there. The TSX files import this shim instead of `react` directly, and the
 * classic transform (jsxFactory react.createElement, see
 * packages/client/tsconfig.json and scripts/build-client.mjs) resolves every
 * element through it. The shim is a stable object whose members delegate to
 * the module wired by setReactModule, so a render before the bootstrap wired
 * react fails loudly instead of reading a stale module.
 * @module dsh-plugin-obsidian-mem/client/react
 */
/**
 * ReactLike is the react surface the card calls. The full react type is a
 * runtime external, not a compile dependency, so the card names only what it
 * calls: the classic transform's createElement and Fragment, plus the hooks
 * the sections use.
 */
export interface ReactLike {
    createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
    Fragment: unknown;
    useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
    useRef<T>(initialValue: T): {
        current: T;
    };
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
/**
 * SetReactModule hands the bootstrap's resolved react module to the shim.
 * createCard calls it after requireRuntimeModules resolves react, so the card
 * renders with the same frozen-table module the bootstrap required.
 */
export declare function setReactModule(reactModule: ReactLike): void;
/** GetReactModule returns the wired module; it throws before the wiring. */
export declare function getReactModule(): ReactLike;
export declare const react: ReactLike;
//# sourceMappingURL=react.d.ts.map
