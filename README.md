# DevSpec for Pi

**Build on your team's best thinking.** [DevSpec](https://devspec.ai) is where your team, your shared knowledge, and your coding agents build software together.

Installing `@devspecai/pi-plugin` connects Pi directly to your DevSpec projects — giving your agent durable project memory, structured task execution, automatic commit provenance, and live remote control from your phone or browser.

---

## Why DevSpec + Pi?

- **Shared team memory that never goes stale** — Pi automatically recalls the architectural decisions, conventions, risks, and reference docs that apply to the code it's touching. When you make a new decision together, Pi records it to DevSpec so every teammate and every agent stays aligned.
- **Steer Pi live from your phone or the web** — Attach any Pi terminal to a DevSpec session room (`/devspec.remote`). Chat with your running agent from [devspec.ai](https://devspec.ai), collaborate with teammates in shared rooms, answer structured agent questions and polls, and track multi-phase execution plans in real time.
- **Tasks, criteria, and automatic commit provenance** — Pick up tasks with full context (`/devspec.work`). While a task is claimed, Pi automatically tags your commits (`[devspec:<id>]`), links pull requests, and records test evidence against each acceptance criterion.
- **Protected intent** — DevSpec screens changes against your team's recorded decisions and requirements, catching accidental reversals or duplicate work before it lands.
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

- **In a linked repository:** Start `pi` in any Git repository linked to your DevSpec project. Pi matches the repository to your project automatically.
- **Connect for remote control:** Run `/devspec.remote` to put this Pi session live on your project's **Agents** page and attach it to a session room.
- **Switch or pin projects anywhere:** Run `/devspec.project` to inspect or change the active project for the current conversation or folder (or launch with `pi --devspec-project "Project Name"`).

---

## Commands

You can ask Pi to do anything in DevSpec in plain English (*"Work on DevSpec task 4f2a"*, *"What did we decide about rate limiting?"*, *"Create a task for the webhook retry bug"*).

The package also adds these slash commands inside Pi:

| Command | What it does |
|---|---|
| `/devspec.login <token>` | Signs Pi in to DevSpec with your `dvs_…` access token. |
| `/devspec.logout` | Removes your stored DevSpec token from this machine. |
| `/devspec.status` | Shows your connection status, active user, project, and attached session room. |
| `/devspec.remote` | Connects this Pi conversation to DevSpec for live remote control from the web or phone. |
| `/devspec.remote --new` | Connects and starts a fresh shared session room (`--new --private` for a private room). |
| `/devspec.remote --session <id>` | Connects and joins a specific DevSpec session room. |
| `/devspec.remote --project "<name>"` | Connects to a specific project for this conversation without changing the folder default. |
| `/devspec.remote --name "Night Owl"` | Connects using a custom agent codename. |
| `/devspec.remote-stop` | Disconnects this Pi conversation from DevSpec while leaving other terminals running. |
| `/devspec.work` | Lists open tasks in your project or claims a task by ID or title to start building. |
| `/devspec.project` | Opens the project selector (`status`, `choose`, `remember`, or `forget`). |
| `/devspec.pin <project-uuid>` | Pins the current folder to a DevSpec project via `.devspec/project.json`. |

---

## Learn More

- **Web & Sign Up:** [devspec.ai](https://devspec.ai)
- **App & Agent Setup:** [app.devspec.ai/settings/agents](https://app.devspec.ai/settings/agents)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
