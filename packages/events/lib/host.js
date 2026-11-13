/**
 * HostContract mirrors the exact live-agent shapes the lifecycle hooks
 * consume: `agent/created` / `agent/disposed` payloads, the `Agent` handle's
 * session header (cwd, subagent origin), `agent.inject()`, and the
 * UserMessage the injection channel accepts. Verified against the live
 * event catalog (cordis 4.1.0 + the harness agent/tool packages' `Events`
 * augmentations): `agent/created` is serial and a throwing listener fails
 * agent creation, `agent/disposed` is emit, `agent/pre-step` is a waterfall
 * whose decision a non-owning listener must pass through unchanged, and
 * `tools/result` observes the frozen final outcome of one tool call.
 *
 * This package never imports the harness agent/tool packages at runtime
 * (PLAN TASK-031 canon, mirrors tools/host.ts): the shapes are declared
 * here and read structurally. The `Events` augmentation below only types
 * `ctx.on()` registrations; the names and payloads are the host's.
 * @module dsh-plugin-obsidian-mem/events/host
 */
/**
 * MakeNoticeMessage builds one injectable UserMessage: notice-form source,
 * one text block per entry. Ids are caller-supplied randomness; the harness
 * treats MessageId as an opaque identity string.
 */
export function makeNoticeMessage(id, summary, blocks) {
    return {
        id,
        role: 'user',
        content: blocks.map((text) => ({ type: 'text', text })),
        source: { kind: 'plugin:obsidian-mem', form: 'notice', summary: boundSummary(summary) },
    };
}
/** NOTICE_SUMMARY_MAX_CHARS is the harness bound on one notice summary. */
export const NOTICE_SUMMARY_MAX_CHARS = 120;
/** BoundSummary clamps a notice summary to {@link NOTICE_SUMMARY_MAX_CHARS}. */
export function boundSummary(summary) {
    return summary.length <= NOTICE_SUMMARY_MAX_CHARS
        ? summary
        : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`;
}
/** FirstTextBlock returns the first non-empty text block of a message, or ''. */
export function firstTextBlock(message) {
    for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text.trim() !== '') {
            return block.text.trim();
        }
    }
    return '';
}
/** FirstUserText returns the text of the first user-sourced message, or ''. */
export function firstUserText(messages) {
    for (const message of messages) {
        if (message.source?.kind === 'user') {
            const text = firstTextBlock(message);
            if (text !== '') {
                return text;
            }
        }
    }
    return '';
}
//# sourceMappingURL=host.js.map
