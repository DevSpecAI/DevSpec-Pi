# Changelog

## 0.5.5

- DevSpec memories now have four types: decision, convention, insight and risk. Recording or searching a memory offers those four, and how something is built is recorded as a decision. Open questions live in Still to Discuss, so the separate open-questions memory tool is gone. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.4

- DevSpec's tool descriptions now match a few behaviours that changed on the server: giving a tool a room you can't open is refused rather than ignored, verifying an item tells you where it ended up, releasing an item nobody held says nothing changed, the project summary counts only the rooms you can open, and searching an automation's runs also finds its scheduled runs. A retired connection-check tool that nothing used is gone. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.3

- DevSpec's tool descriptions now say what each tool actually does, after an independent review of every tool: wrong claims are corrected, each optional setting says what happens when it is left out, and rules about who may do what point to DevSpec's served contract instead of being repeated. Clearing an item's assignees or taking it out of its brief with `null` now works as the description always said. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.2

- Pi now knows which room messages it has actually read. Before, the room note Pi saw at the start of each task moved its "read up to here" mark even when Pi never opened the messages, so things people said while Pi was busy could slip past it. Now a message only counts as read once Pi has read it, and it stays unread until then.
- When Pi starts a task, it sees how many room messages it has not read, how many have changed since it read them, how many are addressed to it, and who sent them. These are counts only, never the messages themselves. When Pi joins a room, everything already there starts unread.
- If new messages arrive while Pi is working, it is told at its next step, before it writes its reply, so it can read them first. It is told once for each new batch, and nothing is added when nothing new has arrived. Pi's own messages, join and leave lines, deleted messages and empty messages are never counted.
- `read_room_context` has a new `unread` view. It returns the unread messages in full, oldest first, and marks exactly those as read. When there are more than fit in one reply, it says how many are left and how to get the rest.
- Messages addressed to Pi still interrupt it exactly as before.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.1

- Ending Pi from DevSpec (End on the Agents page or in a session) now closes Pi in its terminal, straight away and even mid-task, so with many terminals open you no longer have to find the right one and quit it by hand. Any running work is stopped and Pi prints how to resume the conversation. Stopping it from the terminal, a detach, or a brief problem on DevSpec's side never closes Pi.

## 0.5.0

- Pi keeps working when DevSpec is newer than this extension. DevSpec's rules for agents are read part by part: anything Pi does not recognise is ignored, and a part it cannot read is passed to the agent exactly as DevSpec sent it, with a note. Before, one changed detail anywhere in those rules made `/devspec.work` set them all aside and use Pi's short built-in rules, which is what had been happening since mid-September. Pi now reads the rules DevSpec serves today in full.
- When a DevSpec tool call fails because DevSpec has changed that tool (a new required input, different allowed values, or a tool that no longer exists), the error says so and tells the agent to ask you to update the extension. Ordinary mistakes in a call are reported as before.
- When DevSpec sends Pi a message it cannot read, Pi says so once, here and in the room, instead of retrying silently. It keeps checking, so the message is still acted on once Pi can read it. Room details Pi cannot read, such as polls or Still to Discuss, are reported once here too.
- Each of these notes says how to fix it: run `pi update --extensions`, then restart Pi.

## 0.4.4

- Recent sessions can be narrowed to active or archived rooms, and the count covers just those. Three tool descriptions now say what the tools do: which rooms the recent list and Still to Discuss search leave out, and that a room id sent to Still to Discuss search is checked rather than ignored. The catalogue is regenerated against DevSpec's current tools.

## 0.4.3

- DevSpec now works out for itself whether an agent's work was unattended, so Pi's tools no longer carry a setting for it, and the retired runner heartbeat is gone from Pi's catalogue. The catalogue is regenerated against DevSpec's current tools, including their rewritten descriptions.

## 0.4.2

- Pi reads DevSpec's current implementation contract again. Since mid-September the server's contract carried two things this Pi did not recognise (the rule for queued review-flag rulings, and the Reviewed Contributor role's outcomes), so Pi set the whole contract aside and worked from its short built-in fallback. Both are now read, and both reach the model.
- A commit may name more than one DevSpec item: the contract now says one or more references, and Pi accepts exactly that shape (DevSpec contract 4.13.0).

## 0.4.1

- Remove the three V1-removed tools from the result-projection lists as well. No behaviour change.

## 0.4.0

- Each DevSpec tool now has one description, the same text every DevSpec host reads, and the rewrite brings back what a model needs before calling it: what the tool is for, where its neighbours take over, and what it changes. The tools removed for V1 are gone from Pi: `send_agent_message`, `control_connection` and `submit_plan_review`. So are inputs that did nothing, and inputs the server reads but never listed are now shown.
- Still to Discuss: searching and adding are now an explicit choice between this room and the whole project, with the whole project as the default. Pi still supplies the room when you choose it, but being in a room no longer narrows a project-wide search.
- `search_devspec_tools` pages: it takes `offset`, returns the page, and says where the next page starts when there are more matches, online or offline.
- A search that could only partly run, for example when one of its two document lookups failed, now says so instead of reading as an empty result.
- Pi's instructions say that @ and a person's name in a room reply notifies that person.
- Reload or restart Pi after updating to load the new catalogue.

## 0.3.57

- A goal with more than 500 items is now readable to the end: `get_goals` with a goal id returns the items a page at a time, says how many there are, and gives the `items_offset` for the next page. Before, the list stopped at 500. A goal's progress that could not be read now shows as unknown rather than as 0 of 0.
- Refresh the generated server catalogue; reload/restart after updating to load the new `items_offset`/`items_limit` inputs and descriptions.

## 0.3.56

- In a DevSpec room with more than 16 open polls, or polls with a lot of text, Pi was shown no polls at all. Pi now asks for the newer poll list, which always shows polls when the room has any. It shows the newest ones that fit, says how many there are in total, and, when some were left out, tells Pi to read them all with `manage_poll list`. Rooms with fewer polls look the same as before.
- Refresh the generated server catalogue for the new `poll_connection` input. Reload/restart after updating.

## 0.3.55

- Memory, document and help searches, and tool search, now return results a page at a time with a way to read on: Pi names the offset for the next page, says when a count is a floor, and for document search gives one offset that continues both documents and artifacts. Before, these searches stopped at their page size with no way past it.
- Refresh the generated server catalogue; reload/restart after updating to load the new `offset` inputs and descriptions.

## 0.3.54

- When DevSpec cannot reserve an item, Pi now sees which items were skipped and why, including the proposal to review when the item is still a suggestion. Before, it saw only "see skipped for why".
- A suggestion or edit saved for review keeps its result, revision and Review link, so Pi can tell the person where a Maintainer will accept it. Reload/restart after updating.

## 0.3.53

- Action-item lists and search say when an item is only a suggestion awaiting review, or one a Maintainer declined, using the line the server sends. Agreed work is shown as before. Reload/restart after updating.

## 0.3.52

- Memory tool guidance no longer advertises unfinished workflows. Optional evidence pagination remains compatible, and enabled server responses retain their complete reading guidance.
- Refresh the generated server catalogue; reload/restart after updating to load the new descriptions.

## 0.3.51

- Full requirement reads expose the server's independent evidence pagination, preserving exact versions, observation dates, coverage and cautions. Failed evidence reads remain unavailable rather than empty or passed.
- Keep the full memory body and evidence through native result projection. Reload or restart after updating to load the additive `get_memory` inputs; requirement authoring remains disabled.

## 0.3.50

- Target Pi 1.0 and Node.js 22.19 or later. Pi’s built-in MCP is the default for other services; DevSpec still needs only this package and sign-in.
- Keep Claude/shared MCP configuration untouched on fresh Pi. Detect native Pi duplicates separately from the optional MCP adapter, using the adapter’s public configuration API for its imports and overrides.
- Migrate recognized legacy adapter-only overrides out of Pi’s native `mcp.json`, with a private backup and refusal on conflicting, malformed or symlinked files. Native definitions retain their credentials and foreign servers remain available.
- Preserve old transcript recovery data under Pi 1.0’s current types. Update/reload Pi after installation; npm publication is a separate release step.

## 0.3.49

- `/devspec.login`, `/devspec.status`, `/devspec.help` and the not-connected notices now link straight to DevSpec's Agents settings page for your token: https://app.devspec.ai/settings/agents (or the staging page when Pi points at staging). That page used to be Coding agents at `/settings/coding-agents`; the old address still redirects.
- Pi is now described as an agent rather than a coding agent in this package's README and npm description. Update and reload/restart Pi to pick up the new wording.

## 0.3.48

- Leaving a commit unspecified no longer attaches the process's sole recent commit to unrelated work. The server's claim-scoped observations remain responsible for automatic selection.
- Short commit hints now reach the project-wide resolver unchanged instead of being expanded from one checkout or an arbitrary ledger match. Supported normalized hex hints retain their original bytes; malformed revision/shell syntax is still rejected.
- Explicit full objects can still carry corroborated message bytes. Added actual-Pi native-tool conformance for omitted, short and full hints after a real commit. Update and reload/restart to load the correction; existing erroneous records are not silently rewritten.

## 0.3.47

- Queued commit observations no longer adopt a later login, server, or repository. Reports retain their original connection capability and endpoint; changed account or repository bindings are dropped rather than reassigned.
- Keep observation credentials host-side and expose only privacy-safe delivery counters in optional debug logs. Unsupported, offline and legacy unfrozen observations never block Git; ordinary server reconciliation remains available.
- Add actual-Pi scripted-provider conformance for root/amend/worktree commits and a connection change after Git runs. Reload/restart after updating; publishing source does not refresh a running process.

## 0.3.46

- Let memory reads request older change-history pages on supporting servers, keeping the complete memory text and continuation details available to the agent.
- Update the bundled tool catalogue with optional history page parameters. Update and reload/restart Pi to load the new schema; existing reads remain compatible.

## 0.3.45

- Keep established duplicate-MCP suppression quiet at startup. A visible notice appears only when the plugin newly writes the Pi-only override, not on later launches.
- Retain hidden agent context and on-demand help; explicitly tell the agent not to announce the explanation proactively. Suppression and shared-configuration boundaries are unchanged.
- Reload/restart after updating to load this correction.

## 0.3.44

- Explain a detected duplicate DevSpec MCP entry on each interactive startup, including when its Pi-only override was saved previously. Other agents' settings and foreign MCP servers remain untouched.
- Give the agent a one-time session explanation even before sign-in, so it does not try to re-enable the duplicate or mistake suppression for proof of a healthy connection. No repeated per-turn notice or system-prefix rewrite.
- Clarify installation and troubleshooting in the README. Update and reload/restart Pi to load this version.

## 0.3.43

- Remove the bundled DevSpec Launcher, its startup extension and login-time installation/pairing callback. Normal Pi authentication and automatic remote connection do not require the launcher.
- Remove launcher-specific commands, diagnostics and test setup. Document the independent optional app; no installed developer-machine helper or data is automatically removed.

## 0.3.42

- Tool and parameter guidance is preserved in full, without sentence extraction or per-description character ceilings. Catalogue footprint is reported diagnostically; actual result and protocol limits remain enforced.
- Matching servers keep tool-search indexes current automatically through worker startup, request-driven repair and periodic reconciliation. Keyword fallback stays available until a complete matching index is ready; the bundled index is a warm cache, not a required manual generation step.
- Strengthened long-text, complete-catalogue and paired server/native projection checks. Reload or restart Pi after updating to load the new guidance.

## 0.3.40

- Bundle launcher 0.3.1: fix Pi discovery under the desktop service's restricted PATH and avoid a second error tab for loopback failures. Reload the plugin to run the shared update check.

## 0.3.39

- First session startup now runs the shared launcher's installation, OS-registration and readiness flow instead of only copying files. Setup failures do not stop Pi, and deliberately disabled setup stays disabled.
- Added `/devspec.launcher status`, `repair`, `enable`, `disable` and `uninstall`. Copy commands remain usable without the launcher. Update/reload the installed plugin to load the new lifecycle integration.

## 0.3.38

- All safe tools available to the connection are now directly callable from startup, with authored guidance for choosing and maintaining work, memories and documents. Internal delivery tools remain private; session-only tools still require their connection context.
- Tool search is optional advice, not an unlocking step. Exact names stay local; intent queries use matching server-side hybrid search when available and explicitly fall back to local keyword search otherwise. Search never executes recommendations or changes the active tool set.
- Shared artifacts have positive capture and maintenance guidance. Related-document suggestions are labelled advisory rather than blocking gates. Existing write checks and authority outcomes remain intact.
- Update and reload/restart Pi to load the new surface. Older servers remain usable through the local fallback; semantic query usage follows the project's existing attributed search billing.

## 0.3.37

- Session attachment and connection recovery preserve refreshed project/machine rules and explicit cleared values. Valid canonical command responses also refresh the rule snapshot, including after a web-initiated room move.
- Rule changes append immutable model-context snapshots rather than rewriting the system prompt prefix. Repository facts remain associated with the selected project and refresh on recovered registration. Reload or restart to load the update.

## 0.3.36

- Agents receive the selected project's repository names, remote URLs and tracked/default branches on connection and project switching, without depending on the launch folder. Empty and unavailable repository information are distinct. Snapshots are factual model context, not cloning instructions, and do not rewrite earlier messages.
- Explicit project-summary reads preserve descriptions, all repositories, rules and other returned facts without fixed list or text caps. Security redactions and retired compatibility fields are named explicitly.
- Requires the server's additive repository-context response for automatic inventory. Older servers are reported as unavailable, not empty. Reload or restart Pi after updating; existing processes do not hot-load a repository merge.

## 0.3.35

- The DevSpec row now uses normal foreground for DevSpec, the agent, session, automation and action-item names. The project name, separators and supporting status text stay muted. Colours follow the current Pi theme, including theme changes, without altering layout or truncation priority. Reload or restart after updating.

## 0.3.34

- DevSpec has its own row below the editor, separate from BG/MCP statuses, without replacing Pi's native footer. It shows **DevSpec: agent · project · session · current work** and omits missing fields.
- Full titles use the available width. On narrower terminals, the project name shortens first, then the action item, then the session; the agent name stays intact. Project IDs, organisation and connection diagnostics remain in `/devspec.project` details. Reload or restart Pi after updating.

## 0.3.33

- The footer is back to agent, session and current work. Project IDs, connection-source diagnostics and routine successful-login identity no longer occupy permanent status space.
- `/devspec.project` opens a native menu with project details, choosing, remembering and forgetting. The full ID and selection source remain available under Project details; normal project choices show readable project and organisation names, with IDs only to disambiguate identical labels. Reload or restart existing Pi sessions to pick this up.

## 0.3.32

- Choose the DevSpec project for one Pi conversation with `pi --devspec-project <name-or-id>` or `/devspec.remote --project <name-or-id>`. Ambiguous connections on supporting servers offer a native project-and-organisation picker; ordinary unambiguous launches stay automatic.
- `/devspec.project` shows the current choice and offers choose, remember and forget. Remembering a folder default is explicit; changing or removing it does not redirect existing conversations. Choosing another project starts fresh local context after confirmation.
- Conversation scope survives resume and applies to ordinary DevSpec calls as well as the remote bond. Headless ambiguity does not hang awaiting a picker. Reload or restart to load this version.

## 0.3.31

- Registration and attachment now report the DevSpec plugin version loaded by the process, separately from the Pi host version. This lets staff find affected users when investigating a plugin release. Version reporting does not change connection identity, permissions, presence or message delivery; older servers may ignore it. Existing Pi sessions need a reload or restart to load the reporter.

## 0.3.30

- The DevSpec guidance Pi reads now draws one more line on knowledge capture: what shipped, which commit and what passed belong on the action item, not in project memory — and a memory should hold what a future decision needs that the existing record doesn't already preserve. Shared project knowledge stays free of per-task status reports. The DevSpec tool catalogue is refreshed to match. Reload or restart existing Pi sessions to pick this up.

## 0.3.29

- Refreshed the DevSpec tool catalogue: the old review claim loop (get_claimable_reviews, claim_review, record_review) is gone — nothing could ever offer a review into it any more. Asking for a review is unchanged: someone picks your agent on the item and you get the ask as a message, and checking work still means record_criterion_verdicts. Reload or restart existing Pi sessions to pick this up.


## 0.3.28

- Refreshed the DevSpec tool catalogue: the three create tools (action item, artifact, memory) now accept an optional retry key, and DevSpec dedupes a retried create — an agent that loses its response to a timeout and tries again gets the original record back instead of filing a duplicate. Reload or restart existing Pi sessions to pick this up.

## 0.3.27

- The README's install command now works: `pi install git:github.com/DevSpecAI/DevSpec-Pi`. It said `pi install npm:@devspec/pi-plugin`, but the package is not on the npm registry yet, so that command failed for everyone. DevSpec's own connect instructions already use the GitHub install.
- Refreshed the DevSpec tool catalogue: the help-search example no longer mentions Autopilot, and changing an item's lifecycle now says that finished work can't be parked as deferred or blocked (reopen it first). Reload or restart existing Pi sessions to pick this up.

## 0.3.26

- Pi now sends you to You → Coding agents (`/settings/coding-agents`) for your DevSpec token, in `/devspec.login`, `/devspec.status` and `/devspec.help`. That page used to be called Connections; the old address still redirects.
- Refreshed the DevSpec tool catalogue: personal agent rules and response style are now named where they live, You → Coding agents → Personal agent rules and You → Replies & voice → Response style, and automated reviews are under You → Coding agents. Reload or restart existing Pi sessions to pick this up.

## 0.3.25

- An answer typed in your own words to Pi's multiple-choice question now reaches Pi when it is longer than 200 characters. DevSpec accepts up to 1000, but Pi kept its own, older copy of that limit, so a longer answer was refused. Pi now leaves answer limits to DevSpec, so a future change to them needs no Pi update. Reload or restart existing Pi sessions to activate this fix.

## 0.3.24

- Background maintenance no longer causes an unchanged memory to be recalled again. Recall ignores the row's last-updated timestamp while still noticing new versions, state changes, proposals and disagreements.
- Automatic recall no longer displays that maintenance timestamp as revision context. Existing messages remain unchanged. Reload or restart existing Pi sessions to activate this fix.

## 0.3.23

- Keep proposal IDs, reasons, previews and operation receipts visible after formatting tool responses. An incomplete response never asks the agent to repeat a write.
- Recall changed memory revisions and disagreements as new context without rewriting earlier messages. Both sides remain visible, or the agent is told exactly what context is missing; unreadable records stay private.
- Separate retrieval suggestions, unfinished write checks and unresolved issues. Observations are isolated by account, project and session; different pairs cannot collapse merely because they share a record.
- Resolve exact tool names without substituting a related tool. Activity distinguishes unknown results, pending replacements and discussions from applied changes.
- Reload or restart an existing Pi session to activate this release. Memory revision detection uses the server's card revision fields when available; older servers cannot identify a body-only change that leaves all returned card fields unchanged.

## 0.3.22

- A write that comes back queued for review now tells you a maintainer accepts it on the project's Review page, under Proposed changes. It used to point at a "Review tab", which no longer exists.
- Refreshed the DevSpec tool catalogue: previewing a ruling on a staleness flag that names no other item no longer needs a counterpart.

## 0.3.21

- Room history now includes server-recorded item changes and memory/document events with their original timestamps and attribution. Read them with `read_room_context` (`view: "events"`); use live getters for current record status.
- Event history survives reloads, deduplicates by event ID, and reports unavailable or truncated reads without discarding earlier history. Requires a server advertising the optional events section; older servers keep their existing behavior.

## 0.3.20

- Messages waiting behind an active question can now request native interruption without prematurely replacing the question's authority. The matching server validates a non-executable availability offer, then performs an exact handoff only when Pi is ready.
- Preserve preempt-off, validate attachments before interruption, and request abort at most once per pending source. A non-settling abort stays pending rather than being reported as recovered.
- Background jobs and ordinary speech keep their existing ownership and delivery paths. Prepared files are reused only for the identical authorized manifest; stale offers cannot consume the command cursor.
- Requires the matching server handoff endpoint. Reload/restart to activate this release; it does not claim recovery from every historical unresponsive-agent incident.

## 0.3.19

- Observe owned background jobs through the provider's public terminal/status API, even when completion notices are disabled, lost or never consumed. Unknown provider state remains unresolved.
- Re-evaluate idle completion without a model wake, using exact command/interaction identity or a local activity receipt captured before execution. Late callbacks cannot complete a newer local activity.
- Local admission uses a capability/attachment-bound `report_pickup` variant and existing activity IDs; ordinary speech stays independent. Requires the matching server local-admission endpoint. Missing or failed admission never falls back to completing the latest unbound activity.
- Preserve 0.3.18's question ownership retirement and fair command polling. Runtime/API/browser qualification remain distinct; reload the plugin to activate these changes.

## 0.3.18

### Keep messages moving after questions

Fixes a client polling stall that could delay new messages while a question
answer was waiting to resume. Leaving a question also stops its old state from
suppressing Working updates on later work. Exact answer acknowledgements and
interruption preferences are preserved.

Reload existing Pi terminals to activate these fixes. This is a targeted client
repair, not the separate server-side change for interrupting an active question.

## 0.3.17

### Read room context locally

The native `read_room_context` tool reads and searches the saved room copy,
including older messages, observed state and file references. Exact reads have
lossless continuation; missing, partial and changed snapshots are explicit.
Current item, memory and resource facts still come from the existing live getters.

When the local copy is ready, a compact availability notice replaces repeated
background-history dumps. Current commands, their authority and response style
still arrive in full. The online transcript tool stays immediately available.
Prompt-size checks now allow useful growth rather than enforcing the old8k target;
no provider-cost saving is claimed without measurement.

Reload existing terminals to activate the new reader and delivery behavior.

## 0.3.16

### Keep large-file history references available

A historical file reference no longer prevents room history from synchronizing
just because the file exceeds Pi's automatic download budget. History stores only
the reference; current-command attachment and download limits remain unchanged.

## 0.3.15

### Recoverable local room history

Pi can retain room history across restarts, load older pages in the background,
and reconcile messages that finish or are deleted. Message data and recovery
positions commit together in private local storage. Switching rooms isolates the
copies; stopping or losing access invalidates the affected copy.

The activity index stores record IDs and relationships, not cached lifecycle or
supersession claims. Current action-item, memory and resource facts still come
from the existing online native tools. Other saved room views are timestamped
observations, not a guarantee of current state.

This is the storage slice: current command delivery, attachment hydration and the
single speech writer remain in place. Native local read/search and compact context
delivery follow separately. The feature requires the advertised room-context
contract and Node's SQLite support; older supported ingress lanes remain available.
Reload existing terminals after updating to activate the new code.

## 0.3.14

### Current memory editing and review tools

Pi now exposes the memory-editing tool through on-demand discovery, and an
out-of-date flag on one action item can be addressed without supplying a
second item. Tool guidance also reflects the current review queue, criterion
wording and testing-note contracts.

Memory-edit responses retain replacement-version identity, queued proposals,
exact previews and refusal details. The everyday tool set is unchanged; this
refresh does not add another posting path or change room-ingress negotiation.
Reload or restart an existing Pi session after updating to load the refreshed
tool schemas. Reconnect alone does not reload them.

## 0.3.13

### Keep Still to Discuss context current

Pi can read the current room's discussion points when the server updates its
explanatory wording. That wording is treated as data, not permission: Pi keeps
its own advisory guidance and still validates the projection's version,
identities and shape. Empty and unavailable snapshots now replace older lists
explicitly, so missing context is not mistaken for an empty room.

Optional room-state rejection is visible in privacy-safe debug metadata and
cannot swallow a valid command. Tests exercise the paired server's actual
projection producer as well as the Pi parser and delivery-tail transitions.
After updating, reload or restart Pi to load the changed extension; reconnect
alone does not load new code.

## 0.3.12

### Provider errors are visible in the room

When the model provider refuses a request — an exhausted balance, an expired
key, rate limits that outlast the automatic retries — the room now shows the
error and what to do next, instead of the agent simply going quiet. The turn
closes in an explicit error state, the Working indicator clears, and after
the cause is fixed in the terminal, the next message continues as normal.
Nothing is retried or replayed automatically. After updating, reload or
restart Pi to load the changed extension.

## 0.3.11

### Restore the configured interruption behaviour

Reverts the silence-based recovery introduced in 0.3.10. New messages again
respect the configured choice to interrupt or queue, including during long
operations that produce no intermediate output. Background work continues to
keep the agent marked Working until it finishes.

The reported unresponsive-turn problem remains under investigation; this
rollback does not claim to fix it. After updating, reload or restart Pi to
load the changed extension. `/devspec.remote reconnect` only retries the
existing connection and does not load new code.

## Unreleased

### A mistyped provenance ref dies at the door, with the way out named

Tool calls carrying `provenance_ref` or `work_claim_ref` are now checked
against the refs this process has actually been dealt — delivery refs from
validated ingress, claim refs observed in claim results — before the call
costs a server round-trip. A ref that was never dealt here (watched live on
2026-09-20: a model retyped a 36-char delivery UUID with a fabricated tail,
and the server rightly refused it) is refused locally with the current turn's
refs named and the safe path taught: omit the parameter and the server
attributes the write to the active turn by default. Refs are never silently
rewritten, dealt-but-old refs still pass (liveness is the server's call), and
omission is never checked. The typed-delivery text now says the omission rule
out loud, and the dealt set clears with the turn bindings on bond resets.
`test:core-paths` gains the new suite.


### One command for the lifecycle-critical test path

`npm run test:core-paths` runs the nine suites that pin the remote/lifecycle
contract — turn lifecycle, command-turn and canonical-ingress wiring, speech
delivery, post receipts, catalog drift, attach context, recovery wiring and
debug privacy — sequentially, so it is safe on the shared machine where the
full parallel suite is not. This exists because a real miss happened: a
turn-lifecycle change needed a new global in the speech harness's sandbox, and
the ad-hoc single-file habit skipped that file. When you touch the remote pump,
the turn tracker, or the speech/trail paths, run this.


### Speech posts can no longer wedge on a stale scope

Ordinary assistant speech now posts on the server's append-only v2 lane
(DevSpecV2 migration 953, staging `c766ab75b`): the extension sends your
connection, the text and its idempotency key — and nothing about where the text
"belongs". The server lands it in the room you're attached to right now and
annotates the open attempt and turn afterwards, when they exist.

Before this, a speech post carried an exact pinned scope — the session, the
attachment stamp and the attempt — and the server refused the post when any of
it had moved. A reattach or reload at the wrong moment turned a finished answer
into a rejection. The words are the thing that must survive; where they belong
is the server's reading, not the client's memory.

What hasn't changed: speech still drops (with the same warning) if the bond
moves mid-turn, directed-question continuations keep their exact
claim-token-bound path, and every other host's posting path is untouched.


### Write attribution teaches omission as the default

The provenance_ref parameter's description now says plainly what has always
been the safe path: leave it out and the server attributes the write to your
connection's single current open turn — one server-owned pointer, not a choice
the model has to make — and send an explicit ref only for work caused by
another command in that same turn. A wrong ref fails closed, so when unsure,
omit. This is the lesson of the 2026-09-20 transcription incident (a model
copied a 36-char delivery UUID with a fabricated tail and was rightly refused);
the default path makes that failure impossible rather than unlikely. Catalog
regenerated for the new wording.


### Working stops lying when the tracker wedges

Pi now sends an opaque progress marker with every working-lease beat (the poll
tick and the heartbeat): a plain count of the session events this process has
seen — turns, messages, tool calls, their streaming updates. Paired with the
DevSpec server change (migration 952, DevSpecV2 staging `a914cad1b`), a lease
renews only while that marker keeps changing. If the extension ever wedges
again the way it did on 2026-09-20 — a killed background task froze the turn
tracker and Working showed for five hours of idle — the marker freezes with it,
the server declines renewal after its staleness bound, and the attempt expires
through the ordinary lease path instead of lying.

Nothing changes when work is genuinely flowing: every turn, message, tool event
and streaming update moves the marker, so long quiet stretches inside a real
turn (a big build, a slow test suite) keep Working exactly as before. Hosts and
builds that never send a marker get the legacy behaviour untouched.


### The write check tells you which document it matched, on either corpus

DevSpec stops a knowledge write when something close already exists, and the
reply names the record it matched so you can go and read it. Pi described that
as a memory-only thing, because when it was written it was: the artifact write
corridors could not answer the check at all (fixed server-side in DevSpec
134f4454, staging `f5c89d8b3`).

Three things were saying something untrue, and one was actively misleading:

- The flag the session keeps open said "memory write recall-gated" whatever you
  had been writing, and told you to re-call "with reason" — a demand DevSpec
  removed on 2026-09-18. It now says memory or document from the verb, names the
  match by **title** rather than only an id suffix, and asks for no reason.
- The result projection labelled the match "Closest memory match" and told you to
  fetch it with `get_memory` — which returns nothing for a document id, so a
  document refusal read as the gate matching a record that does not exist. It now
  names the right reader per corpus.
- The always-on instructions said only `record_memory` was gated. They now say
  every knowledge write is, and what to do when one is stopped.

The catalog is regenerated against that staging commit: `create_resource` gains
`confirm_new`, and a `register_connection` description that had drifted since
2026-09-19 is picked up in the same pass. Same 100 verbs, same projection
families. The initial model surface measures 7,480 tokens of the 8,000 ceiling,
up 24 — all of it the instructions line, none of it the catalog.

### Resumed sessions no longer brick on duplicate tool definitions

Loading a less-common tool with `search_devspec_tools`, then resuming or
reloading the session and loading the same tool again, could make some
providers reject every following request with "duplicate tool names are not
allowed" — the session could not continue. On resume, tools the conversation
had already loaded are active again exactly as before, so nothing is announced
twice. And if a provider ever does reject a request for a duplicated tool, the
extension now deactivates just that tool for the rest of the session and
continues working, instead of stopping.


### Auto-bond works when you have more than one project

Pi used to send `register_connection` with no folder identity, then retry with
this checkout's git remote if the server asked which project. A later fix stopped
closing the shared MCP client on application errors — and, by treating every
`isError` as "do not retry", also skipped that folder-scope retry. One-project
accounts kept working; a second project made auto-bond (and `/devspec.remote`)
fail with "this call needs a project", while Claude Code still connected because
it sends the git remote on the first register.

The host now sends the git remote and/or `.devspec/project.json` pin on the first
call when it knows the working directory, the same shape as Claude Code. A
project-scope `isError` still retries once with those facts on the same client —
not a reconnect. Other application errors are still one request. Auto-bond
toasts the register error instead of failing silently.

### Tool instructions are no longer cut off mid-sentence

Every DevSpec tool Pi offers carries a one-line description, and the line was
being trimmed to 140 characters (160 when the catalog was generated). That was
short enough to cut real sentences in half: 19 of 84 tool descriptions and 23
parameter descriptions ended in an ellipsis, so the model read half an
instruction and had to guess the rest. Both limits are 320 now, a test fails if
anything ever ships trimmed again, and the always-loaded surface grew from 6,933
to 7,130 tokens of its 8,000 budget to pay for it — a good trade for 42
instructions that now say what they mean.

The clearest example is the one that prompted this: the description for
recording a commit said only "Final commit SHA", while a neighbouring tool
demanded "the FULL 40-character sha". Three agents in one day filled in the
missing characters by inventing them. It now says a short SHA is fine and that
padding one out is wrong.

### The lowest project role is Viewer

DevSpec renamed the lowest project role from "guest" to Viewer (an organisation
Guest is now a different thing: how much of the organisation someone can see,
not what they can do on a project). Pi reads the served write-authority section
by its exact shape, so it now expects the 4.5.0 outcome key `viewer` — without
this, a newer DevSpec would have failed that section and Pi would have fallen
back to its generic rules. The generated MCP catalog is refreshed with it.

### A proposal against a memory now shows up when you search for it

DevSpec lets a colleague propose a change to a decided memory or artifact without
touching it, so what you recall is still the decided text. Searching for one used to
show no sign that a change was waiting on it — only opening the exact record did.
A search result now carries the same "⚠ … awaiting a maintainer" line the record
itself carries, so a proposed change cannot be missed by looking it up.

### A newer DevSpec no longer switches Pi back to its local rules

Pi verifies the product contract it is served. When DevSpec added a new section to
that contract, the whole document failed verification and Pi fell back to five
generic local rules — losing the work-entry, provenance and authority rules it could
read perfectly well. A section this version of Pi does not know about is now noted
("update the plugin to read it") and everything else stays in force. The sections Pi
does implement are still checked exactly, and the contract's own hash still has to
cover the part it cannot read. A contract that fails verification now says so, rather
than reporting DevSpec as unavailable.

### The write-authority summary says what it means for an unattended run

Pi shows the model the three write classes and their outcomes. It now shows the two
rules that qualify them, in DevSpec's own words: that a run nobody is watching
proposes its memories and artifacts rather than recording them, and that closing your
own item is a different act from closing a colleague's.

### The activity trail stops saying a queued write landed

Recording a memory or ruling on a conflict shows as "recorded" or "resolved" in the
trail. When the server queues the write for a maintainer instead of committing it,
the trail now says "proposed" — and "contested" for a conflict ruling, which is what
DevSpec calls a pair nobody has ruled on yet. Plugin 0.3.2.

### Instruction block: stop rationing sentences

The always-on instruction test now fails on genuine bloat (a dumped verb map or a
pasted contract), not on adding a needed sentence. The authority pointer and
queued-write relay are full sentences again, and the memory / record_implementation
wording that was trimmed to fit 2,200 characters on 0.3.0 is restored. Plugin 0.3.1.

### The served contract's authority section, and queued writes relayed

DevSpec contract 4.4.0 adds `authority_contract` — who may change the project's record,
judged per call by the server. Pi verifies the section exactly like the others (an older
Pi read the new document as invalid and fell back to its local safety rules), shows the
model the classes, outcomes, requester rule and proposal outcome, and when a write comes
back `queued_for_review` puts the proposal id and reason at the top of the tool result so
the model relays them and never reports the change as done. The MCP catalog is
regenerated (adds `get_pull_request`).

### Playbooks are now Automations

DevSpec has renamed Playbooks to Automations. This plugin now uses the renamed tools
(`claim_automation_run`, `record_automation_run`, `get_automations` and the rest) and reads
the renamed fields in what the server sends it. It needs a DevSpec server that carries the
same rename; against an older server, automation runs are not picked up.

### Fixed

- `/devspec.remote --session <id>` now ATTACHES an already-bonded agent to that
  session instead of refusing with "already bonded". Interactive Pi auto-bonds on
  session_start, so there was always a bond by the time the command ran, which made
  `--session` unreachable in practice — a resume command, a copied attach line, or a
  person typing it all hit the guard and the room was silently dropped. Naming a
  session is an explicit instruction to be in that room, not a duplicate connect.
  A bare `/devspec.remote` while bonded still says so and does nothing.

### Changed

- `npm test` caps `node --test` at two files at a time (`--test-concurrency=2`) so this suite cannot fork one worker per CPU next to a live agent.

### Added

- Deferred native `search_sessions`: wire-map catalog plus ordinary-language aliases, not in the hot set. Compact session cards, then `get_session_transcript` to read one room.
- Native, schema-complete `manage_poll` on the same attached-bond activation path as `manage_plan`. Votes are not commands and do not keep Working on.
- Strict top-level `session_polls` advisory projection on changed remote packages.

## 0.2.0 — 2026-08-22

### Added

- Native, schema-complete `manage_plan` backed by the generated DevSpec MCP wire map.
- Hidden connection-capability v1 negotiation and transport-header stamping; models never provide trusted connection, session, project, or capability identity.
- Strict canonical remote-ingress 1.3 active-session-plan parsing and deterministic delivery-tail projection for resume, handoff, adoption, completion, and abandonment.
- Narrow plan-tool activation for attached bonds while unrelated deferred schemas remain cold.
- Work-entry contract v2 validation so the canonical implementation contract owns action-item/session-plan selection and the high plan threshold.

### Validation

- Added strict parser, scope/capability, activation, prefix-budget, reconnect, handoff/adoption, no-plan, lossless result, and privacy-safe trail coverage.
- Regenerated and drift-checked the 91-verb server wire catalog.
