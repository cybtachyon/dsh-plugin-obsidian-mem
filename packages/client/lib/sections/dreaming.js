/**
 * The Dreaming section: the dream orchestrator (last run, editable prompt
 * path, plan preview, run-now launch), and the DSH schedule triggers the
 * plugin's dreaming wake-ins ride (live entries, the read-only config echo,
 * and the add/remove forms). A failed recorded run (status dream.lastRun,
 * trustworthy since TASK-003) surfaces here as a warning banner naming the
 * error and the finished date; a successful run adds nothing to the card.
 *
 * Runs are single-flight host-side: run-now fires POST /dream/run and the
 * route answers 202 { started, id } without awaiting, so the card reports
 * acceptance in a toast and the polled status carries progress; a run
 * already in flight answers 409 dream_busy and its message renders verbatim.
 * Schedules go through the host schedule service (503 schedule_unavailable
 * hides the forms with the host's message); the row-configured definitions
 * echo read-only because applying them is a profile-config action.
 * @module dsh-plugin-obsidian-mem/client/sections/dreaming
 */
import { deleteSchedule, ERROR_CODES, errorText, fetchDreamPlan, fetchDreamState, fetchSchedules, isApiError, runDream, upsertSchedule, } from '../api.js';
import { formatAge, formatLocalDate, slugId, truncate } from '../format.js';
import { renderButton, renderInput, renderTag, } from '../primitives.js';
import { react } from '../react.js';
import { RowHint } from '../cardRoot.js';
import { useToast } from '../toast.js';
import { ERROR_BANNER_STYLE, HINT_STYLE, KEY_STYLE, MONO_STYLE, PRE_STYLE, ROW_STYLE, WARNING_BANNER_STYLE, } from '../styles.js';
/** The plan text preview cap (the full plan lives on the host side). */
const PLAN_PREVIEW_CHARS = 2_000;
/**
 * LastRunFailureText turns the orchestrator's last recorded run into the
 * warning banner copy: `null` (render nothing) when there is no run yet or
 * the run succeeded; otherwise the failed-run line naming the error (the
 * summary already prefixes it, so prefer the raw error) with the local date
 * the run finished. A successful run stays covered by the Last dream row.
 */
export function lastRunFailureText(lastRun) {
    if (lastRun === null || lastRun.ok) {
        return null;
    }
    const detail = lastRun.error ?? lastRun.summary;
    return `Last dream run failed (${formatLocalDate(lastRun.finishedAt)}): ${detail}`;
}
export function DreamingSection(props) {
    const [promptPath, setPromptPath] = react.useState(null);
    const [plan, setPlan] = react.useState(null);
    const [planNote, setPlanNote] = react.useState(null);
    const [busyPlan, setBusyPlan] = react.useState(false);
    const [busyRun, setBusyRun] = react.useState(false);
    const [runError, setRunError] = react.useState(null);
    const toast = useToast();
    const [schedules, setSchedules] = react.useState(null);
    const [scheduleError, setScheduleError] = react.useState(null);
    react.useEffect(() => {
        let cancelled = false;
        fetchDreamState().then((payload) => {
            if (!cancelled) {
                setPromptPath(payload.promptPath);
            }
        }, () => {
            // A dead dream-state read only hides the prompt path; the rest of
            // the section still works from the polled status.
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const reloadSchedules = () => {
        fetchSchedules().then((payload) => {
            setSchedules(payload);
            setScheduleError(null);
        }, (failure) => {
            setScheduleError(isApiError(failure) && failure.code === ERROR_CODES.scheduleUnavailable
                ? failure.message
                : errorText(failure));
        });
    };
    react.useEffect(() => {
        reloadSchedules();
        // One read per mount; every mutation calls reloadSchedules itself, so
        // the effect deliberately runs once.
    }, []);
    const showPlan = () => {
        setBusyPlan(true);
        setPlanNote(null);
        fetchDreamPlan().then((payload) => {
            setBusyPlan(false);
            setPlan(payload.plan);
        }, (failure) => {
            setBusyPlan(false);
            setPlan(null);
            setPlanNote(errorText(failure));
        });
    };
    const launchRun = () => {
        setBusyRun(true);
        setRunError(null);
        runDream().then((accepted) => {
            setBusyRun(false);
            toast.show(`Dream run ${accepted.id} accepted; it continues in the background.`);
            props.refresh();
        }, (failure) => {
            setBusyRun(false);
            // 409 dream_busy and 503 dream_unavailable messages read verbatim.
            setRunError(errorText(failure));
            props.refresh();
        });
    };
    const status = props.status;
    const dream = status?.dream ?? null;
    const blocked = dream?.blocked ?? null;
    const running = dream?.state === 'running';
    const lastDreamAt = dream?.lastDreamAt ?? null;
    const failedRun = lastRunFailureText(dream?.lastRun ?? null);
    return (react.createElement(react.Fragment, null,
        toast.node,
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Last dream"),
            react.createElement("span", null, formatAge(lastDreamAt, Date.now())),
            running && renderTag('info', 'run in flight'),
            promptPath !== null && (react.createElement(react.Fragment, null,
                react.createElement("span", { style: KEY_STYLE }, "Prompt"),
                react.createElement("span", { style: MONO_STYLE, title: promptPath }, truncate(promptPath, 56))))),
        blocked !== null && (react.createElement("div", { style: WARNING_BANNER_STYLE }, `Dreaming cannot launch: ${blocked}`)),
        failedRun !== null && react.createElement("div", { style: WARNING_BANNER_STYLE }, failedRun),
        react.createElement("div", { style: ROW_STYLE },
            renderButton({
                label: 'Preview plan',
                busy: busyPlan,
                disabled: blocked !== null,
                title: blocked !== null ? 'No agents gateway: the run this plan drives cannot launch' : undefined,
                onClick: showPlan,
            }),
            renderButton({
                label: 'Run now',
                variant: 'primary',
                busy: busyRun,
                disabled: blocked !== null || running,
                title: running ? 'A dream run is already in flight' : undefined,
                onClick: launchRun,
            })),
        runError !== null && react.createElement("div", { style: ERROR_BANNER_STYLE }, runError),
        planNote !== null && react.createElement(RowHint, { text: planNote }),
        plan !== null && (react.createElement(react.Fragment, null,
            react.createElement(RowHint, { text: `${String(plan.candidates.length)} candidate notes, ${String(plan.clusters.length)} clusters, `
                    + `${String(plan.stats.notes)} notes scanned${plan.skipped.length > 0 ? `; skipped: ${plan.skipped.join(', ')}` : ''}.` }),
            react.createElement("pre", { style: PRE_STYLE }, truncate(plan.plan, PLAN_PREVIEW_CHARS)))),
        react.createElement(SchedulePanel, { schedules: schedules, disabledReason: scheduleError, onChanged: reloadSchedules, refresh: props.refresh })));
}
// Live triggers, the read-only config echo, and the add form. The add body
// names a target sessionId (a browser caller has none of its own, so the
// route requires the body to name one; the field pre-fills from a live
// entry). Add is an upsert by ownership title: re-adding a label replaces
// its trigger (the route's documented replace behavior).
function SchedulePanel(props) {
    const [label, setLabel] = react.useState('');
    const [expression, setExpression] = react.useState('');
    const [everySeconds, setEverySeconds] = react.useState('');
    const [timeZone, setTimeZone] = react.useState('');
    const [sessionId, setSessionId] = react.useState('');
    const [busy, setBusy] = react.useState(false);
    const [formError, setFormError] = react.useState(null);
    const [confirmId, setConfirmId] = react.useState(null);
    const entries = props.schedules?.entries ?? [];
    const configured = props.schedules?.configured ?? [];
    const unavailable = props.disabledReason !== null;
    const effectiveSessionId = sessionId !== '' ? sessionId : (entries[0]?.sessionId ?? '');
    const submit = () => {
        const trimmedLabel = label.trim();
        const trimmedExpression = expression.trim();
        const trimmedEvery = everySeconds.trim();
        const problem = validateScheduleForm({
            label: trimmedLabel,
            expression: trimmedExpression,
            everySeconds: trimmedEvery,
            sessionId: effectiveSessionId,
        });
        if (problem !== null) {
            setFormError(problem);
            return;
        }
        setFormError(null);
        setBusy(true);
        upsertSchedule({
            id: slugId(trimmedLabel),
            label: trimmedLabel,
            sessionId: effectiveSessionId,
            ...(trimmedExpression === ''
                ? { everySeconds: Number.parseInt(trimmedEvery, 10) }
                : {
                    expression: trimmedExpression,
                    ...(timeZone.trim() === '' ? {} : { timeZone: timeZone.trim() }),
                }),
        }).then(() => {
            setBusy(false);
            setLabel('');
            setExpression('');
            setEverySeconds('');
            setTimeZone('');
            props.onChanged();
            props.refresh();
        }, (failure) => {
            setBusy(false);
            setFormError(errorText(failure));
        });
    };
    const remove = (id) => {
        setBusy(true);
        setFormError(null);
        setConfirmId(null);
        deleteSchedule(id).then(() => {
            setBusy(false);
            props.onChanged();
        }, (failure) => {
            setBusy(false);
            setFormError(errorText(failure));
        });
    };
    return (react.createElement(react.Fragment, null,
        react.createElement("div", { style: ROW_STYLE },
            react.createElement("span", { style: KEY_STYLE }, "Dreaming triggers"),
            entries.length === 0 && !unavailable && renderTag('quiet', 'none live')),
        unavailable && react.createElement(RowHint, { text: props.disabledReason ?? '' }),
        entries.map((entry) => (react.createElement(ScheduleRow, { key: entry.id, entry: entry, busy: busy, confirm: confirmId === entry.pluginId, onConfirm: () => setConfirmId(entry.pluginId), onCancel: () => setConfirmId(null), onRemove: () => remove(entry.pluginId) }))),
        configured.map((schedule) => (react.createElement("div", { key: `config-${schedule.id}`, style: ROW_STYLE },
            react.createElement("span", { style: MONO_STYLE }, schedule.label),
            renderTag('neutral', 'in config'),
            react.createElement("span", { style: HINT_STYLE }, schedule.expression ?? (schedule.everySeconds === undefined
                ? ''
                : `every ${String(schedule.everySeconds)} s`))))),
        !unavailable && (react.createElement(react.Fragment, null,
            react.createElement("div", { style: ROW_STYLE },
                renderInput({
                    value: label,
                    placeholder: 'Trigger label, e.g. nightly tidy',
                    title: 'Names the trigger; also the wake instruction',
                    wide: true,
                    disabled: busy,
                    onChange: setLabel,
                }),
                renderInput({
                    value: expression,
                    placeholder: 'cron, e.g. 0 3 * * *',
                    title: 'cron expression (evaluate in the zone below); leave empty for a fixed interval',
                    disabled: busy,
                    onChange: setExpression,
                }),
                renderInput({
                    value: everySeconds,
                    placeholder: 'every s, e.g. 86400',
                    title: 'fixed interval, at least 60 seconds; mutually exclusive with cron',
                    type: 'number',
                    disabled: busy,
                    onChange: setEverySeconds,
                })),
            react.createElement("div", { style: ROW_STYLE },
                renderInput({
                    value: timeZone,
                    placeholder: 'time zone, default UTC',
                    title: 'IANA zone for the cron expression (intervals ignore it)',
                    disabled: busy,
                    onChange: setTimeZone,
                }),
                renderInput({
                    value: effectiveSessionId,
                    placeholder: 'wake session id',
                    title: 'The session the trigger wakes; pre-filled from a live trigger',
                    disabled: busy,
                    onChange: setSessionId,
                }),
                renderButton({
                    label: 'Add trigger',
                    variant: 'primary',
                    busy,
                    disabled: label.trim() === '',
                    title: 'Re-adding a label replaces that trigger',
                    onClick: submit,
                })),
            formError !== null && react.createElement("div", { style: ERROR_BANNER_STYLE }, formError),
            react.createElement(RowHint, { text: "You can also ask the agent in any session to schedule automated dreaming for you." })))));
}
function ScheduleRow(props) {
    const entry = props.entry;
    return (react.createElement("div", { style: ROW_STYLE },
        react.createElement("span", { style: MONO_STYLE, title: entry.title }, entry.pluginId),
        renderTag('quiet', entry.kind),
        react.createElement("span", { style: HINT_STYLE }, entry.scheduledAt),
        entry.status === undefined
            ? null
            : renderTag(entry.status === 'active' ? 'success' : 'neutral', entry.status),
        props.confirm ? (react.createElement(react.Fragment, null,
            renderButton({ label: 'Confirm delete', variant: 'outline', busy: props.busy, onClick: props.onRemove }),
            renderButton({ label: 'Cancel', onClick: props.onCancel }))) : (renderButton({ label: 'Delete', disabled: props.busy, onClick: props.onConfirm }))));
}
/**
 * ValidateScheduleForm checks the add form the way the route does, before
 * the round trip: a label, exactly one timing (cron XOR interval), an
 * interval of at least 60 whole seconds, and a named wake session. Returns
 * the message to show, or null when the form is submittable.
 */
export function validateScheduleForm(form) {
    if (form.label === '') {
        return 'Give the trigger a label.';
    }
    if ((form.expression === '') === (form.everySeconds === '')) {
        return 'Give exactly one timing: a cron expression or a fixed interval in seconds.';
    }
    if (form.expression === '') {
        const seconds = Number.parseInt(form.everySeconds, 10);
        if (!Number.isSafeInteger(seconds) || seconds < 60) {
            return 'The fixed interval must be a whole number of seconds, at least 60.';
        }
    }
    if (form.sessionId === '') {
        return 'Name the session this trigger should wake (the schedule service needs one).';
    }
    return null;
}
//# sourceMappingURL=dreaming.js.map
