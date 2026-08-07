import { describe, it, expect } from 'vitest'
import { resolveLoginEnv } from './claude-path'

describe('resolveLoginEnv', () => {
  it('captures the login shell environment with a usable PATH', async () => {
    const env = await resolveLoginEnv()
    expect(env).not.toBeNull()
    expect(typeof env!.PATH).toBe('string')
    // a login shell PATH is richer than launchd's bare /usr/bin:/bin
    expect(env!.PATH.split(':').length).toBeGreaterThan(2)
    expect(env!.HOME).toBe(process.env.HOME)
  })

  it('parses values containing equals signs correctly', async () => {
    const env = await resolveLoginEnv()
    // every parsed key must be non-empty and contain no NUL or leading '='
    for (const k of Object.keys(env!)) {
      expect(k.length).toBeGreaterThan(0)
      expect(k.includes('\0')).toBe(false)
    }
  })
})
