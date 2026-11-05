# DevSpec for Pi

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing `@devspecai/pi-plugin` connects Pi directly to your DevSpec projects — giving your agent durable project memory, structured task execution, automatic commit provenance, and live remote control from your phone or browser.

---

## Why DevSpec + Pi?

- **Shared team memory with automatic staleness screening** — Pi automatically recalls the architectural decisions, conventions, risks, and reference docs that apply to the code it's touching. When you record a new decision or land changes, DevSpec screens your project's records for conflicts, duplicates, and **Possibly outdated** guidance so your team's shared memory stays accurate.
- **Steer Pi live from your phone or the web** — In a linked or pinned repository, interactive Pi connects to DevSpec automatically and appears on your project's **Agents** page outside any session room (or run `/devspec.remote` on demand). Attach it to a room from [devspec.ai](https://devspec.ai) or with `/devspec.remote --session <id>` to chat from your phone or browser, collaborate with teammates, answer structured questions and polls, and track multi-phase execution plans in real time.
- **Tasks, observed verification, and automatic commit provenance** — Pick up tasks with full context (`/devspec.work`). When a single task is claimed in a linked project repository (including Git worktrees and Git Bash on Windows) or a `.devspec/project.json`-pinned folder, Pi tags your commits (`[devspec:<id>]`) automatically, links pull requests, and records observed verification evidence from commands and checks it actually ran against each acceptance criterion. (On native Windows outside WSL or Git Bash, Pi adds the task tag directly in its commit messages.)
- **Protected intent and GitHub pull-request holds** — DevSpec screens changes against your team's recorded decisions, requirements, and open tasks, holds reversals of someone else's decision and unagreed experiments on their own branch until approved, and publishes its pull-request check on GitHub to reflect pending checks and holds.
- **One native package** — Native DevSpec tools, authentication, project matching, commit tracking, and live remote control are all built in. No separate MCP server setup required.

---

## Quick Start

### 1. Install the package

```bash
pi install npm:@devspecai/pi-plugin
```

### 2. Sign in with your DevSpec token

Create a **Read & write** access token on your [Agent setup](https://app.devspec.ai/settings/agents) page, then inside `pi` run:

```text
/devspec.login dvs_your_token_here
```

Your token is stored locally (`~/.pi/agent/devspec/auth.json`) with owner-only permissions and works across all of your DevSpec projects.

### 3. Connect to your project

- **In a linked repository:** Start `pi` in any Git repository linked to your DevSpec project (or a folder pinned with `.devspec/project.json`). Interactive Pi matches the project and appears on your project's **Agents** page automatically (toggle startup auto-connect with `/devspec.remote auto on|off`).
- **Join a session room:** Attach your connected Pi terminal to a new or existing session room from [devspec.ai](https://devspec.ai), or run `/devspec.remote --session <id>` inside Pi (and `/devspec.remote stop` when you want to disconnect this conversation).
- **Switch or pin projects anywhere:** Run `/devspec.project` to inspect or change the active project for the current conversation or folder (or launch with `pi --devspec-project "Project Name"`).

Sitting idle on the **Agents** page uses no tokens — Pi runs only when you or an authorized teammate asks it to do something, when your project routes a check on a change for it to rule, or when an automation you opted into runs.

---

## Commands

You can ask Pi to do anything in DevSpec in plain English (*"Work on DevSpec task 4f2a"*, *"What did we decide about rate limiting?"*, *"Create a task for the webhook retry bug"*).

The package also adds these slash commands and launch flags:

| Command | What it does |
|---|---|
| `/devspec.login <token>` | Signs Pi in to DevSpec with your `dvs_…` access token. |
| `/devspec.logout` | Removes your stored DevSpec token from this machine. |
| `/devspec.status` | Shows your connection status, active user, project, and attached session room. |
| `/devspec.work [item]` | Lists open tasks in your project or claims a task by ID or title to start building. |
| `/devspec.help` | Shows a quick summary of DevSpec commands inside Pi. |
| `/devspec.remote` | Connects this Pi conversation to DevSpec and waits on the **Agents** page outside any session room. |
| `/devspec.remote --project "<name>"` | Connects to a specific project for this conversation without changing the folder default. |
| `/devspec.remote --session <id>` | Connects (or attaches an already-connected Pi terminal) to a specific DevSpec session room (`-s <id>`). |
| `/devspec.remote stop` | Disconnects this Pi conversation from DevSpec (`off` or `end`) while leaving other terminals running. |
| `/devspec.remote reconnect` | Retries a troubled DevSpec connection immediately (`retry`). |
| `/devspec.remote auto [on\|off]` | Shows or toggles automatic connection when interactive Pi starts. |
| `/devspec.remote preempt [on\|off]` | Shows or toggles whether a new message from you interrupts Pi mid-turn (`on`) or queues until the turn finishes (`off`). |
| `/devspec.project` | Opens the project selector (`status`, `choose`, `remember`, or `forget`). |
| `pi --devspec-project "<name>"` | Starts `pi` bound to a specific DevSpec project by name or ID for that terminal session. |
| `/devspec.pin <project-uuid>` | Pins the current folder to a DevSpec project via `.devspec/project.json`. |
| `/devspec.reload` | Reloads DevSpec extensions and skills in the current Pi session. |
| `/devspec.review` | Reviews local changes against your project's recorded decisions and conventions. |

---

## Updating

To update the package to the latest release:

```bash
pi update npm:@devspecai/pi-plugin
```

Then run `/reload` (or `/devspec.reload`) or restart `pi`.

---

## Learn More

- **Web & Sign Up:** [devspec.ai](https://devspec.ai)
- **App & Agent Setup:** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
