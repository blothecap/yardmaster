# Usefulness Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Four upgrades: (1) review & merge pane for worktree sessions, (2) waiting-on-you inbox fed by real hook payloads, (3) live activity lines on sidebar rows, (4) hardening batch from the final review.

**Architecture:** unchanged — main owns state (SessionManager + new git-review module), renderer renders. New IPC channels follow the existing preload pattern (named handler + unsubscribe).

**Tech stack:** as existing. Node ≥23 via .nvmrc; `npx -y npm@11` for installs.

## Global Constraints

- Status/activity data comes from hooks and git commands — never from parsing terminal output.
- Renderer stays dumb: all git operations and state in main; renderer sends intents via `window.api`.
- Every listener added to preload returns an unsubscribe; App effects clean up.
- Vitest for main-process logic (real git repos in temp dirs for git code, fakes for ptys); renderer via manual smoke + CDP where feasible.
- Never touch the user's `~/.claude` config or repo `.gitignore`.
- All git subprocess calls: `execFile('git', ...)` with timeout, never shell interpolation of user strings.

---

### Task 1: Hook payload capture — needs-you message + activity line (main)

**Files:** modify `src/main/session-manager.ts`, `src/shared/types.ts`; test `src/main/session-manager.test.ts` (extend).

**Interfaces produced:**
- `SessionView` gains `activity: string | null` and `needsYouMessage: string | null`.
- Behavior: `handleHookEvent('UserPromptSubmit', payload)` stores `payload.prompt` (string, truncated to 120 chars) as the session's `lastPrompt`; `handleHookEvent('Notification', payload)` stores `payload.message` (string, truncated to 200) as `pendingMessage`. `pendingMessage` clears on any transition OUT of `needs-you` (to working/idle/exited). `write()` with `'\r'` also clears it (user answered inline). `list()` maps: `needsYouMessage = status === 'needs-you' ? pendingMessage : null`; `activity = lastPrompt`. Neither field persists to sessions.json.
- Non-string/absent payload fields → null, never crash.

**Steps:** TDD — add tests (prompt captured + truncated; message captured, exposed only while needs-you, cleared on Stop/write; garbage payloads safe), RED, implement, GREEN, commit `feat: capture hook payloads for activity and needs-you messages`.

---

### Task 2: git-review module + baseBranch recording (main)

**Files:** create `src/main/git-review.ts`, `src/main/git-review.test.ts`; modify `src/main/worktree.ts` (+test), `src/shared/types.ts`.

**Interfaces produced:**
- `SessionMeta.worktree` gains `baseBranch: string` (branch checked out in repoRoot at creation; old persisted entries default `'main'` on load — normalize in SessionManager constructor).
- `worktree.ts`: `createWorktree` returns `{ path, branch, baseBranch }` (baseBranch = `git -C repoRoot rev-parse --abbrev-ref HEAD`; if detached, `'main'`).
- `git-review.ts` (all async, execFile git, 15s timeouts):
  ```ts
  interface ChangedFile { path: string; status: string } // A/M/D/R…
  changedFiles(repoRoot, branch, baseBranch): Promise<ChangedFile[]>   // git diff --name-status base...branch, plus uncommitted changes in the worktree marked status '*'
  fileDiff(worktreePath, repoRoot, branch, baseBranch, file): Promise<string> // committed: git diff base...branch -- file; if file has uncommitted changes in worktree, use git -C worktreePath diff HEAD -- file appended
  mergeBranch(repoRoot, branch, baseBranch): Promise<{ ok: boolean; error?: string }>
    // preconditions: repoRoot's current branch === baseBranch AND `git status --porcelain` clean in repoRoot, else ok:false with a human-readable error; then git merge --no-edit branch; merge conflict → abort (git merge --abort) and ok:false explaining conflict
  ```
- Simplification allowed: uncommitted-changes detection = `git -C worktreePath status --porcelain` non-empty → append a pseudo-entry `{ path: '(uncommitted changes)', status: '*' }` rather than per-file merging of the two lists.

**Steps:** TDD with real temp git repos (pattern in `worktree.test.ts`): commit on worktree branch → changedFiles lists it; fileDiff contains the hunk; merge happy path fast-forwards/merges into base; merge refused when repoRoot dirty; merge conflict aborts cleanly (repo left mergeable, `.git/MERGE_HEAD` absent). Update worktree tests for baseBranch. Commit `feat: git review module — changed files, diffs, guarded merge`.

---

### Task 3: Review & merge pane (renderer + IPC wiring)

**Files:** modify `src/main/index.ts`, `src/preload/index.ts`; create `src/renderer/src/components/ReviewPane.tsx`; modify `App.tsx`, `app.css`.

**Interfaces:**
- IPC handles: `review:files` (id) → ChangedFile[]; `review:diff` ({id, file}) → string; `review:merge` (id) → {ok, error?} (uses session's worktree meta; after ok merge show native info dialog "Merged <branch> into <base>. The session and worktree still exist — remove the session when you're done.").
- Preload: `reviewFiles(id)`, `reviewDiff(id, file)`, `reviewMerge(id)`.
- UI: when the ACTIVE session is a worktree session, a small "Changes" button floats top-right of the terminal area. Click (no shortcut yet) → right-hand split (40%, `position:absolute; right:0`) with: header `⎇ branch → baseBranch` + refresh + × ; file list (status letter + path, click to select); read-only diff view (monospace, `+` lines green `-` lines red, no syntax highlighting); footer buttons: **Merge into <base>** (calls reviewMerge, shows result, refreshes), **Remove session…** (calls existing `window.api.remove` flow). Diff text rendered in a `<pre>`, escaped.
- Pane closes on session switch. No state persists.

**Steps:** implement; `npm run typecheck` clean; tests still green; dev smoke (background run, no vite errors); commit `feat: review & merge pane for worktree sessions`. Manual/CDP verification is the controller's.

---

### Task 4: Waiting-on-you inbox + live activity rows (renderer)

**Files:** modify `src/shared/types.ts` (ShortcutAction), `src/main/index.ts` (menu), `src/renderer/src/App.tsx`, `Sidebar.tsx`, `app.css`; create `src/renderer/src/components/Inbox.tsx`.

**Interfaces:**
- `ShortcutAction` replaces `{ type: 'oldest-needs-you' }` with `{ type: 'toggle-inbox' }`; menu item becomes label `Waiting on You…`, same `Cmd+E`.
- App state `inboxOpen: boolean`; ⌘E toggles. `<Inbox>` renders a dropdown panel (top-right, above terminals): all `needs-you` sessions sorted by `statusChangedAt` ascending; each row = session name + `needsYouMessage` (fallback "waiting for input") + click → `switchTo(id)` + close. Empty state: "Nothing is waiting on you 🎉". Esc closes. Pressing Enter in the panel jumps to the first (oldest) entry.
- Sidebar rows: second line becomes (in priority order) `needsYouMessage` (needs-you, red tint) → `activity` (dim, prefix none) → worktree `⎇ branch`; worktree sessions with activity show `⎇ branch · activity` on one truncated line. Plain idle sessions with no activity show name only (as today).

**Steps:** implement; typecheck; tests green; dev smoke; commit `feat: waiting-on-you inbox and live activity lines`.

---

### Task 5: Hardening batch

**Files:** `src/main/store.ts` (+test), `src/main/session-manager.ts` (+test), `src/main/index.ts`, `src/renderer/src/components/Sidebar.tsx`, `NewSessionDialog.tsx`, `src/shared/types.ts`.

Items (all required):
1. **Atomic store writes:** save() writes `<file>.tmp` then `renameSync` over the target. Corrupt-recovery `renameSync` wrapped in try/catch (failure → return empty list, backup path null). Tests: atomic overwrite leaves valid JSON; recovery failure path doesn't throw.
2. **Persist lastActivityAt:** `SessionMeta.lastActivityAt?: number | null`; SessionManager updates it on hook events/pty data (already tracked) and persist() saves it; restored sessions surface it. Test: save→reload keeps it.
3. **Settings-file cleanup:** `remove()` in SessionManager deletes its `session-<id>.settings.json` via an injected `deleteSettings(id)` dep (real impl in index.ts: `fs.rmSync(path, {force:true})`). Test with fake.
4. **`now` dep:** `{ now: deps.now ?? Date.now }` instead of spread-clobber. Test: explicit `now: undefined` works.
5. **Ticking timestamps:** Sidebar re-renders every 30s (setInterval in a useEffect toggling a counter) so relative times don't freeze.
6. **Drag-drop consistency:** dropping always inserts BEFORE the target row regardless of drag direction (compute from-index/to-index and splice correctly).
7. **`~` path boundary:** `shortCwd` only substitutes when cwd === home or startsWith(home + '/'); same in NewSessionDialog.
8. **Dialog polish:** trim cwd on submit; Enter submits / Escape cancels from the directory field too.

**Steps:** TDD for 1–4; implement 5–8; typecheck; full suite; commit `fix: hardening batch — atomic persistence, cleanup, UI consistency`.

---

## Verification (controller)

1. `npm run typecheck`, `npm test` (expect ≈75+), `npm run build`.
2. CDP: existing smokes still pass; new checks — create worktree session in scratch repo, `review:files`/`review:diff` round-trip via `window.api`, merge happy path verified by git log in scratch repo.
3. Relaunch dev app for the user.
