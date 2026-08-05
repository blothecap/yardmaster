export type SessionStatus = 'working' | 'needs-you' | 'idle' | 'exited'

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop'

export const HOOK_EVENTS: HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop']

/** Persisted to sessions.json */
export interface SessionMeta {
  id: string // app-level UUID, not the Claude session id
  name: string
  cwd: string // for worktree sessions this is the worktree path
  claudeSessionId: string | null
  order: number
  worktree: { repoRoot: string; branch: string; baseBranch: string } | null
  lastActivityAt?: number | null
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
  | { type: 'toggle-shell' } // Cmd+T
