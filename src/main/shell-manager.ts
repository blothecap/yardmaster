import { EventEmitter } from 'node:events'
import type { PtyLike } from './session-manager'

export type ShellSpawner = (cwd: string) => PtyLike

/**
 * One scratch shell per session: lazy, no status tracking, no persistence.
 * Dies with its session or the app.
 */
export class ShellManager extends EventEmitter {
  private shells = new Map<string, PtyLike>()

  constructor(private deps: { spawner: ShellSpawner }) {
    super()
  }

  ensure(sessionId: string, cwd: string): void {
    if (this.shells.has(sessionId)) return
    const pty = this.deps.spawner(cwd)
    this.shells.set(sessionId, pty)
    pty.onData((chunk) => {
      if (this.shells.get(sessionId) !== pty) return
      this.emit('data', sessionId, chunk)
    })
    pty.onExit(() => {
      if (this.shells.get(sessionId) !== pty) return
      this.shells.delete(sessionId)
      this.emit('exit', sessionId)
    })
  }

  isRunning(sessionId: string): boolean {
    return this.shells.has(sessionId)
  }

  write(sessionId: string, data: string): void {
    this.shells.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.shells.get(sessionId)?.resize(cols, rows)
  }

  kill(sessionId: string): void {
    const pty = this.shells.get(sessionId)
    if (!pty) return
    this.shells.delete(sessionId)
    pty.kill()
  }

  disposeAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id)
  }
}
