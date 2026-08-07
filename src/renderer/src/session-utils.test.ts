import { describe, it, expect } from 'vitest'
import { formatTokens } from './session-utils'

describe('formatTokens', () => {
  it('shows small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses k with one decimal below 100k', () => {
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(12_340)).toBe('12.3k')
    expect(formatTokens(99_940)).toBe('99.9k')
  })

  it('rounds k to integers from 100k', () => {
    expect(formatTokens(803_244)).toBe('803k')
    expect(formatTokens(999_400)).toBe('999k')
  })

  it('uses M and B for larger counts', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(803_244_000)).toBe('803M')
    expect(formatTokens(1_100_000_000)).toBe('1.1B')
  })

  it('drops trailing .0', () => {
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(3_000_000)).toBe('3M')
  })
})
