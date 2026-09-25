# Background-work observation

Implementation item: `db495c8f-8ebc-415c-a879-d93c28ede5e7`. This is the observation foundation for the foreground/Working separation in `f2e77e2d`, not a task manager or a second execution queue.

## Provider boundary

Use pi-background-tasks' documented EventBus v1 `capabilities`, `status` and terminal-event interfaces. Keep the existing pi-subagents public fleet adapter separate. Do not import provider implementation classes, inspect child files, infer task ownership from process names, or use model-facing notifications as task state.

A successful known launch result proves which task this native session launched. Capture its DevSpec connection, room and attachment epoch **at launch**, not when a delayed result arrives. The provider task ID and `startTime` identify the execution. Notification/wake flags do not change ownership or liveness. A status lookup cannot adopt a task that was never owned.

The observer retains only `id`, `startTime` and a closed state (`running`, `unknown`, `completed`, `failed`, `killed`). Commands, output paths, names, errors, credentials and provider payloads are not retained or journalled. Snapshots are copies. Callback failures cannot break provider terminal publication.

Terminal events are idempotent and can arrive before the launch tool result. A bounded early-terminal buffer bridges that race without adopting foreign work. Eviction from this buffer is not completion: subsequent status reconciliation establishes the truth. A delayed running observation cannot resurrect terminal work.

## Reconciliation and unknown state

The host invokes bounded refresh at existing settlement/safety boundaries. There is no second hot polling loop and no model wake merely to inspect task state. Each pass checks a bounded fair subset of owned unresolved IDs with capped concurrent in-process requests. Concurrent refresh callers share work. Provider absence, timeout, malformed/missing data and identity mismatch resolve nothing; the task becomes explicitly unknown. A later successful provider observation can recover it.

The observation adapter does not decide Working, cancel anything, send remote messages or complete server attempts. The host integration owns those effects and must independently fence foreground/attachment changes.

## Reload and scope

Persist minimal observations using non-context Pi session entries (`devspec-background-observation`). Restore only the current native session's active branch and exact connection/room/attachment scope. Previously running work restores as unknown until the provider confirms it; terminal observations remain terminal despite late/duplicate running rows.

A true attachment/session change cancels pending observations and clears its early-event buffer. A stale response cannot mutate the new scope. Do not automatically adopt a provider's complete inventory or infer ownership from task-file paths. This does not retroactively manufacture ownership records for old plugin versions or promise survival of jobs the provider cannot restore.

## Host integration safety

Preserve strict existing `bg_kill`/`bg_status` terminal-result reconciliation and the subagent fleet adapter. Notification text is communication, not a new source of terminal authority.

A callback removing the last task must not call a connection-scoped completion that selects whatever happens to be newest. It needs a captured exact execution/command identity plus native-foreground, pending-input, revision and attachment guards. Existing `report_complete` command identity resolves an exact source-bound attempt and the server excludes newer follow-ups. The generic unbound path, however, resolves the latest unbound attempt at request time; it is not an immutable reference captured at settlement. Do not use that path as an asynchronous idle-drain shortcut.

Local segments now allocate a distinct attempt UUID before model/tool execution and obtain a capability/attachment-bound receipt through `report_pickup(local_activity_version: 1)`. The server checks the expected previous attempt under its connection lock; a stale start cannot replace a newer run, even if that newer run already completed. A still-current client may retry a predecessor mismatch once with the same new UUID. Admission failure or an unknown receipt grants no completion identity and never blocks ordinary v2 speech. No pickup occurs at settlement. The last-job callback uses only the acknowledged UUID with the existing `report_complete(attempt_id)` path.

This requires the matching server endpoint. It does not implement independent background Working/foreground admission, repair active-question withholding, or restore an in-flight completion receipt after reload. Those remain separate work; restoring provider observations alone is not proof of restored execution authority.

No speech is re-posted or held while observations run. Final status must remain honest when an exact completion receipt is unavailable; a successful transport response alone is not proof of completion.

## Checks

The observer tests cover notification-independent ownership, unknown provider state, terminal-before-receipt, duplicate terminal delivery, bounded fair reconciliation, stale running responses, cross-scope callbacks, disposal and metadata privacy. Journal tests cover active-scope restoration, terminal monotonicity and invalid/extra fields. Actual runtime integration additionally needs harmless provider jobs and controlled interruption, no-notice/non-waking cases, idle drain and a newer foreground race. Source-only checks do not qualify those outcomes.

`node scripts/e2e-background-observer.mjs` runs actual Pi RPC with a scripted provider and loopback DevSpec transport. Set `PI_BACKGROUND_EXTENSION` to the installed public provider entrypoint. Add `--local`, `--foreground-race`, or `--completion-race` (a local completion held in flight across a newer start). The separate `e2e-background-observer-live.mjs` is staging-only and requires an explicit disposable room; it does not manufacture browser verification.
