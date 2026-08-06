# Claude Terminal — manual smoke checklist

Run through this before declaring a build good. Prereq: `claude` installed and logged in.

## Session basics
- [ ] `npm run dev` opens the app with sidebar + empty state
- [ ] ⌘N opens dialog; create session "smoke-a" in a real repo dir
- [ ] Claude boots in the pane; typing + Enter gets a response
- [ ] Claude's TUI fills the whole pane width immediately — on create, after relaunch/resume, and without resizing the window first
- [ ] Dot: orange while working, green after response (Stop hook)
- [ ] Trigger a permission prompt (ask Claude to run a shell command); dot turns red (needs-you)
- [ ] Create "smoke-b"; ⌘1/⌘2, ⌘J/⌘K switch instantly; scrollback intact after switching
- [ ] Double-click rename works; drag reorder works; ⌘B toggles sidebar
- [ ] ⌘↑/⌘↓ switch sessions (same as ⌘K/⌘J)
- [ ] Right-click a row: Rename starts inline edit; Close appears for live sessions, Relaunch for exited; Remove… shows native confirm

## Worktree sessions
- [ ] In a git repo dir, the dialog shows the "isolated copy" checkbox (hidden for non-repo dirs)
- [ ] Creating with it checked: session runs in `<repo>/.worktrees/<branch>`; `git status` in the main repo stays clean
- [ ] Two worktree sessions on the same repo appear grouped under the repo header with ⎇ branch labels
- [ ] Both sessions can edit the same file without touching each other's copy
- [ ] Changes works for PLAIN repo sessions too: uncommitted files (incl. names with spaces, staged deletes) diff correctly; "Commits this session" lists commits made since the session started; no Merge/PR buttons in plain mode
- [ ] Removing (× or right-click) shows the 3-option dialog; "keep branch" leaves the branch in `git branch`; "delete" removes worktree + branch

## Embedded shell (⌘T / strip button)
- [ ] ⌘T (or the terminal strip icon) opens the Shell view in the right pane, cd'd to the session's directory (`pwd` to confirm)
- [ ] Shell keeps scrollback when the pane is toggled closed and reopened, and across session switches
- [ ] Each session gets its own shell; switching sessions switches shells; a session without one shows the "Open shell" button
- [ ] `exit` in the shell returns the pane to the "Open shell" button; opening again spawns fresh
- [ ] Closing/removing a session kills its shell
- [ ] ⌘E jumps to the needs-you session

## Heartbeat & lifecycle
- [ ] While a session works, its row shows the live tool (▸ Bash: …) and an amber ⚡ working timer
- [ ] Tool line clears when the response finishes; timer reverts to last-activity time
- [ ] Quitting with a working session shows the "still working" confirm; Cancel leaves it running
- [ ] After quitting with running sessions, next launch shows the "Resume all" banner; Resume all brings them back

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
