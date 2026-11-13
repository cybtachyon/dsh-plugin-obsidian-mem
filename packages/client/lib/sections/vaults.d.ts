/**
 * The Vaults section: the registry rows (path, source, mode), the add form
 * (path + mode), and the guarded two-step remove.
 *
 * The rows read the polled status (status.vaults is the same sync registry
 * view the routes serve). Remove is two-step (Remove, then Confirm right
 * next to it, never a dialog): the route answers a settings-managed or
 * auto-provisioned vault with 409 vault_protected and a shadowing clash with
 * 409 vault_conflict, and BOTH host messages render verbatim, because the
 * protected message names the actionable place to remove the vault.
 * @module dsh-plugin-obsidian-mem/client/sections/vaults
 */
import type { ReactNode } from 'react';
import { type StatusPayload } from '../api.js';
export interface VaultsSectionProps {
    status: StatusPayload | null;
    refresh: () => void;
}
export declare function VaultsSection(props: VaultsSectionProps): ReactNode;
//# sourceMappingURL=vaults.d.ts.map
