import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { HookEvent, SessionMeta, SessionStatus, SessionView, TranscriptCost } from '../shared/types'
import type { Store } from './store'

export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOpts {
  cwd: string
  settingsPath: string
  resumeId: string | null
  cols: number
  rows: number
  extraArgs: string[]
}

export type PtySpawner = (opts: SpawnOpts) => PtyLike

export interface SessionManagerDeps {
  store: Store
  spawner: PtySpawner
  writeSettings: (appSessionId: string) => string
  now?: () => number
  deleteSettings?: (id: string) => void
}

const RESUME_FAIL_WINDOW_MS = 5000
const BUFFER_CAP = 200_000

interface InternalSession {
  meta: SessionMeta
  status: SessionStatus
  pty: PtyLike | null
  lastActivityAt: number | null
  statusChangedAt: number
  spawnedAt: number
  spawnedWithResume: boolean
  closing: boolean
  lastSize: { cols: number; rows: number } | null
  lastPrompt: string | null
  pendingMessage: string | null
  lastTool: string | null
  buffer: string
  cost: TranscriptCost | null
  branch: string | null
}

const PROMPT_MAX_LEN = 120
const MESSAGE_MAX_LEN = 200
const TOOL_DETAIL_MAX_LEN = 60
const TOOL_DETAIL_KEYS = ['command', 'file_path', 'pattern', 'url']

function truncatedString(value: unknown, maxLen: number): string | null {
  return typeof value === 'string' ? value.slice(0, maxLen) : null
}

/** Builds a "<tool_name>: <detail>" label from a PreToolUse payload; never throws. */
function toolLabel(payload: Record<string, unknown>): string | null {
  const toolName = payload.tool_name
  if (typeof toolName !== 'string' || !toolName) return null
  const input = payload.tool_input
  const inputObj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  for (const key of TOOL_DETAIL_KEYS) {
    const detail = truncatedString(inputObj[key], TOOL_DETAIL_MAX_LEN)
    if (detail !== null) return `${toolName}: ${detail}`
  }
  return toolName
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, InternalSession>()
  private deps: Required<SessionManagerDeps>
  private activeId: string | null = null
  private resumableIds: string[] = []

  constructor(deps: SessionManagerDeps) {
    super()
    this.deps = { ...deps, now: deps.now ?? Date.now, deleteSettings: deps.deleteSettings ?? (() => {}) }
    for (const meta of this.deps.store.load().sessions) {
      if (meta.wasRunning) this.resumableIds.push(meta.id)
      this.sessions.set(meta.id, {
        meta: {
          ...meta,
          // one-shot: surfaced above via resumableIds, then cleared so the next persist drops it
          wasRunning: undefined,
          // tolerate pre-worktree sessions.json entries, and pre-baseBranch worktree entries
          worktree: meta.worktree ? { ...meta.worktree, baseBranch: meta.worktree.baseBranch ?? 'main' } : null,
          // tolerate pre-startCommit sessions.json entries
          startCommit: meta.startCommit ?? null
        },
        status: 'exited',
        pty: null,
        lastActivityAt: meta.lastActivityAt ?? null,
        statusChangedAt: this.deps.now(),
        spawnedAt: 0,
        spawnedWithResume: false,
        closing: false,
        lastSize: null,
        lastPrompt: null,
        pendingMessage: null,
        lastTool: null,
        buffer: '',
        cost: null,
        branch: null
      })
    }
  }

  list(): SessionView[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.meta.order - b.meta.order)
      .map((s) => ({
        ...s.meta,
        status: s.status,
        lastActivityAt: s.lastActivityAt,
        statusChangedAt: s.statusChangedAt,
        activity: s.lastPrompt,
        needsYouMessage: s.status === 'needs-you' ? s.pendingMessage : null,
        cost: s.cost,
        currentTool: s.status === 'working' ? s.lastTool : null,
        branch: s.meta.worktree?.branch ?? s.branch
      }))
  }

  /** Remember the transcript file so usage can be recomputed after an app relaunch. */
  setTranscriptPath(id: string, transcriptPath: string): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.transcriptPath === transcriptPath) return
    s.meta.transcriptPath = transcriptPath
    this.persist()
  }

  /** Record the detected git branch for a plain session (worktree sessions carry their own). */
  setBranch(id: string, branch: string | null): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.worktree || s.branch === branch) return
    s.branch = branch
    this.emitChanged()
  }

  create(
    name: string,
    cwd: string,
    worktree: SessionMeta['worktree'] = null,
    extraArgs: string | null = null,
    startCommit: string | null = null
  ): SessionView {
    const order = Math.max(-1, ...[...this.sessions.values()].map((s) => s.meta.order)) + 1
    const meta: SessionMeta = {
      id: crypto.randomUUID(),
      name,
      cwd,
      claudeSessionId: null,
      order,
      worktree,
      extraArgs,
      startCommit
    }
    const session: InternalSession = {
      meta,
      status: 'idle',
      pty: null,
      lastActivityAt: null,
      statusChangedAt: this.deps.now(),
      spawnedAt: 0,
      spawnedWithResume: false,
      closing: false,
      lastSize: null,
      lastPrompt: null,
      pendingMessage: null,
      lastTool: null,
      buffer: '',
      cost: null,
      branch: null
    }
    this.sessions.set(meta.id, session)
    try {
      this.spawn(session, null)
    } catch (err) {
      this.sessions.delete(meta.id)
      throw err
    }
    this.persist()
    return this.list().find((v) => v.id === meta.id)!
  }

  activate(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.pty) return
    try {
      this.spawn(s, s.meta.claudeSessionId)
      this.transition(s, 'idle')
    } catch {
      this.transition(s, 'exited')
    }
    this.emitChanged()
  }

  setActive(id: string | null): void {
    this.activeId = id
  }

  getActiveId(): string | null {
    return this.activeId
  }

  rename(id: string, name: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.meta.name = name
    this.persist()
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    s.closing = true
    s.pty.kill()
  }

  remove(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.closing = true
    s.pty?.kill()
    this.sessions.delete(id)
    this.deps.deleteSettings(id)
    this.persist()
  }

  reorder(ids: string[]): void {
    ids.forEach((id, i) => {
      const s = this.sessions.get(id)
      if (s) s.meta.order = i
    })
    this.persist()
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    s.pty.write(data)
    if (data.includes('\r')) {
      s.pendingMessage = null
      this.transition(s, 'working')
      this.emitChanged()
    }
  }

  /** Runtime-only (not persisted) — set from a transcript read after a Stop hook. */
  setCost(id: string, cost: TranscriptCost): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.cost = cost
    this.emitChanged()
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.lastSize = { cols, rows } // remembered even while dead — the next spawn is born at this size
    s.pty?.resize(cols, rows)
  }

  handleHookEvent(appSessionId: string, event: HookEvent, payload: Record<string, unknown>): void {
    const s = this.sessions.get(appSessionId)
    if (!s) return
    s.lastActivityAt = this.deps.now()
    if (event === 'SessionStart') {
      const sid = payload.session_id
      if (typeof sid === 'string' && sid && s.meta.claudeSessionId !== sid) {
        s.meta.claudeSessionId = sid
        this.persist()
        return
      }
    }
    if (!s.pty) return
    if (event === 'UserPromptSubmit') {
      s.lastPrompt = truncatedString(payload.prompt, PROMPT_MAX_LEN)
      s.lastTool = null // new turn — the previous tool label no longer applies
      this.transition(s, 'working')
    } else if (event === 'PreToolUse') {
      // Can fire in edge states (e.g. just after Stop); only updates the label,
      // never the status — lastActivityAt above is already updated.
      s.lastTool = toolLabel(payload)
    } else if (event === 'Notification') {
      // Permission prompts arrive while Claude is working. A Notification on an
      // idle session is Claude's periodic "waiting for your input" reminder —
      // not actionable, so it must not paint the session red.
      if (s.status === 'working' || s.status === 'needs-you') {
        s.pendingMessage = truncatedString(payload.message, MESSAGE_MAX_LEN)
        this.transition(s, 'needs-you')
      }
    } else if (event === 'Stop') {
      s.lastTool = null
      this.transition(s, 'idle')
    }
    this.emitChanged()
  }

  /** Ids of sessions that had a live pty when the app last quit; one-shot (see constructor). */
  getResumableIds(): string[] {
    return this.resumableIds
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      s.meta.wasRunning = s.pty !== null
    }
    this.persist()
    for (const s of this.sessions.values()) {
      s.closing = true
      s.pty?.kill()
    }
  }

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  /** Buffer output for replay (renderer reloads, late pane mounts), then emit live. */
  private pushData(s: InternalSession, chunk: string): void {
    s.buffer = (s.buffer + chunk).slice(-BUFFER_CAP)
    this.emit('data', s.meta.id, chunk)
  }

  private spawn(s: InternalSession, resumeId: string | null): void {
    const settingsPath = this.deps.writeSettings(s.meta.id)
    const { cols, rows } = s.lastSize ?? { cols: 80, rows: 24 }
    const extraArgs = (s.meta.extraArgs ?? '').split(/\s+/).filter(Boolean)
    const pty = this.deps.spawner({ cwd: s.meta.cwd, settingsPath, resumeId, cols, rows, extraArgs })
    s.pty = pty
    s.spawnedAt = this.deps.now()
    s.spawnedWithResume = resumeId !== null
    s.closing = false
    s.buffer = '' // fresh process repaints from scratch; stale bytes would corrupt the replay
    pty.onData((chunk) => {
      if (s.pty !== pty) return
      s.lastActivityAt = this.deps.now()
      this.pushData(s, chunk)
    })
    pty.onExit(({ exitCode }) => {
      if (s.pty !== pty) return
      this.handleExit(s, exitCode)
    })
  }

  private handleExit(s: InternalSession, exitCode: number): void {
    const wasClosing = s.closing
    s.pty = null
    s.lastTool = null
    const fastResumeFailure =
      !wasClosing &&
      s.spawnedWithResume &&
      exitCode !== 0 &&
      this.deps.now() - s.spawnedAt < RESUME_FAIL_WINDOW_MS
    if (fastResumeFailure) {
      s.meta.claudeSessionId = null
      this.spawn(s, null) // clears the replay buffer — inject the note after, so it survives
      this.pushData(s, '\r\n[claude-terminal] resume failed — starting a fresh session\r\n')
      this.transition(s, 'idle')
      this.persist()
      return
    }
    this.transition(s, 'exited')
    this.emitChanged()
  }

  private transition(s: InternalSession, to: SessionStatus): void {
    if (s.status === to) return
    const from = s.status
    s.status = to
    s.statusChangedAt = this.deps.now()
    if (from === 'needs-you') s.pendingMessage = null
    this.emit('status-transition', { id: s.meta.id, name: s.meta.name, from, to })
  }

  private persist(): void {
    this.deps.store.save(
      [...this.sessions.values()].map((s) => ({ ...s.meta, lastActivityAt: s.lastActivityAt }))
    )
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}
