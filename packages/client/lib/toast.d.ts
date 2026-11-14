/**
 * The card's shared toast: the auto-dismissing message state, its hold timer,
 * and the rendered Toast node, in one home every section that confirms a
 * mutation draws from (Dreaming's accepted-run line, Configuration's
 * applied-settings line).
 * @module dsh-plugin-obsidian-mem/client/toast
 */
import type { ReactNode } from 'react';
/** How long an accepted-action toast stays up before the hold timer unmounts it. */
export declare const TOAST_HOLD_MS = 4000;
/** ToastHandle is one section's toast: the node to render and the way to raise it. */
export interface ToastHandle {
    /** The Toast element while a message is up, null otherwise; the owner renders it. */
    readonly node: ReactNode;
    /** Show raises or replaces the message and restarts the hold timer. */
    show(text: string): void;
}
/**
 * UseToast owns the toast message state, the TOAST_HOLD_MS auto-dismiss
 * timer, and the renderToast call (the Toast's own onDone and the timer both
 * clear it). The owner renders `node` wherever the toast belongs and calls
 * `show` when an accepted action earns one.
 */
export declare function useToast(): ToastHandle;
//# sourceMappingURL=toast.d.ts.map
