# Claude Terminal — Design Spec

**Date:** 2026-08-05
**Status:** Approved design, pre-implementation
**Working name:** Claude Terminal (rename freely later)

## What this is

A dedicated macOS desktop app — an IDE-like cockpit — for running and managing
multiple Claude Code sessions. Left sidebar lists named sessions with live
status; the main pane shows the active session's terminal. Keyboard shortcuts
switch between sessions instantly.

It is **not** a general-purpose terminal. Every pane exists to run `claude`.
Regular shell work stays in the user's normal terminal.

## Goals (from brainstorming)

1. **Fast switching + naming** — sessions have user-given names, live in a
   sidebar, and are one keystroke away.
2. **Status at a glance** — see which sessions are working, which are waiting
   for input, and which are done, without visiting each one.
3. **Notifications** — OS notification + dock badge when a background session
   needs attention.

Non-goals for v1: cross-platform support, tabs/splits, session survival across
app restarts (a daemon/tmux), theming/config UI, multi-window.

**Audience:** the author's own machine (macOS) first; polish and portability
only if the tool proves out.

## Stack decision

**Electron + React + xterm.js + node-pty.** This is the Hyper.js stack without
Hyper: xterm.js is the terminal renderer VS Code uses (handles Claude Code's
TUI fine), node-pty provides the PTYs, and the sidebar is plain web UI.

Rejected alternatives:

- **Hyper.js fork/plugin** — Hyper is in maintenance mode and its plugin API
  decorates its own tab/pane model; it cannot cleanly express a managed
  session sidebar with lifecycle control and hook injection.
- **Tauri 2** — lighter footprint, but Rust-side PTY/IPC plumbing slows the
  path to a usable tool with no benefit that matters here.
- **tmux-based TUI** (claude-squad style) — cannot deliver the IDE-like GUI,
  native notifications, or dock badges.

## Architecture

Three layers in one Electron app. No daemon, no tmux, one window.

```
┌─────────────────────────────────────────────────┐
│ Renderer (React)                                │
│  Sidebar (sessions, status dots, badges)        │
│  Terminal area (one xterm.js per session;       │
│  inactive ones hidden via CSS, never unmounted) │
└───────────────────────┬─────────────────────────┘
                        │ IPC (typed channels)
┌───────────────────────┴─────────────────────────┐
│ Main process                                    │
│  SessionManager — node-pty lifecycle, state     │
│  HookServer   — local HTTP listener for hooks   │
│  Store        — sessions.json persistence       │
└─────────────────────────────────────────────────┘
```

### SessionManager (main process)

- Owns all sessions: `{ id, name, cwd, claudeSessionId, status, order }`.
- Creates a session by spawning `claude --settings <generated-settings.json>`
  in the chosen cwd via node-pty.
- Streams PTY output to the renderer over IPC; forwards renderer keystrokes
  to the PTY. All PTYs stay alive regardless of which session is visible —
  background sessions keep working.
- Emits state changes to the renderer (single source of truth for status).

### HookServer (main process)

- A minimal local HTTP listener on an **ephemeral port chosen at each app
  launch**.
- Each session spawn regenerates that session's settings file so its hooks
  point at the live port (no stale-port problem).
- Injected hooks (merged on top of the user's own `~/.claude` settings by
  Claude Code's normal settings layering — user config is untouched):
  - `SessionStart` — reports the real Claude session ID (enables `--resume`
    without output parsing).
  - `UserPromptSubmit` — session is **working**.
  - `Notification` — session **needs you** (permission request or idle
    waiting for input).
  - `Stop` — session is **idle/done**.
- Hooks call the server via `curl`, fire-and-forget. A failed hook call can
  never block Claude; worst case is a stale status dot.

### Store (main process)

- `sessions.json` in the app's userData dir: name, cwd, claudeSessionId,
  sidebar order.
- Written on every mutation; read once at launch.

### Renderer (React)

- Deliberately dumb: renders state pushed from main, sends user intents back.
- One xterm.js instance per session, mounted once and toggled with CSS
  `display`, so scrollback, selection, and TUI state survive switches with
  zero reflow cost.
- Keyboard-shortcut layer intercepts app chords (`Cmd+…`) **before** xterm.js
  consumes them; all other keys pass through, so Claude Code's own
  keybindings (Shift+Tab, Esc, …) work normally.

## Session lifecycle

**Create (`Cmd+N` or button):** prompt for name + working directory (the
cwds of existing/past sessions in `sessions.json` offered as recents, plus a
native directory picker) → write per-session settings file → spawn
`claude --settings …` in that cwd.

**Status model** — hook-driven, four states:

| State     | Trigger                                    | Sidebar UI              |
|-----------|--------------------------------------------|-------------------------|
| working   | Enter keystroke or `UserPromptSubmit` hook | spinner / orange dot    |
| needs you | `Notification` hook                        | red badge               |
| idle/done | `Stop` hook                                | green dot               |
| exited    | PTY process exit                           | gray + relaunch action  |

**Notifications:** when a **background** session transitions to *needs you*
or *idle/done*, fire a macOS notification ("«name» needs your input") and
update the dock badge (badge count = number of *needs-you* sessions). The
active session never notifies. Clicking a notification focuses the app and
switches to that session.

**Quit/relaunch:** quitting terminates PTYs gracefully. On launch the sidebar
is restored from `sessions.json`; every session shows **exited** until
activated, then spawns `claude --resume <claudeSessionId>` (lazy resume — no
process stampede at startup). Conversation context survives; in-flight work
does not.

**Close vs. remove:** `Cmd+W` closes (kills PTY, stays in sidebar,
resumable). Remove (context menu) deletes from sidebar and `sessions.json`,
with a confirmation.

## UI

- Fixed left sidebar (~240 px, collapsible with `Cmd+B`); terminal fills the
  rest. No tabs, no splits — the sidebar is the navigation.
- Sidebar row: status dot · session name · truncated cwd (`~/dev/api-server`)
  · subtle last-activity timestamp. Drag to reorder; double-click to rename.
- Right-click on a row opens a native context menu (added post-v1): Rename,
  Close (live) or Relaunch (exited), and Remove… with a native confirm dialog.
- Worktree sessions (added post-v1): when the chosen directory is a git repo,
  the New Session dialog offers "give this session its own isolated copy" —
  the app runs `git worktree add <repo>/.worktrees/<slug> -b <slug>` (branch =
  kebab-cased session name, uniqued on collision) and the session's cwd is the
  worktree. `.worktrees/` is registered in `.git/info/exclude` (never touches
  the user's .gitignore). Sidebar groups worktree sessions under a repo
  header, rows show `⎇ branch`; shortcuts follow the grouped visible order.
  Removing a worktree session always asks: delete copy & branch / delete copy,
  keep branch / cancel. Plain (non-worktree) sessions are unchanged.
- Embedded shell (added post-v1): `Cmd+T` toggles a split pane below the
  active Claude session running the user's login shell in that session's cwd,
  separated by a visible draggable divider (resizable 15–80% of the area,
  default 35%). One lazy shell per session; survives hidden-toggling and
  session switches; killed with its session or app quit; no persistence.
  When the shell exits (user types `exit`, or its session closes), the pane
  closes; the next `Cmd+T` opens a fresh shell. This narrows v1's "all shell
  work stays in the external terminal" stance to "quick verify-loop shell
  work can happen in-app".
- v1 styling minimal: one good monospace font, dark theme only.

### Keyboard shortcuts (hardcoded in v1)

| Shortcut                                | Action                                  |
|-----------------------------------------|-----------------------------------------|
| `Cmd+1`…`Cmd+9`                         | Jump to session by sidebar position     |
| `Cmd+J` / `Cmd+K`, `Cmd+Shift+]` / `[`  | Next / previous session                 |
| `Cmd+↓` / `Cmd+↑`                       | Next / previous session (added post-v1) |
| `Cmd+T`                                 | Toggle embedded shell pane (post-v1)    |
| `Cmd+N`                                 | New session                             |
| `Cmd+R`                                 | Rename current session                  |
| `Cmd+W`                                 | Close current session                   |
| `Cmd+E`                                 | Jump to oldest **needs-you** session    |
| `Cmd+B`                                 | Toggle sidebar                          |

## Error handling

- **`claude` not on PATH** → full-screen explanatory message with fix
  instructions, not a raw PTY error.
- **`--resume` fails** (expired/deleted session) → fall back to a fresh
  `claude` session in the same cwd; note the fallback in the pane.
- **Hook call failures** → silent by design; status may go stale but Claude
  is never blocked.
- **PTY crash** → session marked *exited* with a relaunch action; the app
  itself never goes down with a session.
- **Corrupt `sessions.json`** → move it aside as a backup, start with an
  empty sidebar, tell the user what happened.

## Testing

- **Vitest unit tests** for SessionManager state transitions and Store
  (node-pty and filesystem mocked) — the logic-heavy core.
- **HookServer** tested with real local HTTP requests.
- **Manual smoke checklist** for E2E (spawn real `claude`, hooks fire,
  resume works). Playwright/Electron E2E deliberately out of scope for v1.
