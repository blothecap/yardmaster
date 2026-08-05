import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager, type PtyLike, type SpawnOpts } from './session-manager'
import { Store } from './store'

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: ((e: { exitCode: number }) => void) | null = null
  written: string[] = []
  killed = false
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(): void {}
  kill(): void { this.killed = true; this.exitCb?.({ exitCode: 0 }) }
}

let dir: string
let store: Store
let spawns: Array<{ opts: SpawnOpts; pty: FakePty }>
let clock: { t: number }

function makeManager(): SessionManager {
  return new SessionManager({
    store,
    spawner: (opts) => {
      const pty = new FakePty()
      spawns.push({ opts, pty })
      return pty
    },
    writeSettings: (id) => `/fake/settings-${id}.json`,
    now: () => clock.t
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sm-'))
  store = new Store(path.join(dir, 'sessions.json'))
  spawns = []
  clock = { t: 1000 }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('create', () => {
  it('spawns claude fresh in the cwd with generated settings, status idle, persisted', () => {
    const m = makeManager()
    const view = m.create('fix-auth', '/tmp/proj')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].opts).toEqual({
      cwd: '/tmp/proj',
      settingsPath: `/fake/settings-${view.id}.json`,
      resumeId: null,
      cols: 80,
      rows: 24
    })
    expect(view.status).toBe('idle')
    expect(store.load().sessions).toHaveLength(1)
  })

  it('assigns increasing order', () => {
    const m = makeManager()
    const a = m.create('a', '/tmp')
    const b = m.create('b', '/tmp')
    expect(a.order).toBe(0)
    expect(b.order).toBe(1)
  })
})

describe('hook events', () => {
  it('SessionStart records claudeSessionId and persists it', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-42' })
    expect(m.list()[0].claudeSessionId).toBe('cs-42')
    expect(store.load().sessions[0].claudeSessionId).toBe('cs-42')
  })

  it('maps UserPromptSubmit/Notification/Stop to statuses and emits transitions', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const transitions: Array<{ from: string; to: string }> = []
    m.on('status-transition', (t) => transitions.push({ from: t.from, to: t.to }))
    m.handleHookEvent(v.id, 'UserPromptSubmit', {})
    m.handleHookEvent(v.id, 'Notification', {})
    m.handleHookEvent(v.id, 'Stop', {})
    expect(transitions).toEqual([
      { from: 'idle', to: 'working' },
      { from: 'working', to: 'needs-you' },
      { from: 'needs-you', to: 'idle' }
    ])
  })

  it('ignores unknown session ids', () => {
    const m = makeManager()
    expect(() => m.handleHookEvent('ghost', 'Stop', {})).not.toThrow()
  })

  it('same-status hook does not emit a transition', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const spy = vi.fn()
    m.on('status-transition', spy)
    m.handleHookEvent(v.id, 'Stop', {}) // already idle
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('write', () => {
  it('forwards keystrokes and flips to working on Enter', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.write(v.id, 'hello')
    expect(m.list()[0].status).toBe('idle')
    m.write(v.id, '\r')
    expect(spawns[0].pty.written).toEqual(['hello', '\r'])
    expect(m.list()[0].status).toBe('working')
  })
})

describe('exit, close, activate, remove', () => {
  it('pty exit marks session exited', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    spawns[0].pty.exitCb!({ exitCode: 0 })
    expect(m.list()[0].status).toBe('exited')
  })

  it('close kills the pty but keeps the session listed', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.close(v.id)
    expect(spawns[0].pty.killed).toBe(true)
    expect(m.list()).toHaveLength(1)
    expect(m.list()[0].status).toBe('exited')
  })

  it('activate respawns an exited session with --resume id', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-42' })
    m.close(v.id)
    m.activate(v.id)
    expect(spawns).toHaveLength(2)
    expect(spawns[1].opts.resumeId).toBe('cs-42')
    expect(m.list()[0].status).toBe('idle')
  })

  it('activate on a live session does not respawn', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.activate(v.id)
    expect(spawns).toHaveLength(1)
  })

  it('remove deletes from store', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.remove(v.id)
    expect(m.list()).toHaveLength(0)
    expect(store.load().sessions).toHaveLength(0)
  })
})

describe('resume fallback', () => {
  function resumedSession(m: SessionManager): string {
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-old' })
    m.close(v.id)
    m.activate(v.id) // spawns[1] with resumeId cs-old
    return v.id
  }

  it('fast nonzero exit after resume respawns fresh and clears claudeSessionId', () => {
    const m = makeManager()
    const id = resumedSession(m)
    const chunks: string[] = []
    m.on('data', (_id: string, c: string) => chunks.push(c))
    clock.t += 2000 // < 5000ms
    spawns[1].pty.exitCb!({ exitCode: 1 })
    expect(spawns).toHaveLength(3)
    expect(spawns[2].opts.resumeId).toBeNull()
    expect(m.list()[0].claudeSessionId).toBeNull()
    expect(chunks.join('')).toContain('resume failed')
    expect(m.list()[0].status).toBe('idle')
  })

  it('slow exit after resume is a normal exit', () => {
    const m = makeManager()
    resumedSession(m)
    clock.t += 60000
    spawns[1].pty.exitCb!({ exitCode: 1 })
    expect(spawns).toHaveLength(2)
    expect(m.list()[0].status).toBe('exited')
  })
})

describe('spawn size', () => {
  it('respawn uses the last known terminal size', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.resize(v.id, 120, 40)
    m.close(v.id)
    m.activate(v.id)
    expect(spawns[1].opts.cols).toBe(120)
    expect(spawns[1].opts.rows).toBe(40)
  })

  it('resize while exited is remembered for the next spawn', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.close(v.id)
    m.resize(v.id, 100, 50) // pane reports size while pty is dead
    m.activate(v.id)
    expect(spawns[1].opts.cols).toBe(100)
    expect(spawns[1].opts.rows).toBe(50)
  })
})

describe('worktree metadata', () => {
  it('create stores and persists worktree info', () => {
    const m = makeManager()
    const v = m.create('wt', '/repo/.worktrees/wt', { repoRoot: '/repo', branch: 'wt' })
    expect(v.worktree).toEqual({ repoRoot: '/repo', branch: 'wt' })
    expect(store.load().sessions[0].worktree).toEqual({ repoRoot: '/repo', branch: 'wt' })
  })

  it('tolerates pre-worktree sessions.json entries', () => {
    store.save([{ id: 'x1', name: 'old', cwd: '/tmp', claudeSessionId: null, order: 0 } as never])
    const m = makeManager()
    expect(m.list()[0].worktree).toBeNull()
  })
})

describe('restore from store', () => {
  it('lists persisted sessions as exited without spawning', () => {
    store.save([{ id: 'x1', name: 'old', cwd: '/tmp', claudeSessionId: 'cs-1', order: 0, worktree: null }])
    const m = makeManager()
    expect(spawns).toHaveLength(0)
    expect(m.list()).toHaveLength(1)
    expect(m.list()[0].status).toBe('exited')
  })
})

describe('reorder and rename', () => {
  it('reorder rewrites order fields and list() sorts by them', () => {
    const m = makeManager()
    const a = m.create('a', '/tmp')
    const b = m.create('b', '/tmp')
    m.reorder([b.id, a.id])
    expect(m.list().map((s) => s.name)).toEqual(['b', 'a'])
  })

  it('rename persists and emits changed', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const spy = vi.fn()
    m.on('changed', spy)
    m.rename(v.id, 'better-name')
    expect(store.load().sessions[0].name).toBe('better-name')
    expect(spy).toHaveBeenCalled()
  })
})

describe('spawn failures', () => {
  it('create removes the session and rethrows when the spawner throws', () => {
    const m = new SessionManager({
      store,
      spawner: () => { throw new Error('spawn failed') },
      writeSettings: () => '/fake.json',
      now: () => clock.t
    })
    expect(() => m.create('a', '/nope')).toThrow(/spawn failed/)
    expect(m.list()).toHaveLength(0)
    expect(store.load().sessions).toHaveLength(0)
  })

  it('activate marks the session exited when the spawner throws', () => {
    store.save([{ id: 'x1', name: 'old', cwd: '/tmp', claudeSessionId: 'cs-1', order: 0, worktree: null }])
    const m = new SessionManager({
      store,
      spawner: () => { throw new Error('spawn failed') },
      writeSettings: () => '/fake.json',
      now: () => clock.t
    })
    m.activate('x1')
    expect(m.list()[0].status).toBe('exited')
  })
})

describe('late events after close/respawn', () => {
  it('ignores status hooks for sessions with no live pty', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.close(v.id)
    m.handleHookEvent(v.id, 'Stop', {})
    expect(m.list()[0].status).toBe('exited')
    m.handleHookEvent(v.id, 'Notification', {})
    expect(m.list()[0].status).toBe('exited')
  })

  it('still records claudeSessionId from a late SessionStart', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.close(v.id)
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-late' })
    expect(m.list()[0].claudeSessionId).toBe('cs-late')
  })

  it('ignores stale pty callbacks after resume-fallback respawn', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-old' })
    m.close(v.id)
    m.activate(v.id)
    clock.t += 2000
    spawns[1].pty.exitCb!({ exitCode: 1 }) // fallback respawns -> spawns[2]
    expect(spawns).toHaveLength(3)
    const chunks: string[] = []
    m.on('data', (_id: string, c: string) => chunks.push(c))
    spawns[1].pty.dataCb!('zombie output')
    spawns[1].pty.exitCb!({ exitCode: 1 })
    expect(chunks).toEqual([])
    expect(m.list()[0].status).toBe('idle')
    expect(spawns).toHaveLength(3)
  })
})
