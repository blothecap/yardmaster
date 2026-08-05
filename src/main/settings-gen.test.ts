import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildHookSettings, writeSessionSettings } from './settings-gen'
import { HOOK_EVENTS } from '../shared/types'

describe('buildHookSettings', () => {
  const settings = buildHookSettings(43210, 'app-uuid-1') as any

  it('defines exactly our four hook events and nothing else', () => {
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('each hook curls the right URL, pipes stdin, and can never fail', () => {
    for (const event of HOOK_EVENTS) {
      const cmd: string = settings.hooks[event][0].hooks[0].command
      expect(settings.hooks[event][0].hooks[0].type).toBe('command')
      expect(cmd).toContain(`http://127.0.0.1:43210/hook/app-uuid-1/${event}`)
      expect(cmd).toContain('--data-binary @-')
      expect(cmd).toContain('--max-time 2')
      expect(cmd.trim().endsWith('|| true')).toBe(true)
    }
  })
})

describe('writeSessionSettings', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-settings-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes a parseable settings file named after the app session id', () => {
    const file = writeSessionSettings(dir, 43210, 'app-uuid-1')
    expect(file).toBe(path.join(dir, 'session-app-uuid-1.settings.json'))
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(parsed).toEqual(buildHookSettings(43210, 'app-uuid-1'))
  })
})
