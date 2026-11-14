# TASK-009-audit-tool-checkpoint

`memory_audit` tool face (`packages/tools/src/audit.ts`): expose the
checkpoint view and the churn/git rollups, and append the prepared
completion-checkpoint instructions.

Skill: load `agent-experience` before editing the tool description,
parameter schema, or output schema; keep the model-facing text
discoverable and token-lean.

Prepared contract (source of truth, unmodified):
`AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT` in the same file carries a
`{{FIRST_SHARED_VAULT}}` hole. The system prompt (already prepared,
`MEMORY_PROMPT_SECTION_TEXT`) tells the agent to run
`memory_audit` with `"checkpoint"` as the view at the end of real work.

Changes:
1. Parameters: the `view` enum flows from `AUDIT_VIEWS` (TASK-008 adds
   `checkpoint`); rewrite its description to name `checkpoint`: "same note
   rows as 'full', then the completion-checkpoint instructions for the
   agent". Keep `limit` as is.
2. Description (`AUDIT_DESCRIPTION`): one clause naming the checkpoint
   view's follow-on instructions and the per-note churn fraction + git
   rollups now in the report. Do not restate the whole schema.
3. Value + schema: rows gain `churn` (number, 0..1); `stats` gains the
   `git` array from TASK-008 (snake_case mapping like its siblings:
   `initialized`, `clean`, `head_hash`, `error` with honest nulls).
4. Interpolation: `{{FIRST_SHARED_VAULT}}` is the first shared vault's
   path from `service.listVaults()` (mode === 'shared'), falling back to
   `defaultVaultPath(homedir())` exactly like the removed
   `turnEndReminder` did; put the one shared-vault-pick helper somewhere
   shared if TASK-010 has already removed the events copy (dependency
   order keeps events removal after this task; until then a local pure
   function here is acceptable but name it like the events one).
5. `renderAudit`: when `value.view === 'checkpoint'`, append after the
   note rows the interpolated `AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT`
   under a blank line. Row lines gain `, churn <pct>%` only when
   `churn > 0` (token discipline: silence for the common untouched note).
   Add one `Git (vault): <clean|dirty|unavailable> [head <hash7>]` line
   per stats.git entry only when the git array is non-empty.
6. `AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT` itself stays byte-identical
   (it is the user's prepared prompt; a spec pins it verbatim).

Tests (`packages/tools/tests/audit.spec.ts`): checkpoint render carries
the vault-interpolated text and the note rows identical to a full-view
render; no `{{FIRST_SHARED_VAULT}}` survives; churn render on/off; git
line; enum flows AUDIT_VIEWS.

Definition of Done: build + tools suite green; src+lib committed
together.
