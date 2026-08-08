import { describe, it, expect } from 'vitest'
import { isNewerVersion, updateHelperScript } from './update-check'

describe('isNewerVersion', () => {
  it('detects higher versions across all segments', () => {
    expect(isNewerVersion('0.3.0', '0.2.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true)
  })

  it('is false for equal or older versions', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.2.0', '0.10.0')).toBe(false) // numeric, not lexicographic
  })

  it('tolerates v prefixes and short versions', () => {
    expect(isNewerVersion('v0.3.0', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.3', '0.2.9')).toBe(true)
    expect(isNewerVersion('garbage', '0.2.0')).toBe(false)
  })
})

describe('updateHelperScript', () => {
  it('waits on the given pid and falls back to reopening the app', () => {
    const s = updateHelperScript(12345)
    expect(s).toContain('kill -0 12345')
    expect(s).toContain('yard-master.vercel.app/install.sh')
    expect(s).toContain('open /Applications/Yardmaster.app')
  })
})
