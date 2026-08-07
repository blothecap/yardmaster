export type SessionStatus = 'working' | 'needs-you' | 'idle' | 'exited'

/**
 * Pseudo-session id for the standalone "Terminals" workspace — a plain
 * multi-tab terminal with no Claude session behind it. Its shells live in
 * the ShellManager under `${TERMINALS_ID}::<n>` keys and spawn in $HOME.
 */
export const TERMINALS_ID = '__terminals__'

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Notification' | 'Stop'

export const HOOK_EVENTS: HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop'
]

/** Persisted to sessions.json */
export interface SessionMeta {
  id: string // app-level UUID, not the Claude session id
  name: string
  cwd: string // for worktree sessions this is the worktree path
  claudeSessionId: string | null
  order: number
  worktree: { repoRoot: string; branch: string; baseBranch: string } | null
  /** Extra CLI flags appended to the claude command, e.g. "--model opus" */
  extraArgs?: string | null
  lastActivityAt?: number | null
  /** True if the session had a live pty at last quit; one-shot, cleared after being surfaced. */
  wasRunning?: boolean
  /** HEAD sha at session creation, for plain (non-worktree) sessions — baseline for commitsSince. */
  startCommit?: string | null
}

export interface TranscriptCost {
  costUsd: number | null
  inputTokens: number
  outputTokens: number
}

/** Pushed to the renderer */
export interface SessionView extends SessionMeta {
  status: SessionStatus
  lastActivityAt: number | null
  statusChangedAt: number
  activity: string | null
  needsYouMessage: string | null
  cost: TranscriptCost | null
  currentTool: string | null
  /** Git branch of cwd — the worktree branch, or the detected branch for plain repo sessions. */
  branch: string | null
}

export interface ChangedFile {
  path: string
  status: string // A/M/D/R… from git diff --name-status, or '*' for uncommitted worktree changes
}

export type ShortcutAction =
  | { type: 'jump'; index: number } // Cmd+1..9 (index 0-based)
  | { type: 'next' } // Cmd+J / Cmd+Shift+]
  | { type: 'prev' } // Cmd+K / Cmd+Shift+[
  | { type: 'new' } // Cmd+N
  | { type: 'rename' } // Cmd+R
  | { type: 'close' } // Cmd+W
  | { type: 'toggle-inbox' } // Cmd+E
  | { type: 'toggle-sidebar' } // Cmd+B
  | { type: 'new-shell' } // Cmd+T — opens a new shell tab in the active session
  | { type: 'tab-next' } // Cmd+Opt+Right
  | { type: 'tab-prev' } // Cmd+Opt+Left
