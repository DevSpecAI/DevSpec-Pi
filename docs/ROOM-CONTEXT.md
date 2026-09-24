# Local room context

Implementation: `829394e9`; native readers/delivery cutover: `2cc40e56`.

## Boundaries

- This is a read model, never an execution queue. Current commands, interaction claims and speech stay on their existing mechanical paths. No authority, capability, claim token, execution receipt or hydrated attachment URL is loaded from this store.
- A session activity inventory is discovery only: kind, ID and produced/referenced relation, with observation/availability/truncation metadata. It contains no cached lifecycle, supersession, title, creator or body. Current facts come from the native live record getters. Room events do not invalidate every external record, so an inventory timestamp cannot certify their freshness.
- Other room projections are explicitly **last observed snapshots**, not promises that a disconnected copy is current. Absent, unavailable and available-empty are different. A failed read never stamps successful observation or clears an earlier list as if it were empty.

## Storage choice and safety

Use the host Node runtime's SQLite implementation, not a new service or a hand-written multi-file transaction log. The current stock Pi requires Node >=22.19. On older runtimes without `node:sqlite`, keep existing command/online-tool behavior and explicitly report local history unavailable; do not opt into room ingress or silently substitute an in-memory store.

SQLite commits message updates, tombstones, projection snapshots and recovery checkpoints in ONE transaction. The store uses rollback journaling, FULL synchronous durability and secure deletion; it does not retain historical text versions. Files live below Pi's private DevSpec directory, outside the repository. Directories are 0700 and database files 0600 on POSIX; Windows uses the user's private profile/ACLs. Refuse symlinked cache paths rather than following a repository-supplied path.

Namespaces include the endpoint, server-bound project, native Pi session, connection and server attachment epoch. A connection's owner is immutable, so authenticated connection identity also fences principals. Opaque cursor values are data, not credentials or command authority. No token/capability is used as a directory name or persisted. A private one-way credential fingerprint permits a later offline reader to select only the same previously authenticated credential's snapshot; it is never returned to the model or accepted as server authority. Credential rotation requires fresh online validation before that snapshot is associated with the new credential.

Each runtime store handle has an in-memory generation fence. Delayed reads from a previous attachment cannot write the replacement store. Explicit detach, server refusal or local stop invalidates access immediately and removes that attachment's cache; OS cleanup failure is reported without preventing shutdown. Process exit/reload retains a recoverable checkpoint. Offline reads must declare stale/partial status and last-known access, and no cached attachment reference bypasses a live permission check. Retention is whole-current-snapshot only (no append-only raw payload archive). On reuse of a native-session namespace, abandoned attachment copies older than30 days without contact are removed; other agents' namespaces are not swept. No age-based truncation of the currently attached room's message set.

## Synchronization

The normal pump may negotiate1.6 only with a working store and the complete prerequisite lane. Older lanes retain their behavior. Every valid1.6 page is stored independently of model wake/delivery. Main command cursors are NEVER restored from the room cache.

Older backfill uses only the existing poll's explicit older-page cursor. A read-only repair can request `catch_up` only with a known live cursor, making it an inactive history lane. It must never enqueue commands, claim notices/questions, apply controls or change the live command cursor. Bound background requests (at most12 recovery reads/minute) and use the existing shared cooldown. Recovery never gates foreground command admission or restores its cursor.

Coverage is checked at the server's fixed order point over unique IDs, not against a moving room total. Keep the older-history frontier independently from live continuation. Incomplete backfill is expected, not corruption. Persist unfinished deletion pagination (`seen.total=null`) and relist intent; acknowledge no complete deletion scan until the local tombstone set accounts for it. Known tombstones dominate late pages/checks and erase cached text/attachments. Newer final rows cannot return to in-progress.

On reload, authenticate the current attachment before reusing its exact namespace. Resume the saved older-history frontier; fill any newer gap independently. A missing/failed coverage read makes no completeness claim. A storage failure rolls back the page/checkpoint together, marks local context unavailable/behind, and does not prevent a valid foreground command.

## Native reading and delivery

`read_room_context` is one small native hot tool, independent of the MCP wire catalogue. The complete online transcript tool stays immediately available alongside it, as do the current action-item/memory/resource getters. Useful access is not removed merely to fit a numeric prompt target. It offers status, newest-first history, stable message anchors, literal search, since-checkpoint navigation and observed room-state reads. It performs no network requests. History pages and search-result windows return bounded previews with continuation; literal search applies across the cache before limiting matching results, so finding an old message does not require model-driven scanning; exact message/state reads return complete JSON or lossless bounded JSON fragments. Changed fragment sources and foreign-scope cursors require an explicit restart, not silent joining of different versions.

Every result is labelled a local snapshot, with observation time and fixed-cutoff coverage. An index is not live entity state. Use the existing live record getters for current facts and deliberate resource retrieval. Offline selection uses the current credential fingerprint and this native conversation's last-known attachment; explicit denial/detach suppresses selection. Scope markers are non-context Pi custom entries and never restore execution authority.

When the current page is safely stored and the reader is available, ordinary command delivery omits bulky advisory history and adds a compact snapshot notice at the current delivery tail. Full current command text, exact requester/authority/scope, style and direct-command attachment handling remain unchanged. If storage/reader readiness is missing, retain the supported delivery fallback. Question/control/notice protocols stay separate; room changes alone do not start model turns. Checkpoints are navigation, never a claim that the model read those messages.

## Quality before numeric targets

Ali's2026-09-24 clarification: prioritize useful instructions, complete access and real results over the former8k prompt ceiling. The larger prefix alarm catches accidental catalogue/contract dumps, not necessary growth. Bounded local pages remain lossless through explicit continuation; they do not ration the available history. Focused correctness checks are the shipping gate. Comparable provider measurements are needed before making savings claims, not as a reason to postpone a safe release indefinitely.

## Verification

Run one test file at a time on the shared machine. Exercise real SQLite transactions and reopen the database at injected crash boundaries; >60 history, >500 live rows/tombstones, late deletion, restart during paging, stale final/partial replies, concurrent scope changes, unavailable/empty snapshots, privacy and denied access. Pair parser fixtures with the current server producer/schema. Use a disposable room/host for live qualification, never fault-inject Ali's working room. Treat runtime activation separately from an on-disk update.
