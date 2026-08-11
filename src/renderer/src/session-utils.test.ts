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

import { shellQuotePath, droppedFilesText } from './session-utils'

describe('shellQuotePath', () => {
  it('quotes every path, even safe ones', () => {
    expect(shellQuotePath('/Users/alice/dev/app/src/index.ts')).toBe("'/Users/alice/dev/app/src/index.ts'")
    expect(shellQuotePath('~/notes.md')).toBe("'~/notes.md'")
  })

  it('single-quotes paths with spaces and specials', () => {
    expect(shellQuotePath('/Users/alice/My Docs/report (final).pdf')).toBe("'/Users/alice/My Docs/report (final).pdf'")
    expect(shellQuotePath('/tmp/$weird&name')).toBe("'/tmp/$weird&name'")
  })

  it("escapes embedded single quotes the POSIX way", () => {
    expect(shellQuotePath("/tmp/it's here.txt")).toBe("'/tmp/it'\\''s here.txt'")
  })
})

describe('droppedFilesText', () => {
  it('joins multiple paths with spaces and adds a trailing space', () => {
    expect(droppedFilesText(['/a/b.txt', '/c d/e.txt'])).toBe("'/a/b.txt' '/c d/e.txt' ")
  })

  it('returns empty string for no paths', () => {
    expect(droppedFilesText([])).toBe('')
    expect(droppedFilesText([''])).toBe('')
  })
})
