import { describe, it, expect } from 'vitest'
import { shouldNotify } from './notify-policy'

const t = (from: string, to: string, id = 's1') =>
  ({ id, name: 'sess', from, to }) as Parameters<typeof shouldNotify>[0]

describe('shouldNotify', () => {
  it('notifies when a background session finishes working', () => {
    expect(shouldNotify(t('working', 'idle'), 'other')).toBe(true)
    expect(shouldNotify(t('working', 'idle'), null)).toBe(true)
  })

  it('notifies when a background session needs input', () => {
    expect(shouldNotify(t('working', 'needs-you'), 'other')).toBe(true)
  })

  it('never notifies for the active session', () => {
    expect(shouldNotify(t('working', 'idle', 's1'), 's1')).toBe(false)
    expect(shouldNotify(t('working', 'needs-you', 's1'), 's1')).toBe(false)
  })

  it('does not notify for transitions not coming from working (spawn noise)', () => {
    expect(shouldNotify(t('exited', 'idle'), 'other')).toBe(false)
    expect(shouldNotify(t('idle', 'needs-you'), 'other')).toBe(false)
  })

  it('does not notify on exit', () => {
    expect(shouldNotify(t('working', 'exited'), 'other')).toBe(false)
  })
})
