import { describe, it, expect } from 'vitest'
import { ptyEnv } from './clean-env'

describe('ptyEnv', () => {
  it('strips Claude Code child-session markers', () => {
    const env = ptyEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  it('sets TERM and drops undefined values', () => {
    const env = ptyEnv({ FOO: undefined, BAR: 'x' })
    expect(env.TERM).toBe('xterm-256color')
    expect(env.BAR).toBe('x')
    expect('FOO' in env).toBe(false)
  })
})
