# Changelog

## 0.10.7 - 2026-10-30

- The tool catalogue is regenerated against DevSpec's current tools. A person signing off work they did themselves, before anyone handed it in, now applies only to tasks that involve no code. A task that involves code is signed off once its commits are linked and the work is handed in, including work an agent handed in with nothing linked, and your agent is told so if it asks to sign one off early. Update with `pi update --extensions`, then restart Pi.

## 0.10.6 - 2026-10-30

- Fixed a loop that could use up all of your computer's memory. DevSpec's plugins for Pi, Claude Code and Antigravity each put a stand-in for `git` in front of the real one, so they can tag and report commits. When two of them were on the same PATH, for example a Pi session or Pi's tests started from a Claude Code agent, each took the other for git and they passed every git command back and forth, starting a new process each time. Pi's stand-in now recognises any DevSpec plugin's stand-in and always runs the real git. If an older version of another plugin still sends a command round in a loop, the command stops at once with a message saying so, instead of exhausting memory.

## 0.10.5 - 2026-10-30

- The tool catalogue is regenerated against DevSpec's current tools. When your agent creates a task whose work won't produce any commits (research, a setting changed in a dashboard, an errand), it can now flag it as involving no code, so the task finishes once it is verified instead of waiting for code. Signing off now also covers work a person did themselves that nobody handed in. Goals and their outcomes are managed with the new goals tool rather than a goal list on each task. Update with `pi update --extensions`, then restart Pi.

## 0.10.4 - 2026-10-27

- Added `pi.image` (`https://devspec.ai/logo-icon.png`), `homepage` (`https://devspec.ai`), and discovery keywords in `package.json` for the Pi package gallery (`pi.dev/packages`).
- Overhauled `README.md` for `pi.dev/packages` and npm with a clear overview of DevSpec's capabilities, a streamlined 3-step Quick Start, and complete `/devspec.*` command reference.

## 0.10.3 - 2026-10-27

- Scoped the published npm package under `@devspecai/pi-plugin` (matching the `DevSpecAI` organization) and updated the release workflow to support npm staged publishing (`npm stage publish --access public`).
- Updated `README.md` with the primary one-line npm install command (`pi install npm:@devspecai/pi-plugin`) and GitHub fallback.

## 0.10.2 - 2026-10-27

- Published package hygiene: `package.json` now declares an explicit `files` allowlist (`extensions`, `runtime`, `skills`, `prompts`, `themes`, `README.md`, `CHANGELOG.md`, `LICENSE`) and public `publishConfig` so `npm pack` ships only the runtime extension files and never bundles tests, helper scripts, workflow definitions, or local `.pi` state.
- Added the MIT `LICENSE` file and a tag-triggered GitHub Actions release workflow (`.github/workflows/release.yml`) that verifies the tag matches `package.json`, runs the full check and security audit suite, and publishes `@devspec/pi-plugin` to npm.

## 0.10.1 - 2026-10-27

- The tool catalogue is regenerated against DevSpec's current tools. Your agent is no longer asked how a commit's task tag came about, and the commit fields of recording work and linking a commit now say to leave the commit out: DevSpec picks it from what it saw, and naming one by hand is the fallback. Update with `pi update --extensions`, then restart Pi.

## 0.10.0 - 2026-10-27

- Full commit tracking now works on native Windows too. When Pi runs in Git Bash, which comes with Git for Windows and is Pi's default shell there, it sees every commit the agent makes, reports it to DevSpec, and adds the claimed task's tag to it, just as on macOS and Linux. Paths with spaces and both Windows and Unix-style paths work. A Windows job in Pi's own test runs proves this on every change.
- Fixed: on macOS and Linux, when the temporary folder had a long path, Pi stopped seeing the agent's commits without saying so. It now sees them wherever the temporary folder is.
- Update with `pi update --extensions`, then restart Pi.

## 0.9.1 - 2026-10-27

- The README now says which setups get full commit tracking: macOS, Linux, or Windows through WSL. On native Windows, Pi does not see the agent's commits yet, so the agent adds the task tag to its commit messages itself and DevSpec links the commits to their tasks later.
- Where Pi cannot tag commits itself, on native Windows or before Pi has connected to DevSpec, it now tells the agent to write the task tag in every commit message, instead of saying Pi adds it. Update with `pi update --extensions`, then restart Pi.

## 0.9.0 - 2026-10-27

- When your agent has exactly one DevSpec task claimed, Pi now adds that task's tag to the agent's commit messages itself. The tag goes at the end of the first line, so the rest of the message, including a `Co-Authored-By:` line, is kept as written. This works for messages given with `-m`, multi-line messages written with a heredoc, and messages read from a file, whose file is never changed.
- Pi tags only commits in a repository that belongs to the task's project, either by its remote or by its project pin. It never replaces a tag that is already there, and it leaves amended, fixup, squash and reused-message commits alone. Commits in other repositories, such as test fixtures, are not touched.
- After each commit, Pi tells the agent whether it added the tag. When several tasks are claimed, Pi does not guess: it tells the agent to write the right tag itself. Pi never blocks a commit.
- Update with `pi update --extensions`, then restart Pi.

## 0.8.10 - 2026-10-27

- Your agent no longer copies a commit id when it records finished work. DevSpec uses the commit Pi saw it make, and the agent names a commit only when DevSpec says it found none, copying the id from Git rather than from memory.
- Pi keeps working when DevSpec adds to its rules for linking commits, and shows the agent the new rules exactly as DevSpec sends them. Update with `pi update --extensions`, then restart Pi.

## 0.8.9 - 2026-10-27

- When DevSpec sends Pi a notice about its own work while you are driving it from a DevSpec room, such as a confirmed finding or the outcome of a change, Pi's answer now appears in that room, marked as a reply to the DevSpec notice rather than to a person. It is your agent's final message from handling the notice, written to you briefly. It does not start, finish or interrupt any request you sent, and it does not change whether the agent shows as Working. When Pi is not in a room, the answer stays in the terminal as before.
- If DevSpec does not accept that reply, Pi says so in the terminal with DevSpec's reason instead of dropping it.
- Handling a notice no longer shows a false "assistant speech storage not confirmed" warning in the terminal.
- Pi's local copy of the room keeps which DevSpec notice a reply answers, with the notice's summary and records.
- The tool catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.
- The README and code comments use DevSpec's new settings page names: the personal settings page where you create or reveal your token is now **Agent setup**, and the project settings page for agent execution rules is now **Agent rules**. Pi's login messages link that page by URL and are unchanged.

## 0.8.8 - 2026-10-26

- Pi now shows its model everything DevSpec says back after a change: fields that were dropped before — what was not saved, warnings, what to do next, why a task is not done yet, companion-link errors, whether a sign-off counted — now arrive, and any field DevSpec adds later arrives without a Pi update. Only empty fields and values identical to what was just sent are left out, and the reply says which.
- Lists show every result DevSpec returned, help results arrive whole, and a result Pi does not recognise is shown in full instead of cut to a fixed size.
- Notices about the agent's own work (findings, outcomes of changes, rulings and requests to confirm, and write-quality corrections) are now handled the way each notice says, within what it allows, rather than only passed on.
- Guidance now matches the current rules: work waiting for an OK stays off the tracking branch until it has the OK, the agent reports where a task landed instead of always saying "implemented", and the edit reminder no longer suggests a thin task that DevSpec would refuse.
- Automatic memory recall brings in only agreed memories, says that the ranking is not a judgement of relevance, keeps each memory's state, delivery status and companions, and searches with the whole prompt.
- A notice from DevSpec with a long link or label is no longer rejected as unreadable.

## 0.8.7 - 2026-10-25

- Updated the README with step-by-step installation, sign-in, project selection, and command reference matching the in-app setup flow, and removed internal engineering notes from the published repository tree.

## 0.8.6 - 2026-10-25

- Updated task creation and editing guidance so task `intent` records synthesized rationale rather than conversational go-ahead quotes.

## 0.8.5 - 2026-10-25

- Your agent now sees when a task it worked on is not done yet because it is still on its way: waiting to merge, waiting for a deploy to carry it, or waiting for a database change to be applied. Task lists, and the replies after recording work, signing off or editing a task, show what DevSpec says the task waits for, such as which deployment has not carried it yet, a deploy that failed, or which database change has not been applied, so the agent no longer reports such a task as done. The tool catalogue is regenerated to match, and it puts back the guidance on what belongs in a task's description, acceptance criteria and instructions for the agent, which an earlier update had lost. Update with `pi update --extensions`, then restart Pi.

## 0.8.3 - 2026-10-23

- Security: updated two libraries the plugin depends on (zod and body-parser) to versions that fix newly published high-severity advisories. Nothing changes in how the plugin behaves. Update with `pi update --extensions`, then restart Pi.

## 0.8.2 - 2026-10-23

- Your agent is told that a task with commits only counts as done once those commits are merged into the repository's tracking branch. Until then it stays implemented, and DevSpec says it is waiting to merge. Signing off a task whose work hasn't merged yet records the sign-off, and the task finishes by itself when the merge lands. The tool catalogue is regenerated to match. Update with `pi update --extensions`, then restart Pi.

## 0.8.1 - 2026-10-23

- Your agent no longer writes plans, handoffs, status summaries or single decisions as DevSpec documents. A document is a standing guide, reference or runbook; a plan becomes a brief with tasks, a handoff or status goes on the task, and a decision is a memory. The tool catalogue is regenerated to match. Update with `pi update --extensions`, then restart Pi.
- Fixed: posting the live work trail of an automation run could fail with an error when the run had no connection to post through. It is now skipped, as any post without a connection is.

## 0.8.0 - 2026-10-22

- Native tools, argument/result readers and work projections use Tasks, with Feature, Improvement, Bug, Investigation and General categories.
- Regenerated the native tool catalogue to match DevSpec's Tasks tools and guidance.
- Versioned process-local advisory work and delivery caches for the updated task fields while preserving durable room history, speech delivery state and credentials. Update with `pi update --extensions`, then restart Pi.

## 0.7.5 - 2026-10-17

- Pi makes any decision you could make in DevSpec's Review for you as soon as your request is clear: accepting or declining a proposed change, answering on work that would undo a decision, saying a flagged record is still accurate, or settling a duplicate. It warns you once, up front, only if you seem unaware of a significant consequence, never asks you to confirm again, and tells you what happened and what you can do next. Update with `pi update --extensions`, then restart Pi.

## 0.7.4 - 2026-10-17

- Your agent can now accept or decline a change waiting in Review, under Proposed changes, when you ask it to and you could decide it yourself there. It applies exactly the version you saw, and tells you who can decide it when you can't.
- When your request is clear, your agent no longer asks you to confirm it again before changing team rules, your own instructions or an automation; it warns you once only when you don't seem aware of a significant consequence.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.7.3 - 2026-10-17

- Fixed: what DevSpec finds about your agent's own work now reaches the agent again: that a change would undo someone's decision, duplicates other work or breaks a requirement, and what happened to a change that was waiting on someone. Until now Pi told DevSpec it couldn't read these, so they went only to your notifications and the Agents page showed the agent as "Not receiving findings". Update with `pi update --extensions`, then restart Pi.

## 0.7.2 - 2026-10-17

- The catalogue is regenerated against DevSpec's current tools: the remote-control poll now describes the newer findings channel, and what DevSpec tells your person when an agent stops listening. Update with `pi update --extensions`, then restart Pi.

## 0.7.1 - 2026-10-16

- When your agent can tell from the conversation that someone else agrees to an answer on a decision, it can now ask them to confirm it themselves. Nothing is recorded until they do: the request waits for them in Review and their notifications, and they can confirm or decline it there with no agent running. If your agent is still connected, it is told how it was decided.
- When DevSpec can't tell who asked for an answer or a sign-off, it is saved for you to confirm in Review instead of being refused.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.7.0 - 2026-10-16

- Pi now tells DevSpec which plugin and version it is on every request. DevSpec uses this to know your agent has the plugin, which remote control, taking part in sessions and automations need.
- When you connect in a project whose repositories are on GitHub and your GitHub account isn't linked yet, Pi shows you the link. Linking is one click through DevSpec's GitHub App: GitHub confirms who you are, and DevSpec keeps no access to your account.
- Work that waits for someone's OK, and experiments, now say so wherever the agent sees them, including in the confirmation after an edit and in lists, so it keeps that work on its own branch.
- A change that is waiting for review now says who it waits on, as DevSpec reports it, instead of always saying a maintainer.
- The tags DevSpec adds to a new action item now reach the agent, so it can correct them.
- Requirements are labelled as requirements in search results.
- Findings and the outcome of an edit that DevSpec sends the agent are introduced for what they are, with each record shown whole. A notice this version can't read no longer stops the others arriving.
- While a project is paused, the notice DevSpec adds to each result reaches the agent in full, and the result itself still shows normally.
- If DevSpec couldn't be told whose request a change served, the agent is now told, so it can let that person know.
- `/devspec.conflicts` is now `/devspec.review`.
- The agent's guidance now follows how DevSpec records decisions: only when a real choice was made for a reason that matters beyond this change, and only once you've said it was deliberate.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.9 - 2026-10-16

- Creating an action item now needs its intent: why the work matters, the problem it solves and the outcome wanted. DevSpec uses it to check later work against, so a create without one is refused and nothing is created.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.8 - 2026-10-16

- Work that would undo someone else's decision now waits for an OK instead of being held. You can still claim it and build it on its own branch; it doesn't merge or finish until someone who can give the OK answers: go ahead, no (with a reason), or "this doesn't undo my decision". If it reached the tracking branch anyway, they choose to keep it or undo it.
- Experiments are the same: try something on its own branch, then ask for it to land.
- Review can be filtered by where a question stands: waiting for an OK, answered no, landed without its OK, being put back, or settled.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.7 - 2026-10-16

- Creating or editing an action item no longer shows the agent a list of possibly related items to sort through before it can go on. DevSpec now checks for duplicates itself after the write and only tells anyone about a confirmed one.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.6 - 2026-10-15

- When you ask an agent to accept, decline or otherwise settle a question about a protected decision, it acts as you, with your authority, on the request you gave it. A message someone else wrote can no longer be used to act in their name, and a settlement two people agreed is recorded for one of them, from the conversation where they agreed.
- Pi can now preview and resolve duplicate records, and record that two records are not duplicates.
- Review can be filtered by what waits on you, what you raised, what involves you or others, what you can resolve, its state, a person and a record type.
- Action items can be created as experiments on their own branch.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.4 - 2026-10-13

- DevSpec sign-in now reads your name from the verification response's identity fields instead of mistaking a JSON fragment for your name. If no name is available, sign-in and status still clearly confirm the connection without one.
- Existing login commands, token storage and normal terminal output are unchanged. Reload or restart Pi after updating to load the fix.

## 0.6.3 - 2026-10-12

- Editing someone else's decision, convention or ADR now follows whose record it is. Your own records, descriptive ones, and records owned by someone at your role or below change straight away, and the owner is told. A record owned by someone with more authority keeps its current wording, and your change waits beside it as a pending version, naming who it waits on.
- A decision can name the action item that delivers it. It then reads "Decided, not yet implemented" until that item is implemented.
- Reading a memory says how to open any earlier version in full and shows changes still waiting for approval separately from the agreed wording.
- The catalogue is regenerated against DevSpec's current tools. Update with `pi update --extensions`, then restart Pi.

## 0.6.2 - 2026-10-12

- Refresh the native wire catalogue for record-owned intent questions and explicit adoption/co-owner choices. Keep ownership receipts lossless, including the actor, question revision and scope.
- Review can filter action-item intent alongside memories and documents; reversal questions are not accuracy flags. Authority remains with the served contract. Reload existing sessions to load the new native tools.

## 0.6.1 - 2026-10-11

- Pi's DevSpec tools are updated to match DevSpec. When DevSpec can't tell whose request a change serves, it no longer turns the change away. A record of work is saved with the requester unknown, and anything else waits for someone to confirm it.

## 0.6.0

- Work Pi does after something it started finishes (a background job, a subagent, or the answer to a question it asked) is now credited to whoever asked for that work in the first place, not to whoever spoke to Pi most recently.
- When two people's requests reach the same Pi, what it records for each is kept apart. If one stretch of work carries requests from more than one person (or from you at the terminal and you in a room), Pi names which request a DevSpec change, or background work it starts, serves before making it, rather than guessing.
- Only what you type at Pi's terminal is shown in the room as your prompt and counted as your request. Automation runs, finished background jobs and DevSpec's own notices no longer are.
- Work Pi does for an automation run is recorded as that automation's, even while someone's message to Pi is still open.
- Work Pi starts on its own, with nobody's request behind it, is recorded as Pi's own initiative only when Pi knows that for certain; otherwise DevSpec works out who asked, as before.
- The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.22

- DevSpec no longer checks action items for going out of date, so Pi no longer offers filtering items by that flag, and the review queue lists only memories and documents.
- The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.21

- DevSpec's trial that asked the agent to judge which existing items its own change affected has ended. Pi no longer offers its two tools or keeps its request in what the model sees.
- The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.20

- Recording that one action item replaces another is now its own action, `supersede_action_item`: name the replacing item and the one it replaces. `preview_supersession` shows first what would close and when, and whether it would be recorded or wait for a Maintainer. One that waits shows as proposed in the session's activity. A link between two items no longer retires either.
- DevSpec no longer checks pairs of action items, memories or documents for conflicts, so Pi no longer offers rulings on conflicting items or on an item that contradicts a decision, and a claim never waits on such a check. The review queue holds out-of-date flags and proposals; rule a memory or document still accurate with `resolve_memory_flag` or `resolve_resource_flag`.
- Recording a memory or document no longer stops on a close match, so `confirm_new` is gone.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.19

- New: you can clear this Pi's conversation from DevSpec. Use Clear conversation in its agent controls, or type `/clear` to it. Pi starts afresh and stays connected to the same DevSpec session; the old conversation stays in Pi's history, reachable with `/tree`. If Pi is in the middle of a reply, it clears when the reply ends.
- After a clear, or moving to another branch with `/tree`, Pi is given its DevSpec instructions, project facts and room orientation again on its next turn.
- Pi now tells DevSpec which controls it carries out, so DevSpec offers Clear only to a Pi that has it.
- The catalogue is regenerated against DevSpec's current agent tools, which know the clear control.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.18

- The catalogue is regenerated against DevSpec's current automation tools. Creating or changing an automation now takes `run_for`: `project` when one run covers everyone (a failed deploy, a merged branch), or `each_person` when everyone runs it for themselves on their own agents and their own schedule (cleaning up their machine, updating their tools). `switched_on` applies to automations for the project only.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.17

- The catalogue is regenerated against DevSpec's current automation tools: they now say that Contributors and Maintainers run automations, and that a Contributor who didn't create one can still run it but not change it.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.16

- The catalogue is regenerated against DevSpec's current automation tools. Every automation now belongs to the project, so creating one no longer takes `visibility`. Creating one takes `switched_on`: whether it can go to your agents when it starts by itself (on unless you say otherwise), and changing one takes `runs_by_itself` to pause or resume everything that starts it by itself, in place of `enabled`. Only an automation's creator or a Maintainer can change it.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.15

- The catalogue is regenerated against DevSpec's current tools. The searches (action items, memories, documents, sessions, Still to Discuss, the review queue and tool search) now accept `work_claim_ref`: while you hold several claims and no request is open, name the claim a search is for, and its cost is recorded against whoever asked for that work rather than against you.
- Reporting an automation run now asks for a short plain-English summary, with the technical detail in the output.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.14

- Pi's MCP client library (`@modelcontextprotocol/sdk`) is updated to 1.32.1, past the versions that dependency scanners report for advisory GHSA-6qxp-vccf-f47h. Pi was not exposed to it: it signs in with its own DevSpec token and never uses the library's sign-in flow that the advisory is about. `proxy-addr`, which the same library brings in, moves to 2.0.8 for the same reason.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.13

- The catalogue is regenerated against DevSpec's current tools. Editing an action item, splitting one out of its brief, reopening one, ruling on a flagged pair or a decision flag, writing team rules and creating, changing or deleting automations now accept `work_claim_ref`: while you hold several claims and no request is open, name the claim the change serves instead of being refused. Previewing a ruling on a flagged pair takes the same references, so it shows the ruling as it will be judged.
- Pi already sends your project and connection with each call. DevSpec now uses them only on the tools that declare them, which are the tools where they change the result.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.12

- Changing model in DevSpec now returns the complete list this Pi can use, including models previously missing beyond the first 400.
- Agent control results are saved in Pi's session journal and retried when delivery fails, without executing the control again. Acknowledging a result no longer consumes queued messages or notices. Delivery failures are reported instead of disappearing silently.
- Requires the matching DevSpec server update. Update with `pi update --extensions`, then restart Pi.

## 0.5.11

- Tool search now compares the same catalogue as DevSpec, so keeping internal tools private no longer forces a keyword-only fallback. Internal connection and posting tools remain unavailable to the model. When meaning-based search cannot run, Pi now distinguishes an extension/server version difference, an index being refreshed, unavailable ranking, an unreadable response and a connection failure. Known tools still work directly.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.10

- The catalogue is regenerated against DevSpec's current tools. One parameter description is shorter: `work_claim_ref` now says that when you leave it out, DevSpec works out who asked from your connection and refuses when it cannot tell. Such a refusal now names only what the tool you called accepts.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.9

- When Pi records finished work or a decision in DevSpec, DevSpec may ask which existing action items that change affects. Pi now shows that request whole, offers the two tools that answer it (`assess_change_impact`, then `record_change_impact`), shows every item DevSpec puts forward, and shows exactly what to fix if an answer is refused. Nothing in your project changes because of the answers. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.8

- Searching a project's database schema can now be narrowed to one database: give `get_database_schema` a `query` and a `database`, and it searches only that database. A database the project doesn't have is refused, with the list of the ones it has. When a project has several databases, each result names the one it came from, and every result says whether it was read from the database itself or declared in your code (a MongoDB collection comes from your models). The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.7

- Pi can keep working in DevSpec between your commands while it holds several pieces of work at once: it can answer in its room, claim the next item it reserved, and record notes and criterion checks on an item it just finished. DevSpec used to refuse those because it could not tell who had asked. The tools that note, link or check an item now also take the claim or command they are for, for the rare case DevSpec cannot work that out. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

## 0.5.6

- A note Pi leaves on a DevSpec action item now says which Pi wrote it, not only whose account, so two of your agents working the same item are told apart on the item. Pi already sends its connection with every note; DevSpec now records it. The catalogue is regenerated against DevSpec's current tools.
- Update with `pi update --extensions`, then restart Pi.

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

Ordinary assistant speech now posts on the server's append-only v2 lane: the extension sends your
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
omit. Catalog regenerated for the new wording.


### Working stops lying when the tracker wedges

Pi now sends an opaque progress marker with every working-lease beat (the poll
tick and the heartbeat): a plain count of the session events this process has
seen — turns, messages, tool calls, their streaming updates. Paired with the
DevSpec server change, a lease
renews only while that marker keeps changing. If the extension ever wedges
and the turn tracker freezes while idle, the marker freezes with it,
the server declines renewal after its staleness bound, and the attempt expires
through the ordinary lease path instead of lying.

Nothing changes when work is genuinely flowing: every turn, message, tool event
and streaming update moves the marker, so long quiet stretches inside a real
turn (a big build, a slow test suite) keep Working exactly as before. Hosts and
builds that never send a marker get the legacy behaviour untouched.


### The write check tells you which document it matched, on either corpus

DevSpec stops a knowledge write when something close already exists, and the
reply names the record it matched so you can go and read it. Pi previously described that
as a memory-only check; the server now returns matches across both memories and documents.

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
