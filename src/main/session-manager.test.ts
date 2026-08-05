import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager, type PtyLike, type SpawnOpts } from './session-manager'
import { Store } from './store'
import type { TranscriptCost } from './transcript-cost'

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
      rows: 24,
      extraArgs: []
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

describe('activity and needs-you messages', () => {
  it('UserPromptSubmit captures the prompt as activity, truncated to 120 chars', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const long = 'x'.repeat(150)
    m.handleHookEvent(v.id, 'UserPromptSubmit', { prompt: long })
    expect(m.list()[0].activity).toBe(long.slice(0, 120))
  })

  it('Notification during working captures message as needsYouMessage, truncated to 200 chars', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const long = 'y'.repeat(250)
    m.handleHookEvent(v.id, 'UserPromptSubmit', {})
    m.handleHookEvent(v.id, 'Notification', { message: long })
    expect(m.list()[0].status).toBe('needs-you')
    expect(m.list()[0].needsYouMessage).toBe(long.slice(0, 200))
  })

  it('Notification on an idle session is ignored (Claude idle "waiting for input" reminder)', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'Notification', { message: 'Claude is waiting for your input' })
    expect(m.list()[0].status).toBe('idle')
    expect(m.list()[0].needsYouMessage).toBeNull()
  })

  it('Notification while already needs-you updates the message', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'UserPromptSubmit', {})
    m.handleHookEvent(v.id, 'Notification', { message: 'first' })
    m.handleHookEvent(v.id, 'Notification', { message: 'second' })
    expect(m.list()[0].needsYouMessage).toBe('second')
  })

  it('needsYouMessage is null when the session is not in needs-you', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    expect(m.list()[0].needsYouMessage).toBeNull()
  })

  it('pendingMessage clears when Stop transitions the session out of needs-you', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'UserPromptSubmit', {})
    m.handleHookEvent(v.id, 'Notification', { message: 'please confirm' })
    m.handleHookEvent(v.id, 'Stop', {})
    expect(m.list()[0].status).toBe('idle')
    expect(m.list()[0].needsYouMessage).toBeNull()
  })

  it('write with \\r clears pendingMessage (user answered inline) and is safe to repeat', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'UserPromptSubmit', {}) // idle -> working
    m.handleHookEvent(v.id, 'Notification', { message: 'please confirm' }) // working -> needs-you
    m.write(v.id, 'y') // no \r yet, still needs-you
    expect(m.list()[0].needsYouMessage).toBe('please confirm')
    m.write(v.id, '\r') // needs-you -> working, real transition, clears pendingMessage
    expect(m.list()[0].status).toBe('working')
    expect(m.list()[0].needsYouMessage).toBeNull()
    // Calling write with \r again while already working is a no-op transition; must not throw
    // and pendingMessage must remain cleared.
    expect(() => m.write(v.id, '\r')).not.toThrow()
    expect(m.list()[0].status).toBe('working')
    expect(m.list()[0].needsYouMessage).toBeNull()
  })

  it('garbage payloads (non-string or absent fields) do not crash and yield null', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    expect(() => m.handleHookEvent(v.id, 'UserPromptSubmit', { prompt: 42 })).not.toThrow()
    expect(m.list()[0].activity).toBeNull()
    expect(() => m.handleHookEvent(v.id, 'Notification', {})).not.toThrow()
    expect(m.list()[0].needsYouMessage).toBeNull()
    expect(() => m.handleHookEvent(v.id, 'Notification', { message: { nested: true } })).not.toThrow()
    expect(m.list()[0].needsYouMessage).toBeNull()
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

describe('output replay buffer', () => {
  it('accumulates pty output and returns it from getBuffer', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    spawns[0].pty.dataCb!('hello ')
    spawns[0].pty.dataCb!('world')
    expect(m.getBuffer(v.id)).toBe('hello world')
  })

  it('caps the buffer, keeping the most recent output', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    spawns[0].pty.dataCb!('x'.repeat(200_000))
    spawns[0].pty.dataCb!('TAIL')
    const buf = m.getBuffer(v.id)
    expect(buf.length).toBe(200_000)
    expect(buf.endsWith('TAIL')).toBe(true)
  })

  it('clears the buffer on respawn (fresh process paints a fresh screen)', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    spawns[0].pty.dataCb!('old screen')
    m.close(v.id)
    expect(m.getBuffer(v.id)).toBe('old screen') // survives exit for exited-session display
    m.activate(v.id)
    expect(m.getBuffer(v.id)).toBe('')
    spawns[1].pty.dataCb!('new screen')
    expect(m.getBuffer(v.id)).toBe('new screen')
  })

  it('includes injected messages like the resume-failed note', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-old' })
    m.close(v.id)
    m.activate(v.id)
    clock.t += 2000
    spawns[1].pty.exitCb!({ exitCode: 1 }) // resume fallback -> respawn + injected note
    expect(m.getBuffer(v.id)).toContain('resume failed')
  })

  it('returns empty string for unknown sessions', () => {
    const m = makeManager()
    expect(m.getBuffer('ghost')).toBe('')
  })
})

describe('extra claude args', () => {
  it('create stores extraArgs, persists them, and the spawner receives them split', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp', null, '--model opus  --permission-mode plan')
    expect(v.extraArgs).toBe('--model opus  --permission-mode plan')
    expect(store.load().sessions[0].extraArgs).toBe('--model opus  --permission-mode plan')
    expect(spawns[0].opts.extraArgs).toEqual(['--model', 'opus', '--permission-mode', 'plan'])
  })

  it('no extraArgs yields an empty array for the spawner', () => {
    const m = makeManager()
    m.create('a', '/tmp')
    expect(spawns[0].opts.extraArgs).toEqual([])
  })

  it('respawn (activate) reuses the stored extraArgs', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp', null, '--model opus')
    m.close(v.id)
    m.activate(v.id)
    expect(spawns[1].opts.extraArgs).toEqual(['--model', 'opus'])
  })
})

describe('worktree metadata', () => {
  it('create stores and persists worktree info', () => {
    const m = makeManager()
    const v = m.create('wt', '/repo/.worktrees/wt', { repoRoot: '/repo', branch: 'wt', baseBranch: 'main' })
    expect(v.worktree).toEqual({ repoRoot: '/repo', branch: 'wt', baseBranch: 'main' })
    expect(store.load().sessions[0].worktree).toEqual({ repoRoot: '/repo', branch: 'wt', baseBranch: 'main' })
  })

  it('tolerates pre-worktree sessions.json entries', () => {
    store.save([{ id: 'x1', name: 'old', cwd: '/tmp', claudeSessionId: null, order: 0 } as never])
    const m = makeManager()
    expect(m.list()[0].worktree).toBeNull()
  })

  it('defaults baseBranch to "main" for pre-baseBranch worktree entries', () => {
    store.save([
      {
        id: 'x1',
        name: 'old',
        cwd: '/tmp/wt',
        claudeSessionId: null,
        order: 0,
        worktree: { repoRoot: '/tmp', branch: 'old' }
      } as never
    ])
    const m = makeManager()
    expect(m.list()[0].worktree).toEqual({ repoRoot: '/tmp', branch: 'old', baseBranch: 'main' })
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

describe('lastActivityAt persistence', () => {
  it('persists lastActivityAt (tracked via hook events) and restores it on reload', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    clock.t = 5000
    // SessionStart with a new claudeSessionId triggers a persist(); lastActivityAt is
    // updated on every hook event, so this persist should carry the current value.
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-round-trip' })
    expect(store.load().sessions[0].lastActivityAt).toBe(5000)

    const m2 = makeManager()
    expect(m2.list()[0].lastActivityAt).toBe(5000)
  })

  it('persists lastActivityAt updates from pty data on the next persist()', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    clock.t = 9000
    spawns[0].pty.dataCb!('some output')
    m.rename(v.id, 'a') // forces persist()
    expect(store.load().sessions[0].lastActivityAt).toBe(9000)
  })
})

describe('settings cleanup on remove', () => {
  it('calls the injected deleteSettings dep with the session id', () => {
    const deleted: string[] = []
    const m = new SessionManager({
      store,
      spawner: (opts) => {
        const pty = new FakePty()
        spawns.push({ opts, pty })
        return pty
      },
      writeSettings: (id) => `/fake/settings-${id}.json`,
      now: () => clock.t,
      deleteSettings: (id) => deleted.push(id)
    })
    const v = m.create('a', '/tmp')
    m.remove(v.id)
    expect(deleted).toEqual([v.id])
  })

  it('remove works fine without a deleteSettings dep (no-op default)', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    expect(() => m.remove(v.id)).not.toThrow()
    expect(m.list()).toHaveLength(0)
  })
})

describe('now dep default', () => {
  it('explicit now: undefined falls back to Date.now without breaking construction', () => {
    const m = new SessionManager({
      store,
      spawner: (opts) => {
        const pty = new FakePty()
        spawns.push({ opts, pty })
        return pty
      },
      writeSettings: (id) => `/fake/settings-${id}.json`,
      now: undefined
    })
    expect(() => m.create('a', '/tmp')).not.toThrow()
    expect(m.list()[0].status).toBe('idle')
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

describe('setCost', () => {
  it('is null by default and round-trips a cost through list() plus a changed emission', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    expect(v.cost).toBeNull()

    const changes: unknown[] = []
    m.on('changed', (views) => changes.push(views))
    const cost: TranscriptCost = { costUsd: 0.0573, inputTokens: 300, outputTokens: 125 }
    m.setCost(v.id, cost)

    expect(m.list()[0].cost).toEqual(cost)
    expect(changes).toHaveLength(1)
    expect((changes[0] as Array<{ cost: TranscriptCost | null }>)[0].cost).toEqual(cost)
  })

  it('overwrites a previously set cost and is not persisted to the store', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.setCost(v.id, { costUsd: 0.01, inputTokens: 10, outputTokens: 5 })
    m.setCost(v.id, { costUsd: 0.02, inputTokens: 20, outputTokens: 8 })
    expect(m.list()[0].cost).toEqual({ costUsd: 0.02, inputTokens: 20, outputTokens: 8 })
    expect(store.load().sessions[0]).not.toHaveProperty('cost')
  })

  it('is a no-op for unknown session ids', () => {
    const m = makeManager()
    expect(() =>
      m.setCost('ghost', { costUsd: 1, inputTokens: 1, outputTokens: 1 })
    ).not.toThrow()
  })
})
