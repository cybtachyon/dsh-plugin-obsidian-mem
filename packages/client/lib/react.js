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
// reactModuleRef holds the bootstrap's resolved react module; null until
// setReactModule runs, so a member called before the bootstrap wired react
// throws through getReactModule.
let reactModuleRef = null;
/**
 * SetReactModule hands the bootstrap's resolved react module to the shim.
 * createCard calls it after requireRuntimeModules resolves react, so the card
 * renders with the same frozen-table module the bootstrap required.
 */
export function setReactModule(reactModule) {
    reactModuleRef = reactModule;
}
/** GetReactModule returns the wired module; it throws before the wiring. */
export function getReactModule() {
    if (reactModuleRef === null) {
        throw new Error('obsidian-mem card: react module not wired; call setReactModule first');
    }
    return reactModuleRef;
}
// The stable shim every TSX file imports as `react` (the JSX factory name).
// Every member delegates at call time, so the object exists at module load
// without touching the not-yet-wired react module.
export const react = {
    createElement: (type, props, ...children) => getReactModule().createElement(type, props, ...children),
    get Fragment() {
        return getReactModule().Fragment;
    },
    useState: (initial) => getReactModule().useState(initial),
    useRef: (initialValue) => getReactModule().useRef(initialValue),
    useEffect: (effect, deps) => getReactModule().useEffect(effect, deps),
};
//# sourceMappingURL=react.js.map
