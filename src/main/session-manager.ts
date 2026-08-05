import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { HookEvent, SessionMeta, SessionStatus, SessionView } from '../shared/types'
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
}

const PROMPT_MAX_LEN = 120
const MESSAGE_MAX_LEN = 200

function truncatedString(value: unknown, maxLen: number): string | null {
  return typeof value === 'string' ? value.slice(0, maxLen) : null
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, InternalSession>()
  private deps: Required<SessionManagerDeps>
  private activeId: string | null = null

  constructor(deps: SessionManagerDeps) {
    super()
    this.deps = { ...deps, now: deps.now ?? Date.now, deleteSettings: deps.deleteSettings ?? (() => {}) }
    for (const meta of this.deps.store.load().sessions) {
      this.sessions.set(meta.id, {
        meta: {
          ...meta,
          // tolerate pre-worktree sessions.json entries, and pre-baseBranch worktree entries
          worktree: meta.worktree ? { ...meta.worktree, baseBranch: meta.worktree.baseBranch ?? 'main' } : null
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
        pendingMessage: null
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
        needsYouMessage: s.status === 'needs-you' ? s.pendingMessage : null
      }))
  }

  create(name: string, cwd: string, worktree: SessionMeta['worktree'] = null): SessionView {
    const order = Math.max(-1, ...[...this.sessions.values()].map((s) => s.meta.order)) + 1
    const meta: SessionMeta = { id: crypto.randomUUID(), name, cwd, claudeSessionId: null, order, worktree }
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
      pendingMessage: null
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
      this.transition(s, 'working')
    } else if (event === 'Notification') {
      s.pendingMessage = truncatedString(payload.message, MESSAGE_MAX_LEN)
      this.transition(s, 'needs-you')
    } else if (event === 'Stop') {
      this.transition(s, 'idle')
    }
    this.emitChanged()
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      s.closing = true
      s.pty?.kill()
    }
  }

  private spawn(s: InternalSession, resumeId: string | null): void {
    const settingsPath = this.deps.writeSettings(s.meta.id)
    const { cols, rows } = s.lastSize ?? { cols: 80, rows: 24 }
    const pty = this.deps.spawner({ cwd: s.meta.cwd, settingsPath, resumeId, cols, rows })
    s.pty = pty
    s.spawnedAt = this.deps.now()
    s.spawnedWithResume = resumeId !== null
    s.closing = false
    pty.onData((chunk) => {
      if (s.pty !== pty) return
      s.lastActivityAt = this.deps.now()
      this.emit('data', s.meta.id, chunk)
    })
    pty.onExit(({ exitCode }) => {
      if (s.pty !== pty) return
      this.handleExit(s, exitCode)
    })
  }

  private handleExit(s: InternalSession, exitCode: number): void {
    const wasClosing = s.closing
    s.pty = null
    const fastResumeFailure =
      !wasClosing &&
      s.spawnedWithResume &&
      exitCode !== 0 &&
      this.deps.now() - s.spawnedAt < RESUME_FAIL_WINDOW_MS
    if (fastResumeFailure) {
      this.emit('data', s.meta.id, '\r\n[claude-terminal] resume failed — starting a fresh session\r\n')
      s.meta.claudeSessionId = null
      this.spawn(s, null)
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
