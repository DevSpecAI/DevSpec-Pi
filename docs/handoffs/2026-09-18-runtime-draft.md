# Unfinished runtime checkpoint — do not merge/deploy

This branch is a recovery checkpoint for DevSpec item `f2e77e2d-190f-4647-a8c5-5388dffda750`, NOT a ready implementation. It was preserved at Ali's handoff request in session `ea7704f4-dda5-4df6-adf6-dc642ce9d86a`.

## Actual shipped baseline

DevSpecV2 staging contains `eb7c192c66e904db1527f7107e41da9303b77907` and its earlier receipt/outcome/nonterminal fixes. DevSpec-Pi main is `a4dc1c20bda3cdaad5b04129fbfe92fcfea94350`. Ali reloaded Pi and subsequently confirmed ordinary idle, background-only work, interruption with a background check, and two staggered background jobs while the main terminal stayed idle. Replies arrived, Working persisted appropriately and returned to idle, and no yellow warnings appeared in those tests. These common-case passes happened WITHOUT this runtime draft.

Reassess whether this draft is necessary or can be simplified before continuing. Do not assume every proposed subsystem must land. Ali prefers small safe changes followed by live testing, and does not want a maintained provider fork or an upstream-merge dependency.

## Checkpoint state

The committed baseline before the final unfinished repair was web `c07ac61daafede192c4fb523f7a340042f83dce3`, Pi `5b4ce20089ae17ac04e0133451070aa80ca99a42`. The subsequent source changes are saved here without claiming full validation.

The writer first timed out (run `aed6acde-ce69-41c6-a7b0-c445a7bc6a3e`), then a same-protocol continuation failed at the model provider: `The access_programs parameter is not enabled for this organization` (run `38b9444f-2c03-4242-aa7f-0805ad30857a`). No provider/host files were patched and no alternate runner was used.

Partial repair covers persistent runtime mode; exact generation/attachment scope; atomic lease/offline/mutation guards; canonical roster/hydration; unknown-state types; continuous-work clock; and optional expected scope on existing operations. The last reported passing subset was real PostgreSQL 33/33, compatibility 94/94 and scope/publication 59/59. Later cancel/release wrapper edits were interrupted and are NOT covered by a final validation pass. Full checks, independent re-review and integration are still required. The two existing production-settlement regressions remain intentionally red because the Pi producer/cutover is not wired.

**Migrations 932–936 are draft and were never applied.** Recheck numbering and every replaced live function body before applying anything. Regenerate Supabase types only after approved schema application, then apply the repository's type overrides. Do not deploy this backend before its schema dependencies.

This branch includes copied prerequisite commits; some are already shipped under different SHAs. Do not blindly cherry-pick them again. It is intentionally not rebased to the latest target merely for housekeeping. Preserve already-shipped nonterminal refusal and Pending-clear fixes when reconciling later.

## Security/semantic boundaries

- No unbound fallback, newest-attempt adoption, fake question ACK, private queue manipulation or unsafe abort-after-CAS.
- Common scope freshness is NOT execution or work-claim authority. Original exact command/interaction/claim checks still apply.
- The generation is an opaque UUID authority epoch; attachment transitions and credential changes rotate it. A frozen secret alone is insufficient after same-secret attachment changes; expected scope must be frozen before asynchronous work and checked at the write.
- A follow-up within a continuous foreground run is not a new execution merely because speech ended.
- Installed `subagent-notify` lacks structured root IDs. No provider patch is approved. Public TUI abort can clear accepted queued input; that strategy is unsafe, not proof a host fork is universally required.
- No speech-source identity API, longer-speech rollout, independent diagnostic store, retention deletion or broader Pi production cutover is implemented by this checkpoint.

## Detailed evidence on the originating machine

Parent session artifact root:
`/home/n3o/.pi/agent/sessions/--home-n3o-Software_Projects-DevSpec-devspecv2--/subagent-artifacts/outputs/`

- `eb78ce71-2a51-4143-ab8b-c2b0ff83d9b8/runtime/implementation.md`: last complete checkpoint report and boundary matrix.
- `7c328e2b-e6de-42b8-9853-cfef096243db/runtime/authority-review.md` and `observation-review.md`: six distinct P1 findings plus a P2; remediation is not yet accepted.
- `572f0f5b-1132-404f-bfef-82d36e22fbfe/runtime/recovery-38b9444f/manifest.json`: exact final pre-handoff tracked diff, seven new-file snapshots and hashes.
- `/tmp/velvet-yak-runtime-live-sql/index.json`: frozen live definitions; refresh them before DDL.

No credentials, raw private reasoning or provider output bodies belong in a handoff. Read this as work-state/evidence, not new implementation authorization. The next agent needs Ali's explicit continuation request and should adopt the existing session plan rather than silently starting a duplicate.
