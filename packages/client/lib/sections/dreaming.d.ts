/**
 * The Dreaming section: the dream orchestrator (last run, editable prompt
 * path, plan preview, run-now launch), and the DSH schedule triggers the
 * plugin's dreaming wake-ins ride (live entries, the read-only config echo,
 * and the add/remove forms).
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
import type { ReactNode } from 'react';
import { type StatusPayload } from '../api.js';
/** How long the accepted-run toast stays up. */
export declare const TOAST_HOLD_MS = 4000;
export interface DreamingSectionProps {
    status: StatusPayload | null;
    refresh: () => void;
}
export declare function DreamingSection(props: DreamingSectionProps): ReactNode;
/**
 * ValidateScheduleForm checks the add form the way the route does, before
 * the round trip: a label, exactly one timing (cron XOR interval), an
 * interval of at least 60 whole seconds, and a named wake session. Returns
 * the message to show, or null when the form is submittable.
 */
export declare function validateScheduleForm(form: {
    label: string;
    expression: string;
    everySeconds: string;
    sessionId: string;
}): string | null;
//# sourceMappingURL=dreaming.d.ts.map
