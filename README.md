# DevSpec for Pi

Connect the [Pi](https://pi.dev) coding agent to [DevSpec](https://devspec.ai) with a single native package. Once installed and signed in, Pi connects to your DevSpec project automatically when you start it in a repository linked to that project, appears on your project's **Agents** page, works from your tasks, decisions, and documents, and can be steered live from your phone or the web.

## Requirements

- [Pi](https://pi.dev) 1.0 or later
- Node.js 22.19 or later

## Setup

### 1. Install Pi

On macOS and Linux:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows PowerShell:

```powershell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

### 2. Install the DevSpec package

Install the DevSpec package at user level (without `-l`) so every folder has DevSpec:

```bash
pi install git:github.com/DevSpecAI/DevSpec-Pi
```

This package provides native DevSpec tools, authentication, project selection, and remote control. No separate DevSpec MCP server entry is needed. (If you previously added DevSpec to Pi's `/mcp` settings, the package disables that duplicate entry so its tools aren't loaded twice.)

**Optional recommended extensions** (delegated subagents and web search):

```bash
pi install npm:pi-subagents
pi install npm:pi-exa
```

### 3. Sign in with your DevSpec token

Create an access token with **Read & write** access on your [Agents settings](https://app.devspec.ai/settings/agents) page, then start `pi` and run:

```text
/devspec.login dvs_your_token_here
```

Your token is saved locally (`~/.devspec/auth.json`) with owner-only permissions and works across all of your DevSpec projects.

### 4. Start Pi and connect to your project

- **Inside a linked repository:** Start `pi` in the folder where you cloned the Git repository linked to your DevSpec project. Pi matches the repository to your project automatically and appears on the project's **Agents** page.
- **In any other folder, or when switching projects:** Start `pi` and run `/devspec.project` to choose which project this conversation belongs to (or launch with `pi --devspec-project "Client Website"`).

## Commands

Everything in DevSpec can be asked in plain words ("Work on DevSpec task 4f2a", "What did we decide about caching?", "Create a task for the login redirect bug"). The package also adds these slash commands in Pi:

| Command | What it does |
|---|---|
| `/devspec.login <token>` | Signs Pi in to DevSpec with your `dvs_…` access token. |
| `/devspec.logout` | Removes the stored token from this computer. |
| `/devspec.status` | Shows whether you're connected, as whom, and to which project and session. |
| `/devspec.project` | Opens the project menu to inspect or change the project for this conversation or folder. |
| `/devspec.remote` | Connects this conversation to DevSpec (or pass `--project`, `--session <id>`, `--new`, `--new --private`, or `--name "…"`). |
| `/devspec.remote-stop` | Disconnects this Pi conversation from DevSpec while leaving other terminals running. |
| `/devspec.work` | Lists open tasks or claims a specific task by ID or title to start working on it. |
| `/devspec.pin <project-uuid>` | Writes `.devspec/project.json` in the current folder to pin it to that project. |

## Choosing and remembering a project

When a repository belongs to more than one DevSpec project, or you start Pi in a folder without a Git remote, Pi prompts you to pick from your accessible projects.

You can also target a project directly:

```text
pi --devspec-project "Client Website"
/devspec.remote --project "Client Website"
/devspec.remote --project <project-id> --session <session-id>
```

Use `/devspec.project` to manage the current conversation's project and folder default:

- `/devspec.project status` shows the selected project, organization, full project ID, how it was selected, and any folder default.
- `/devspec.project choose` selects a project for this conversation. Switching away from a project you have already been working in starts a fresh local conversation so context from one project never leaks into another.
- `/devspec.project remember` saves the current project to `.devspec/project.json` in the folder after showing the file path and asking for confirmation.
- `/devspec.project forget` removes the `.devspec/project.json` folder default after confirmation without disconnecting active conversations.

## Updating

To update the package to the latest version, run:

```bash
pi update
```

Then restart any open `pi` sessions so the updated package is loaded.
