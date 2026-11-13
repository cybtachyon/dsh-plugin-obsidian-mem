/**
 * The card entry factory, and the marker scripts/build-client.mjs keys the
 * dsh/client.js bundle on: the build requires one of card.ts / card.tsx to
 * exist, so this file is the pipeline switch as much as the composition root.
 *
 * createCard wires the two runtime externals (react, and the primitives seed
 * or its null fallback) into the seams the TSX files render through, and
 * answers the card component the slot registration mounts.
 * @module dsh-plugin-obsidian-mem/client/card
 */
import { type PrimitivesModule } from './primitives.js';
import { type ReactLike } from './react.js';
/**
 * CreateCard wires the bootstrap's resolved modules and answers the card
 * component (a plain function component the slot system mounts as-is).
 */
export declare function createCard(reactModule: ReactLike, primitives: PrimitivesModule | null): unknown;
//# sourceMappingURL=card.d.ts.map
