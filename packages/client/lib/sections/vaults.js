/**
 * The Vaults section: the registry rows (path, source, mode, global file),
 * the add form (path + mode + global file), and the guarded two-step remove.
 *
 * The rows read the polled status (status.vaults is the same sync registry
 * view the routes serve). Remove is two-step (Remove, then Confirm right
 * next to it, never a dialog): the route answers a settings-managed or
 * auto-provisioned vault with 409 vault_protected and a shadowing clash with
 * 409 vault_conflict, and BOTH host messages render verbatim, because the
 * protected message names the actionable place to remove the vault.
 * @module dsh-plugin-obsidian-mem/client/sections/vaults
 */
import { addVault, addVaultPayload, errorText, removeVault, } from '../api.js';
import { truncate } from '../format.js';
import { renderButton, renderInput, renderSegmented, renderTag, } from '../primitives.js';
import { react } from '../react.js';
import { RowHint } from '../cardRoot.js';
import { ERROR_BANNER_STYLE, MONO_STYLE, ROW_STYLE, WARNING_BANNER_STYLE, } from '../styles.js';
const MODE_OPTIONS = [
    { value: 'shared', label: 'Adopt and Share' },
    { value: 'read-only', label: 'Read-only' },
];
// The source badge: where the registration came from. `default` marks the
// lazily provisioned default vault (removal refuses; the hint says so).
const SOURCE_TONES = {
    settings: 'neutral',
    card: 'info',
    default: 'quiet',
};
export function VaultsSection(props) {
    const [path, setPath] = react.useState('');
    const [mode, setMode] = react.useState('shared');
    const [globalFile, setGlobalFile] = react.useState('');
    const [busy, setBusy] = react.useState(false);
    const [error, setError] = react.useState(null);
    const [confirmPath, setConfirmPath] = react.useState(null);
    const submitAdd = () => {
        if (path.trim() === '') {
            return;
        }
        setBusy(true);
        setError(null);
        addVault(addVaultPayload(path, mode, globalFile)).then(() => {
            setBusy(false);
            setPath('');
            setGlobalFile('');
            props.refresh();
        }, (failure) => {
            setBusy(false);
            setError(errorText(failure));
        });
    };
    const submitRemove = (target) => {
        setBusy(true);
        setError(null);
        setConfirmPath(null);
        removeVault(target).then(() => {
            setBusy(false);
            props.refresh();
        }, (failure) => {
            setBusy(false);
            setError(errorText(failure));
        });
    };
    const vaults = props.status?.vaults ?? [];
    const defaultPath = props.status?.defaultVaultPath ?? null;
    const noticeActive = props.status?.noticeActive === true && props.status.notice !== null;
    return (react.createElement(react.Fragment, null,
        noticeActive && (react.createElement("div", { style: WARNING_BANNER_STYLE }, props.status.notice ?? '')),
        vaults.length === 0 && (react.createElement(RowHint, { text: defaultPath === null
                ? 'No vaults yet: the first memory use provisions a default vault automatically, then it appears here.'
                : `No vaults are registered yet. The plugin's default vault lives at ${defaultPath} and was provisioned automatically on first memory use.` })),
        react.createElement("div", { style: ROW_STYLE },
            renderInput({
                value: path,
                placeholder: 'Vault path, e.g. ~/Documents/MyVault',
                title: 'Absolute path, or ~/ for the home directory',
                wide: true,
                disabled: busy,
                onChange: (text) => setPath(text),
            }),
            renderInput({
                value: globalFile,
                placeholder: 'Global memory relative file path e.g. GLOBAL.md',
                title: 'Optional; relative to the vault root; blank defaults to GLOBAL.md',
                disabled: busy,
                onChange: (text) => setGlobalFile(text),
            }),
            renderSegmented({
                id: 'obsidian-mem-vault-mode',
                label: 'Vault mode',
                value: mode,
                options: MODE_OPTIONS,
                disabled: busy,
                onChange: setMode,
            }),
            renderButton({
                label: 'Add vault',
                variant: 'primary',
                busy,
                disabled: path.trim() === '',
                onClick: submitAdd,
            })),
        vaults.map((entry) => (react.createElement("div", { key: entry.path, style: ROW_STYLE },
            react.createElement("span", { style: MONO_STYLE, title: entry.path }, truncate(entry.path, 64)),
            renderTag(SOURCE_TONES[entry.source] ?? 'neutral', entry.source),
            renderTag('quiet', entry.mode),
            renderTag('quiet', entry.globalFile),
            confirmPath === entry.path ? (react.createElement(react.Fragment, null,
                renderButton({
                    label: 'Confirm remove',
                    variant: 'outline',
                    busy,
                    onClick: () => submitRemove(entry.path),
                }),
                renderButton({
                    label: 'Cancel',
                    onClick: () => setConfirmPath(null),
                }))) : (renderButton({
                label: 'Remove',
                disabled: busy,
                title: entry.source === 'card'
                    ? 'Remove this card-added vault'
                    : 'Only vaults added from this card are removable here',
                onClick: () => setConfirmPath(entry.path),
            }))))),
        error !== null && react.createElement("div", { style: ERROR_BANNER_STYLE }, error)));
}
//# sourceMappingURL=vaults.js.map
