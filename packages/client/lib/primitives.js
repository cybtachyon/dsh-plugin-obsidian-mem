/**
 * The guarded primitive renderers: every control the card draws resolves the
 * shell's @deepseek-ai/dsh-client-ui-primitives seed when the host provides
 * it and a native control otherwise. A missing seed is a fallback, not an
 * error (AGENTS.md "DSH UI Component Library"): each renderer guards with
 * `primitives && typeof primitives.X === 'function'`, so a host whose
 * platform module table predates the seed still renders the whole card.
 *
 * The seed is resolved once by the bootstrap (requireRuntimeModules in
 * plugin.ts via createCard) and handed in through setPrimitivesModule; the
 * native fallbacks style themselves on the same --dsw-* token families.
 * @module dsh-plugin-obsidian-mem/client/primitives
 */
import { react } from './react.js';
import { DISABLED_STYLE, NATIVE_BUTTON_STYLE, NATIVE_INPUT_STYLE, NATIVE_PRIMARY_BUTTON_STYLE, TAG_BASE_STYLE, TAG_TONE_STYLES, TOAST_STYLE, } from './styles.js';
// The seed the bootstrap resolved; null until setPrimitivesModule runs.
let primitivesRef = null;
/**
 * SetPrimitivesModule hands the bootstrap's resolved seed (or null) to the
 * renderers. createCard calls it once per mount.
 */
export function setPrimitivesModule(primitives) {
    primitivesRef = primitives;
}
/** GetPrimitivesModule returns the resolved seed, or null for the fallback. */
export function getPrimitivesModule() {
    return primitivesRef;
}
/**
 * RenderButton draws the DSH Button atom (the --dsw-alias-button-* token
 * families, size 'sm': the card is a 28px context) with the card's inline
 * button as the fallback a host without the seed keeps.
 */
export function renderButton(opts) {
    const disabled = opts.disabled === true || opts.busy === true;
    if (opts.busy === true) {
        return (react.createElement("button", { type: "button", disabled: true, style: { ...buttonStyle(opts.variant), ...DISABLED_STYLE } }, `${opts.label}\u2026`));
    }
    const primitives = getPrimitivesModule();
    if (primitives && typeof primitives.Button === 'function') {
        return react.createElement(primitives.Button, {
            variant: opts.variant ?? 'ghost',
            size: 'sm',
            type: 'button',
            disabled,
            ...(opts.title === undefined ? {} : { title: opts.title }),
            onClick: opts.onClick,
        }, opts.label);
    }
    return (react.createElement("button", { type: "button", style: buttonStyle(opts.variant), disabled: disabled, ...(opts.title === undefined ? {} : { title: opts.title }), onClick: opts.onClick }, opts.label));
}
function buttonStyle(variant) {
    return variant === 'primary' ? NATIVE_PRIMARY_BUTTON_STYLE : NATIVE_BUTTON_STYLE;
}
/**
 * RenderInput draws the DSH Input atom (a wrapper span over the native
 * input; text-entry attributes pass through) with the card's inline input as
 * the fallback. onChange receives the text, never the raw event.
 */
export function renderInput(opts) {
    const primitives = getPrimitivesModule();
    const common = {
        value: opts.value,
        type: opts.type ?? 'text',
        disabled: opts.disabled === true,
        onChange: (event) => opts.onChange(event.target.value),
        ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
        ...(opts.title === undefined ? {} : { title: opts.title }),
        ...(opts.id === undefined ? {} : { id: opts.id }),
    };
    if (primitives && typeof primitives.Input === 'function') {
        return react.createElement(primitives.Input, { ...common, style: opts.wide === true ? { width: '100%' } : undefined });
    }
    return (react.createElement("input", { ...common, style: { ...NATIVE_INPUT_STYLE, ...(opts.wide === true ? { width: '100%' } : {}) } }));
}
/**
 * RenderSegmented draws the DSH SegmentedControl (the tablist with one
 * indicator; the owner holds the selection) with a native <select> as the
 * fallback. It picks one mode among mutually exclusive options (audit view,
 * vault mode, plan preview state).
 */
export function renderSegmented(opts) {
    const primitives = getPrimitivesModule();
    if (primitives && typeof primitives.SegmentedControl === 'function') {
        return react.createElement(primitives.SegmentedControl, {
            id: opts.id,
            label: opts.label,
            value: opts.value,
            options: opts.options,
            disabled: opts.disabled === true,
            onChange: opts.onChange,
        });
    }
    return (react.createElement("select", { "aria-label": opts.label, value: opts.value, disabled: opts.disabled === true, style: NATIVE_INPUT_STYLE, onChange: (event) => opts.onChange(event.target.value) }, opts.options.map((option) => (react.createElement("option", { key: option.value, value: option.value }, option.label)))));
}
/**
 * RenderTag draws the DSH Tag atom (the read-only 11px capsule, `tone`
 * selects the palette) with the card's native tag as the fallback.
 */
export function renderTag(tone, text) {
    const primitives = getPrimitivesModule();
    if (primitives && typeof primitives.Tag === 'function') {
        return react.createElement(primitives.Tag, { tone }, text);
    }
    return (react.createElement("span", { style: { ...TAG_BASE_STYLE, ...TAG_TONE_STYLES[tone] } }, text));
}
/**
 * RenderStateDot draws the DSH StateDot (green done / amber warning / red
 * error / spinner ongoing / neutral idle; aria-hidden, the row names it) with
 * the card's colored glyph as the fallback.
 */
export function renderStateDot(state) {
    const primitives = getPrimitivesModule();
    if (primitives && typeof primitives.StateDot === 'function') {
        return react.createElement(primitives.StateDot, { state });
    }
    const glyph = {
        done: '\u2713',
        warning: '\u25CB',
        error: '\u2717',
        ongoing: '\u2026',
        idle: '\u25CB',
    };
    const color = {
        done: 'var(--dsw-alias-label-success, #34c38f)',
        warning: 'var(--dsw-alias-label-warning, #ff9f0a)',
        error: 'var(--dsw-alias-label-error, #ff3b30)',
        ongoing: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
        idle: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
    };
    return (react.createElement("span", { "aria-hidden": "true", style: { color: color[state], width: 12, flex: 'none' } }, glyph[state]));
}
/**
 * RenderToast draws the DSH Toast (the transient top-center banner that
 * holds, fades, and calls onDone) with the card's fixed banner as the
 * fallback. The owner keeps the mount (and the unmount timer); onDone lets
 * the seed end the same state change.
 */
export function renderToast(text, onDone) {
    const primitives = getPrimitivesModule();
    if (primitives && typeof primitives.Toast === 'function') {
        return react.createElement(primitives.Toast, { text, tone: 'success', onDone });
    }
    return (react.createElement("div", { role: "status", style: TOAST_STYLE },
        text,
        react.createElement("button", { type: "button", "aria-label": "Dismiss", style: { ...NATIVE_BUTTON_STYLE, height: 20, marginLeft: 8, padding: '0 6px' }, onClick: onDone }, '\u2715')));
}
//# sourceMappingURL=primitives.js.map
