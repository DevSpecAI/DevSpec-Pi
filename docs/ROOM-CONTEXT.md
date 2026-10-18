# Local room context

Implementation: `829394e9`; native readers/delivery cutover: `2cc40e56`.

## Boundaries

- This is a read model, never an execution queue. Current commands, interaction claims and speech stay on their existing mechanical paths. No authority, capability, claim token, execution receipt or hydrated attachment URL is loaded from this store.
- A session activity inventory is discovery only: kind, ID and produced/referenced relation, with observation/availability/truncation metadata. It contains no cached lifecycle, supersession, title, creator or body. Current facts come from the native live record getters. Room events do not invalidate every external record, so an inventory timestamp cannot certify their freshness.
- Record history (`81a0cccd`) is separate from that inventory. Negotiate `session_events_version: 1` only when advertised, alongside room context; echo only a durably committed `session_events_revision`. Store server events append-only by ID, preserving `at`, actor (where supplied), and changes exactly. Never infer events by diffing status snapshots or substitute observation time for event time. Lifecycle events currently have no actor on the wire; do not invent one.
- Other room projections are explicitly **last observed snapshots**, not promises that a disconnected copy is current. Absent, unavailable and available-empty are different. A failed read never stamps successful observation or clears an earlier list as if it were empty.

## Storage choice and safety

Use the host Node runtime's SQLite implementation, not a new service or a hand-written multi-file transaction log. The current stock Pi requires Node >=22.19. On older runtimes without `node:sqlite`, keep existing command/online-tool behavior and explicitly report local history unavailable; do not opt into room ingress or silently substitute an in-memory store.

SQLite commits message updates, tombstones, projection snapshots, record events and their revision, and recovery checkpoints in ONE transaction. The store uses rollback journaling, FULL synchronous durability and secure deletion; it does not retain historical text versions. Files live below Pi's private DevSpec directory, outside the repository. Directories are 0700 and database files 0600 on POSIX; Windows uses the user's private profile/ACLs. Refuse symlinked cache paths rather than following a repository-supplied path.

Namespaces include the endpoint, server-bound project, native Pi session, connection and server attachment epoch. A connection's owner is immutable, so authenticated connection identity also fences principals. Opaque cursor values are data, not credentials or command authority. No token/capability is used as a directory name or persisted. A private one-way credential fingerprint permits a later offline reader to select only the same previously authenticated credential's snapshot; it is never returned to the model or accepted as server authority. Credential rotation requires fresh online validation before that snapshot is associated with the new credential.

Each runtime store handle has an in-memory generation fence. Delayed reads from a previous attachment cannot write the replacement store. Explicit detach, server refusal or local stop invalidates access immediately and removes that attachment's cache; OS cleanup failure is reported without preventing shutdown. Process exit/reload retains a recoverable checkpoint. Offline reads must declare stale/partial status and last-known access, and no cached attachment reference bypasses a live permission check. Message retention is whole-current-snapshot only (no append-only raw payload archive); record events are append-only historical facts within that same private attachment namespace. On reuse of a native-session namespace, abandoned attachment copies older than30 days without contact are removed; other agents' namespaces are not swept. No age-based truncation of the currently attached room's message set.

## Synchronization

The normal pump may negotiate1.6 only with a working store and the complete prerequisite lane. Older lanes retain their behavior. Every valid1.6 page is stored independently of model wake/delivery. Main command cursors are NEVER restored from the room cache.

Older backfill uses only the existing poll's explicit older-page cursor. A read-only repair can request `catch_up` only with a known live cursor, making it an inactive history lane. It must never enqueue commands, claim notices/questions, apply controls or change the live command cursor. Bound background requests (at most12 recovery reads/minute) and use the existing shared cooldown. Recovery never gates foreground command admission or restores its cursor.

Coverage is checked at the server's fixed order point over unique IDs, not against a moving room total. Keep the older-history frontier independently from live continuation. Incomplete backfill is expected, not corruption. Persist unfinished deletion pagination (`seen.total=null`) and relist intent; acknowledge no complete deletion scan until the local tombstone set accounts for it. Known tombstones dominate late pages/checks and erase cached text/attachments. Newer final rows cannot return to in-progress.

On reload, authenticate the current attachment before reusing its exact namespace. Resume the saved older-history frontier; fill any newer gap independently. A missing/failed coverage read makes no completeness claim. A storage failure rolls back the page/checkpoint together, marks local context unavailable/behind, and does not prevent a valid foreground command.

Record events arrive in the existing negotiated pages, not through a new polling loop. `available` merges IDs, `unchanged` retains them, and missing/unavailable/malformed sections retain history but mark it unavailable and request a full revision next time. An unknown advisory event cannot reject an otherwise valid command. Older recovery responses may add previously unseen events but never roll newer revision metadata back. Event times are not delivery cursors. The server's 2,000-event bound is exposed as `truncated`; the local store does not drop earlier saved events when the server's window moves.

## Native reading and delivery

`read_room_context` is one small native hot tool, independent of the MCP wire catalogue. The complete online transcript tool stays immediately available alongside it, as do the current task/memory/resource getters. Useful access is not removed merely to fit a numeric prompt target. It offers status, newest-first history, stable message anchors, literal search, since-checkpoint navigation and observed room-state reads. It performs no network requests. History pages and search-result windows return bounded previews with continuation; literal search applies across the cache before limiting matching results, so finding an old message does not require model-driven scanning; exact message/state reads return complete JSON or lossless bounded JSON fragments. `view: "events"` returns historical record events the same way, with independent availability/truncation metadata. Poll observation timestamps do not invalidate event fragment continuation; actual history changes do. Changed fragment sources and foreign-scope cursors require an explicit restart, not silent joining of different versions.

Every result is labelled a local snapshot, with observation time and fixed-cutoff coverage. An index is not live entity state. Use the existing live record getters for current facts and deliberate resource retrieval. Offline selection uses the current credential fingerprint and this native conversation's last-known attachment; explicit denial/detach suppresses selection. Scope markers are non-context Pi custom entries and never restore execution authority.

When the current page is safely stored and the reader is available, ordinary command delivery omits bulky advisory history and adds a compact snapshot notice at the current delivery tail. Full current command text, exact requester/authority/scope, style and direct-command attachment handling remain unchanged. If storage/reader readiness is missing, retain the supported delivery fallback. Question/control/notice protocols stay separate; room changes alone do not start model turns. Checkpoints are navigation, never a claim that the model read those messages.

## Read bookmark and unread notice

Item `ce1ffca1` (brief `4d258656`, decision `c4c6190f`). Three facts are kept apart, all in the same attachment copy (`room_marks` table, `extensions/core/room-unread.ts`); there is no second store:

- **Saved through**: the coverage checkpoint above. Navigation only.
- **Read**: per message id, the exact version (visible text and attachment references) `read_room_context` handed to the model. Only the reader writes it: the `unread` view, a complete `message` read (or the last fragment of an unchanged chain), and history/search previews that are the whole message. A partial preview, a wake, a notice and Pi's own reply never do.
- **Presented**: what a notice has told the model exists. It decides whether a mid-turn notice has anything new; it never marks anything read. A command Pi is woken with (now, steer or follow-up) is presented at delivery, so it never makes a notice fresh, and it stays unread and `for_you` until the reader hands it over.

A real message is judged by what a person sees: text or attachments from a person, another agent or the in-session AI, final or in progress. System lines (presence markers, notices), empty rows in any state, deleted rows and this connection's own rows are excluded. Own rows are known by exact post-receipt id, and, for rows from before this copy existed, by the connection's `Tool · Codename` label (only when it has a codename). A read message that changes is `updated`, never unread again; finishing with the same text is not a change.

The notice is JSON counts (unread, updated, for you, oldest unread time, per author, and the exact `read_room_context {"view":"unread"}` call), never bodies; author labels are data. It is shown on every wake beside the command, on the first wake or boundary after an attach (a new attachment starts with nothing read), and at Pi's tool-result boundary (`turn_end`) only when something waiting was not yet presented, as a hidden entry appended to the current turn. The boundary check reuses one pass per SQLite file change counter, so an unchanged copy is never re-parsed.

Before the answer: Pi's speech lane posts each assistant message as it finishes, so a check after the final message could only add a second bubble. The notice therefore reaches the model at the tool-result boundary, before the request that may write the final message. Messages that land while that last request is already generating are reported by the next wake's counts. No follow-up turn is started: room changes alone never start model work, and two agents continuing on each other's replies would loop.

The `unread` view returns waiting messages oldest first, whole, and marks exactly those read. Its only page bound is Pi's own tool-result ceiling (`DEFAULT_MAX_BYTES`); past it the result states the total, what it returned and the call for the rest. A single message larger than that is listed with the exact lossless `message` read and stays unread until that read completes.

## Quality before numeric targets

Ali's2026-09-24 clarification: prioritize useful instructions, complete access and real results over the former8k prompt ceiling. The larger prefix alarm catches accidental catalogue/contract dumps, not necessary growth. Bounded local pages remain lossless through explicit continuation; they do not ration the available history. Focused correctness checks are the shipping gate. Comparable provider measurements are needed before making savings claims, not as a reason to postpone a safe release indefinitely.

## Verification

Run one test file at a time on the shared machine. Exercise real SQLite transactions and reopen the database at injected crash boundaries; >60 history, >500 live rows/tombstones, late deletion, restart during paging, stale final/partial replies, concurrent scope changes, unavailable/empty snapshots, privacy and denied access. Pair parser fixtures with the current server producer/schema. Use a disposable room/host for live qualification, never fault-inject Ali's working room. Treat runtime activation separately from an on-disk update.
