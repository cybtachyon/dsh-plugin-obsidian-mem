/**
 * The card root: header, the 10 s status poll, and the five collapsible
 * sections (Vaults, Index status, Audit, Dreaming, Search test).
 *
 * The poll owns the only shared data (GET /obsidian-mem/status; the interval
 * is cleared on unmount and a re-render after unmount never lands). Every
 * other fetch belongs to its section; the one cross-section flow is the
 * global-budget meter: the audit pass measures injected tokens, so the Audit
 * section hands its budget report up and the Index section displays it.
 * @module dsh-plugin-obsidian-mem/client/cardRoot
 */
import type { ReactNode } from 'react';
/** How often the card re-reads GET /obsidian-mem/status while mounted. */
export declare const STATUS_POLL_INTERVAL_MS = 10000;
/** CardRoot is the component the slot registration mounts. */
export declare function CardRoot(): ReactNode;
/** RowHint is the shared quiet hint line sections use for empty states. */
export declare function RowHint({ text }: {
    text: string;
}): ReactNode;
//# sourceMappingURL=cardRoot.d.ts.map
