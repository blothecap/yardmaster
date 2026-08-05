# Claude Terminal — manual smoke checklist

Run through this before declaring a build good. Prereq: `claude` installed and logged in.

## Session basics
- [ ] `npm run dev` opens the app with sidebar + empty state
- [ ] ⌘N opens dialog; create session "smoke-a" in a real repo dir
- [ ] Claude boots in the pane; typing + Enter gets a response
- [ ] Dot: orange while working, green after response (Stop hook)
- [ ] Trigger a permission prompt (ask Claude to run a shell command); dot turns red (needs-you)
- [ ] Create "smoke-b"; ⌘1/⌘2, ⌘J/⌘K switch instantly; scrollback intact after switching
- [ ] Double-click rename works; drag reorder works; ⌘B toggles sidebar
- [ ] ⌘↑/⌘↓ switch sessions (same as ⌘K/⌘J)
- [ ] Right-click a row: Rename starts inline edit; Close appears for live sessions, Relaunch for exited; Remove… shows native confirm

## Embedded shell (⌘T)
- [ ] ⌘T opens a shell pane below the Claude pane, cd'd to the session's directory (`pwd` to confirm)
- [ ] Shell keeps scrollback when hidden (⌘T ⌘T) and across session switches
- [ ] Each session gets its own shell; switching sessions switches shells
- [ ] `exit` in the shell shows the "shell exited" note; ⌘T (or click) restarts it
- [ ] Closing/removing a session kills its shell
- [ ] ⌘E jumps to the needs-you session

## Notifications
- [ ] Long task in A, switch to B → notification on A's completion; click focuses A
- [ ] Dock badge counts needs-you sessions; clears when handled

## Lifecycle
- [ ] ⌘W closes active session → gray dot + Relaunch overlay
- [ ] Relaunch resumes the same conversation (asks Claude "what did I ask before?" to confirm)
- [ ] Quit app, relaunch: sessions listed gray; clicking one resumes its conversation
- [ ] Remove (×) asks confirm and deletes; survives relaunch (stays gone)

## Error paths
- [ ] Corrupt `~/Library/Application Support/claude-terminal/sessions.json` (write garbage) → app opens with banner naming the backup file, empty sidebar
- [ ] Session with a deleted/expired claude session id: relaunch falls back to a fresh session with the "[claude-terminal] resume failed" note in the pane
