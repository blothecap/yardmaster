# Round-5 Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** (1) Live tool heartbeat on session rows, (2) lifecycle guards (quit protection + resume-on-launch), (3) universal Changes pane for all repo sessions.

**Architecture:** unchanged — hooks feed main; renderer renders. Follow existing patterns exactly: preload named-handler/unsubscribe, execFile-only git with 15s timeouts, TDD for main logic, manual/CDP smoke for renderer.

## Global Constraints

- Status/activity from hooks and git only; no output-scraping.
- New persisted SessionMeta fields must be optional with load-time normalization (old sessions.json must keep working).
- Env for npm commands: `export PATH="$HOME/.nvm/versions/node/v23.11.1/bin:$PATH"`.
- Dev smokes must kill ONLY the PIDs they start.

---

### Task 1: PreToolUse heartbeat (main, TDD)

**Files:** `src/shared/types.ts`, `src/main/session-manager.ts` (+test). NOTE: `src/main/settings-gen.ts` needs no change — it iterates `HOOK_EVENTS`; its test asserting the hook set auto-adapts (update the test's name/comment if it says "four").

**Interfaces:**
- `HookEvent` union + `HOOK_EVENTS` gain `'PreToolUse'` (settings file then injects it automatically; hook payload carries `tool_name` and `tool_input`).
- `SessionView` gains `currentTool: string | null` — non-null ONLY while status === 'working'.
- SessionManager behavior: on PreToolUse (live pty only, like other status hooks): build a label `"<tool_name>: <detail>"` where detail = first present of `tool_input.command` / `tool_input.file_path` / `tool_input.pattern` / `tool_input.url` (string, truncated to 60 chars), else just `tool_name`; store as runtime `lastTool`; DO NOT transition status (PreToolUse can fire in edge states; it only updates the label and lastActivityAt). `lastTool` clears on Stop, on UserPromptSubmit (new turn), and on exit. `list()` maps `currentTool = status === 'working' ? lastTool : null`. Non-string/absent fields → tool_name alone or null; never crash. Not persisted.
- emitChanged on PreToolUse so the renderer updates — but PreToolUse fires often; that's acceptable (changed events are cheap, no disk writes).

**Tests:** label built from command/file_path variants + truncation; visible only while working (Stop clears; UserPromptSubmit clears previous); dead-session PreToolUse ignored; garbage payload safe.

Commit: `feat: live tool heartbeat from PreToolUse hooks`

---

### Task 2: Heartbeat rendering + working timer (renderer)

**Files:** `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/app.css`.

- Row second-line priority becomes: needsYouMessage (red) → **currentTool** (`▸ Bash: npm test`, monospace, working-amber tint) → activity → worktree `⎇ branch`. Worktree sessions with a currentTool show `⎇ branch · ▸ tool…` single truncated line.
- The right-side time span: when status === 'working' show working duration derived from `statusChangedAt` (`⚡3m`, amber) instead of last-activity time; otherwise unchanged relative time. The existing 30s tick keeps both fresh. Durations < 60s show `⚡<1m`.
- Project panel untouched.

Commit: `feat: heartbeat line and working timer on session rows`

---

### Task 3: Lifecycle guards (main + renderer, TDD for manager bits)

**Files:** `src/main/index.ts`, `src/main/session-manager.ts` (+test), `src/shared/types.ts`, `src/renderer/src/App.tsx`, `src/preload/index.ts`, `app.css`.

**Quit guard (main):** in `before-quit`: if `manager.list()` has any `working` session and quit not yet confirmed — `event.preventDefault()`, async `dialog.showMessageBox` (`type: 'warning'`, buttons `['Quit Anyway', 'Cancel']`, defaultId 1, cancelId 1, message `"N session(s) are still working"`, detail explaining in-flight work is lost but conversations resume) — on 'Quit Anyway' set a `quitConfirmed` flag and call `app.quit()` again. Guard must not fire when nothing is working.

**Resume-on-launch:**
- `SessionMeta` gains optional `wasRunning?: boolean`.
- SessionManager: `disposeAll()` sets `meta.wasRunning = s.pty !== null` for every session and persists BEFORE killing ptys. Constructor: after load, collect ids where `wasRunning` was true into a `resumableIds: string[]` (exposed via new method `getResumableIds(): string[]`), then clear the flags in-memory (one-shot; next persist writes them cleared).
- Tests: disposeAll persists wasRunning true only for live sessions; constructor surfaces + clears; second construction sees none.
- IPC: `app:init` response gains `resumableIds: string[]` (`manager.getResumableIds()`).
- Renderer (App.tsx): when `init.resumableIds.length > 0`, show a dismissible banner at the top of the terminal area (style like the corrupt banner but accent-neutral): `"N sessions were running when Switchyard last quit — [Resume all] [Dismiss]"`. Resume all: `resumableIds.forEach(id => window.api.activate(id))` then dismiss. Banner state is local; no persistence.

Commit: `feat: quit guard and resume-on-launch for running sessions`

---

### Task 4: Universal Changes pane (main + renderer)

**Files:** `src/main/git-review.ts` (+test), `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/ReviewPane.tsx`, `src/renderer/src/App.tsx`, `app.css`.

**Main (`git-review.ts`), new functions (TDD, real temp repos):**
```ts
export async function uncommittedFiles(cwd: string): Promise<ChangedFile[]>
  // parse `git status --porcelain`: status letter (worktree column preferred; '??' → 'A' with untracked flag is fine as '?'), path (handle rename "a -> b" by taking b)
export async function uncommittedDiff(cwd: string, file: string): Promise<string>
  // tracked: git diff HEAD -- file ; untracked: git diff --no-index -- /dev/null file (exit code 1 is success-with-diff; tolerate)
export async function commitsSince(cwd: string, startCommit: string): Promise<string[]>
  // git log --oneline startCommit..HEAD → array of lines; bad/unknown startCommit → []
```
**Session-start baseline:** `SessionMeta` gains optional `startCommit?: string | null`. In the `sessions:create` IPC handler (already async): for non-worktree creates, `detectRepoRoot(cwd)` and if repo, capture `git rev-parse HEAD` (add tiny helper `headCommit(cwd)` in git-review, exported, TDD) and pass into `manager.create` — add optional `startCommit` param to `create()` stored on meta (normalize `?? null` on load). Worktree sessions keep using baseBranch (their startCommit is implicit).

**IPC rework (keep channel names):**
- `review:files` (id) now returns `{ ok: true, mode: 'worktree' | 'plain', branch: string | null, baseBranch?: string, files: ChangedFile[], commits: string[] } | { ok: false, error }`.
  - worktree session: existing `changedFiles` (committed vs base, with the uncommitted marker) + `commits` = `commitsSince(cwd, merge-base? no — keep: git log baseBranch..branch --oneline via new call or reuse commitsSince with baseBranch as start)`.
  - plain repo session: `uncommittedFiles` + `commits` = `commitsSince(cwd, meta.startCommit)` when startCommit set else [].
  - non-repo session: `{ ok: false, error: 'not a git repository' }`.
  - branch from `projectInfo`-style rev-parse (small helper reuse).
- `review:diff` ({id, file}): worktree → existing fileDiff; plain → uncommittedDiff.
- `review:merge` / `review:pr`: unchanged, but handler rejects plain sessions with a clear error (renderer hides the buttons anyway).

**Renderer (ReviewPane):** props become `{ sessionId, mode info fetched from review:files }` — simplest: keep current props optionalized (`branch?`, `baseBranch?`) and let the pane read mode/branch/commits from the `review:files` response. Header: worktree `⎇ branch → base`; plain `⎇ branch · uncommitted changes`. Body adds a slim "Commits this session" section (list of oneline strings, read-only) above the file list when `commits.length > 0`. Footer: Merge/Push+PR rendered ONLY in worktree mode (Remove always). App.tsx: the Changes strip button becomes enabled for ALL sessions (tooltip "Changes — diffs & session commits"); the pane itself shows the not-a-repo error state for non-repo sessions (right-pane-empty styling already exists); the render no longer requires `activeSession.worktree`.

Commit: `feat: universal Changes pane — uncommitted diffs and session commits for all repo sessions`

---

## Verification (controller)

1. typecheck; full suite (expect ≈135+); build.
2. CDP smokes: existing review smoke still passes (worktree mode); new plain-mode check — create plain session in scratch repo, dirty a file, `review:files` shows mode 'plain' + the file, `review:diff` returns hunk; commit in scratch repo → commits list non-empty (startCommit captured at create).
3. Heartbeat: hard to CDP (needs real tool call) — create session, send a prompt that runs a tool ("run `echo hi` with Bash"), poll list() for non-null currentTool while working. Best effort; unit tests are the contract.
4. Lifecycle: unit-tested; quit-guard dialog is manual (note in smoke checklist).
5. Update `docs/smoke-checklist.md` (heartbeat line, working timer, quit guard, resume banner, plain-session Changes).
6. Commit each task; push after batch; `npm run dist` + `cp -R release/mac-arm64/Switchyard.app /Applications/` so the installed app gets the batch; relaunch installed app.
