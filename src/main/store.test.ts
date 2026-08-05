import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store'
import type { SessionMeta } from '../shared/types'

const sample: SessionMeta[] = [
  { id: 'a1', name: 'fix-auth', cwd: '/tmp/proj', claudeSessionId: 'cs-1', order: 0, worktree: { repoRoot: '/tmp/proj', branch: 'fix-auth', baseBranch: 'main' } },
  { id: 'b2', name: 'refactor', cwd: '/tmp/other', claudeSessionId: null, order: 1, worktree: null }
]

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-store-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('Store', () => {
  it('returns empty list when file does not exist', () => {
    const store = new Store(path.join(dir, 'sessions.json'))
    expect(store.load()).toEqual({ sessions: [], corruptBackupPath: null })
  })

  it('round-trips sessions', () => {
    const file = path.join(dir, 'sessions.json')
    new Store(file).save(sample)
    expect(new Store(file).load().sessions).toEqual(sample)
  })

  it('creates parent directory on save', () => {
    const file = path.join(dir, 'nested', 'deep', 'sessions.json')
    new Store(file).save(sample)
    expect(new Store(file).load().sessions).toEqual(sample)
  })

  it('backs up corrupt file and returns empty list with backup path', () => {
    const file = path.join(dir, 'sessions.json')
    fs.writeFileSync(file, '{not json!!')
    const result = new Store(file).load()
    expect(result.sessions).toEqual([])
    expect(result.corruptBackupPath).toMatch(/sessions\.json\.corrupt-/)
    expect(fs.existsSync(result.corruptBackupPath!)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('treats non-array JSON as corrupt', () => {
    const file = path.join(dir, 'sessions.json')
    fs.writeFileSync(file, '{"sessions": "nope"}')
    const result = new Store(file).load()
    expect(result.sessions).toEqual([])
    expect(result.corruptBackupPath).not.toBeNull()
  })

  it('atomic write: overwrite leaves valid JSON and no leftover tmp file', () => {
    const file = path.join(dir, 'sessions.json')
    const store = new Store(file)
    store.save(sample)
    store.save([sample[1]]) // overwrite
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow()
    expect(store.load().sessions).toEqual([sample[1]])
  })

  it('recovery failure path does not throw when renameSync fails', () => {
    const file = path.join(dir, 'sessions.json')
    fs.writeFileSync(file, '{not json!!')
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      const store = new Store(file)
      let result: ReturnType<typeof store.load> | undefined
      expect(() => { result = store.load() }).not.toThrow()
      expect(result).toEqual({ sessions: [], corruptBackupPath: null })
    } finally {
      spy.mockRestore()
    }
  })
})
