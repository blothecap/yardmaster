# Round-3 Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** (1) Approve/Deny from the inbox, (2) Push + Create PR from the Changes pane, (3) per-session cost meter from transcript data.

**Architecture:** unchanged. Main owns logic; renderer sends intents through `window.api`. Follow existing preload named-handler/unsubscribe patterns and execFile-only git/gh calls (15s timeouts, no shell interpolation).

## Global Constraints

- No output-scraping for status; hook payloads and git/gh exit data only.
- Renderer dumb; all subprocess work in main.
- TDD (Vitest) for main-process logic; renderer manual/CDP smoke.
- Env: `export PATH="$HOME/.nvm/versions/node/v23.11.1/bin:$PATH"` before npm commands.

---

### Task 1: Approve / Deny from the inbox (renderer only)

**Files:** modify `src/renderer/src/components/Inbox.tsx`, `src/renderer/src/app.css`.

**Behavior:** each inbox row gains two small buttons on the right: **✓** (title "Approve — sends Enter") and **✕** (title "Deny — sends Escape"). Clicking ✓ calls `window.api.input(id, '\r')`; ✕ calls `window.api.input(id, '')`. Both `stopPropagation` so the row's jump-on-click doesn't fire. Rationale (add as a code comment): Claude Code's permission prompt defaults to "Yes" — Enter accepts the default; Escape rejects. After answering, the session's own hooks flip it out of needs-you and the row disappears via the normal `sessions` prop update — no local state.

Keyboard: within the focused panel, `a` approves the first (oldest) entry, `d` denies it (extend the existing panel onKeyDown; Enter/Escape keep their current jump/close meanings). Show the key hints subtly in the row or panel footer.

**Steps:** implement; `npm run typecheck` clean; `npm test` green (no new tests — renderer); dev smoke; commit `feat: approve/deny from the inbox`.

---

### Task 2: Push + Create PR (main + renderer)

**Files:** modify `src/main/git-review.ts` (+test), `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/ReviewPane.tsx`, `src/renderer/src/app.css` if needed.

**Interfaces:**
```ts
// git-review.ts
export async function pushBranch(worktreePath: string, branch: string): Promise<{ ok: boolean; error?: string }>
  // git -C worktreePath push -u origin <branch>; failure (no remote, auth) → ok:false with stderr text
export async function pushAndCreatePr(worktreePath: string, branch: string, baseBranch: string):
  Promise<{ ok: boolean; url?: string; error?: string }>
  // pushBranch first; then execFile('gh', ['pr','create','--head',branch,'--base',baseBranch,'--fill'], {cwd: worktreePath, timeout: 30000})
  // gh ENOENT → ok:false, error "GitHub CLI (gh) not found — install it or use Merge instead."
  // gh nonzero → ok:false with stderr; success → url = last nonempty stdout line matching /^https:/ (else stdout trimmed)
```
- IPC `review:pr` (id): looks up worktree session (same guards as review:merge), calls pushAndCreatePr; on ok, main opens the URL via `shell.openExternal(url)` and shows a native info dialog with the URL; returns the result object either way.
- Preload `reviewPr(id)`. ReviewPane: **Push + PR** button beside Merge; disabled while in flight ("Pushing…"); error shown the same way merge errors are.

**Tests (real git):** `pushBranch` happy path — create temp repo + `git init --bare` second dir, `git remote add origin <bare>`, worktree branch with a commit, pushBranch → ok:true and the bare repo has the branch (`git -C bare rev-parse refs/heads/<branch>`). `pushBranch` failure — repo with no remote → ok:false, error mentions origin/remote. Do NOT unit-test the gh call (external tool); its ENOENT path may be tested by monkey-patching PATH if convenient, else leave to manual smoke.

**Steps:** TDD for pushBranch; implement the rest; typecheck + full suite + build + dev smoke; commit `feat: push branch and create PR from the review pane`.

---

### Task 3: Per-session cost meter (main + renderer)

**Files:** create `src/main/transcript-cost.ts` (+test); modify `src/main/session-manager.ts` (+test), `src/main/index.ts`, `src/shared/types.ts`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/app.css`.

**Interfaces:**
```ts
// transcript-cost.ts
export interface TranscriptCost { costUsd: number | null; inputTokens: number; outputTokens: number }
export async function sessionCost(transcriptPath: string): Promise<TranscriptCost>
  // Read the JSONL transcript; per line JSON.parse in try/catch (skip garbage).
  // Sum: entry.costUSD (number) → costUsd (null if NO entry had costUSD);
  //      entry.message?.usage?.input_tokens / output_tokens (numbers) → token sums.
  // Missing/unreadable file → { costUsd: null, inputTokens: 0, outputTokens: 0 }.
```
- `SessionManager`: new method `setCost(id: string, cost: TranscriptCost): void` — stores on the internal session (runtime only, NOT persisted) and `emitChanged()`; no-op for unknown ids. `SessionView` gains `cost: TranscriptCost | null`.
- Wiring in `index.ts`, inside the existing `hookServer.onEvent` callback: after `handleHookEvent`, when `event === 'Stop'` and `typeof payload.transcript_path === 'string'`, fire-and-forget `sessionCost(payload.transcript_path).then((c) => manager!.setCost(id, c)).catch(() => {})`.
- Sidebar row: next to the relative time, a dim cost chip: `$X.XX` when costUsd ≥ 0.005 (toFixed(2)); `<1¢` when 0 < costUsd < 0.005; when costUsd is null but tokens > 0, `${Math.round((in+out)/1000)}k tok`; nothing when no data. Tooltip shows exact figures.

**Tests:** transcript-cost with fixture JSONL files (costUSD entries; usage-only entries; mixed garbage lines; missing file). SessionManager.setCost round-trip through list() + unknown-id no-op.

**Steps:** TDD; typecheck + suite + build + dev smoke; commit `feat: per-session cost meter from transcript data`.

---

## Verification (controller)

typecheck; full suite; build; CDP: inbox buttons exist when a needs-you session present (structural check optional), cost field flows (setCost via fixture not CDP-able — unit coverage suffices); manual smoke items appended; restart dev app.
