<p align="center">
  <img src="assets/icon.png" width="128" alt="Switchyard" />
</p>

<h1 align="center">Switchyard</h1>

<p align="center">A cockpit for running and managing multiple Claude Code sessions.<br/>
Sessions as tracks, worktrees as sidings, you in the control tower.</p>

---

Most devs run several Claude Code sessions at once with no good way to manage them.
Switchyard is a dedicated macOS app that gives them an IDE-like home: named sessions
grouped by project in a sidebar, live status you can trust, and the tooling to run
truly parallel agents on one repo without them stomping each other.

## Features

- **Sessions sidebar** — named sessions grouped under their project, with live status
  dots driven by Claude Code **hooks** (never output-scraping): working / needs-you /
  idle / exited. Collapsible groups, drag reorder, per-row activity line and token cost.
- **Waiting-on-you inbox** (`⌘E`) — every blocked session with the exact question it's
  asking; jump to it, or **approve/deny right from the list**.
- **Worktree sessions** — give a session its own isolated git worktree
  (`repo/.worktrees/<branch>`); run several Claudes on one repo in parallel. The
  **Changes pane** shows each worktree's diff vs its base branch with one-click
  **merge** (guarded, conflict-safe) or **push + PR** (via `gh`).
- **Per-session shell** (`⌘T`) — your login shell in the session's directory, in a
  right pane; scrollback survives pane switches and UI reloads via a replay buffer.
- **Notifications** — macOS notification + dock badge when a background session
  finishes or needs input; idle reminders are filtered out so red always means red.
- **Session persistence** — sessions survive app restarts and resume their
  conversations via `claude --resume`; per-session Claude CLI flags
  (e.g. `--model opus`) persist with them.
- **Project panel** — the active project's branch, dirty-file count, commits ahead of
  base, and session details, always visible at the bottom of the sidebar.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New session (project pre-fillable from a group header's `+` / `⎇` buttons) |
| `⌘1…9` | Jump to session by position |
| `⌘J` / `⌘K`, `⌘↓` / `⌘↑`, `⌘⇧]` / `⌘⇧[` | Next / previous session |
| `⌘E` | Waiting-on-you inbox (`a` approve / `d` deny oldest) |
| `⌘T` | Shell pane for the active session |
| `⌘R` | Rename session |
| `⌘W` | Close session (stays resumable) |
| `⌘B` | Toggle sidebar |

## Running it

Requirements: macOS, [Claude Code](https://claude.com/claude-code) installed and
logged in, Node ≥ 23.11 (see `.nvmrc`), Xcode CLT (for the node-pty native build).

```sh
nvm use                      # Node 23.11+ — older Node breaks Electron's installer
npx -y npm@11 install        # npm 10.9 has an arborist bug on this tree; use npm 1
npm run dev                  # development
npm run dist                 # build release/mac-arm64/Switchyard.app (unsigned, local use)
```

To install: `cp -R release/mac-arm64/Switchyard.app /Applications/`. The app
single-instance-locks, so close a dev instance before launching the packaged one.

Quality gates: `npm test` (120+ Vitest tests — the state machine, git/worktree
operations, and persistence are tested against real ptys-fakes and real temp git
repos), `npm run typecheck`, and `docs/smoke-checklist.md` for the manual pass.

## How it works

Electron, three layers. The **main process** owns everything: a `SessionManager`
state machine over node-pty processes, a loopback **hook server** that injected
Claude Code hooks (`SessionStart` / `UserPromptSubmit` / `Notification` / `Stop`)
call via per-session `--settings` files — which is how status is *known* rather
than guessed — plus git/worktree/review modules and atomic `sessions.json`
persistence. The **renderer** is a dumb React UI over xterm.js panes (one per
session, kept alive across switches). A typed `window.api` contextBridge is the
only seam between them.

The design/spec history lives in `docs/superpowers/` — the app was built
spec-first with per-task adversarial review.
