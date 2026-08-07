import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ShellManager } from './shell-manager'
import type { PtyLike } from './session-manager'

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: ((e: { exitCode: number }) => void) | null = null
  written: string[] = []
  resized: Array<[number, number]> = []
  killed = false
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(c: number, r: number): void { this.resized.push([c, r]) }
  kill(): void { this.killed = true; this.exitCb?.({ exitCode: 0 }) }
}

let spawns: Array<{ cwd: string; pty: FakePty }>
let m: ShellManager

beforeEach(() => {
  spawns = []
  m = new ShellManager({
    spawner: (cwd) => {
      const pty = new FakePty()
      spawns.push({ cwd, pty })
      return pty
    }
  })
})

describe('ShellManager', () => {
  it('ensure spawns a shell in the given cwd', () => {
    m.ensure('s1', '/tmp/proj')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].cwd).toBe('/tmp/proj')
    expect(m.isRunning('s1')).toBe(true)
  })

  it('ensure is idempotent while the shell is running', () => {
    m.ensure('s1', '/tmp/proj')
    m.ensure('s1', '/tmp/proj')
    expect(spawns).toHaveLength(1)
  })

  it('ensure respawns after the shell exits', () => {
    m.ensure('s1', '/tmp/proj')
    spawns[0].pty.exitCb!({ exitCode: 0 })
    expect(m.isRunning('s1')).toBe(false)
    m.ensure('s1', '/tmp/proj')
    expect(spawns).toHaveLength(2)
    expect(m.isRunning('s1')).toBe(true)
  })

  it('forwards write and resize to the pty; no-ops when absent', () => {
    m.ensure('s1', '/tmp')
    m.write('s1', 'ls\r')
    m.resize('s1', 120, 30)
    expect(spawns[0].pty.written).toEqual(['ls\r'])
    expect(spawns[0].pty.resized).toEqual([[120, 30]])
    expect(() => { m.write('ghost', 'x'); m.resize('ghost', 1, 1) }).not.toThrow()
  })

  it('emits data and exit events with the session id', () => {
    const data = vi.fn()
    const exit = vi.fn()
    m.on('data', data)
    m.on('exit', exit)
    m.ensure('s1', '/tmp')
    spawns[0].pty.dataCb!('hello')
    expect(data).toHaveBeenCalledWith('s1', 'hello')
    spawns[0].pty.exitCb!({ exitCode: 0 })
    expect(exit).toHaveBeenCalledWith('s1')
  })

  it('kill terminates the pty, emits exit, and is a no-op when absent', () => {
    const exit = vi.fn()
    m.on('exit', exit)
    m.ensure('s1', '/tmp')
    m.kill('s1')
    expect(spawns[0].pty.killed).toBe(true)
    expect(m.isRunning('s1')).toBe(false)
    expect(exit).toHaveBeenCalledWith('s1')
    expect(() => m.kill('ghost')).not.toThrow()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('ignores stale callbacks from a replaced pty', () => {
    m.ensure('s1', '/tmp')
    const old = spawns[0].pty
    old.exitCb!({ exitCode: 0 })
    m.ensure('s1', '/tmp') // respawn -> spawns[1]
    const data = vi.fn()
    const exit = vi.fn()
    m.on('data', data)
    m.on('exit', exit)
    old.dataCb!('zombie')
    old.exitCb!({ exitCode: 1 })
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(m.isRunning('s1')).toBe(true)
  })

  it('buffers output for replay and returns it from getBuffer', () => {
    m.ensure('s1', '/tmp')
    spawns[0].pty.dataCb!('line one\r\n')
    spawns[0].pty.dataCb!('line two')
    expect(m.getBuffer('s1')).toBe('line one\r\nline two')
    expect(m.getBuffer('ghost')).toBe('')
  })

  it('caps the replay buffer keeping the newest output', () => {
    m.ensure('s1', '/tmp')
    spawns[0].pty.dataCb!('x'.repeat(200_000))
    spawns[0].pty.dataCb!('TAIL')
    expect(m.getBuffer('s1').length).toBe(200_000)
    expect(m.getBuffer('s1').endsWith('TAIL')).toBe(true)
  })

  it('clears the buffer when a fresh shell spawns', () => {
    m.ensure('s1', '/tmp')
    spawns[0].pty.dataCb!('old')
    spawns[0].pty.exitCb!({ exitCode: 0 })
    m.ensure('s1', '/tmp')
    expect(m.getBuffer('s1')).toBe('')
    spawns[1].pty.dataCb!('new')
    expect(m.getBuffer('s1')).toBe('new')
  })

  it('killForSession kills only that session\'s shells, bare or ::-suffixed', () => {
    m.ensure('sess1::1', '/a')
    m.ensure('sess1::2', '/a')
    m.ensure('sess10::1', '/b')
    m.ensure('sess2', '/c')
    m.killForSession('sess1')
    expect(m.isRunning('sess1::1')).toBe(false)
    expect(m.isRunning('sess1::2')).toBe(false)
    expect(m.isRunning('sess10::1')).toBe(true) // prefix must not over-match
    expect(m.isRunning('sess2')).toBe(true)
    m.killForSession('sess2')
    expect(m.isRunning('sess2')).toBe(false)
  })

  it('disposeAll kills every running shell', () => {
    m.ensure('s1', '/a')
    m.ensure('s2', '/b')
    m.disposeAll()
    expect(spawns[0].pty.killed).toBe(true)
    expect(spawns[1].pty.killed).toBe(true)
    expect(m.isRunning('s1')).toBe(false)
    expect(m.isRunning('s2')).toBe(false)
  })
})
