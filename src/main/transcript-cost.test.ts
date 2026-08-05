import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionCost } from './transcript-cost'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-tc-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeTranscript(lines: string[]): string {
  const p = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}

describe('sessionCost', () => {
  it('sums costUSD across assistant entries', async () => {
    const p = writeTranscript([
      JSON.stringify({ type: 'assistant', costUSD: 0.0123 }),
      JSON.stringify({ type: 'assistant', costUSD: 0.045 })
    ])
    const cost = await sessionCost(p)
    expect(cost.costUsd).toBeCloseTo(0.0573, 6)
    expect(cost.inputTokens).toBe(0)
    expect(cost.outputTokens).toBe(0)
  })

  it('sums input/output tokens from message.usage on usage-only entries', async () => {
    const p = writeTranscript([
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 75 } } })
    ])
    const cost = await sessionCost(p)
    expect(cost.costUsd).toBeNull() // no entry carried costUSD
    expect(cost.inputTokens).toBe(300)
    expect(cost.outputTokens).toBe(125)
  })

  it('combines costUSD and token usage when both present, skipping garbage/non-JSON lines', async () => {
    const p = writeTranscript([
      JSON.stringify({ type: 'assistant', costUSD: 0.01, message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      'not json at all {{{',
      '',
      JSON.stringify({ type: 'assistant', costUSD: 0.02, message: { usage: { input_tokens: 20, output_tokens: 8 } } })
    ])
    const cost = await sessionCost(p)
    expect(cost.costUsd).toBeCloseTo(0.03, 6)
    expect(cost.inputTokens).toBe(30)
    expect(cost.outputTokens).toBe(13)
  })

  it('returns zeroed/null result for a missing file', async () => {
    const cost = await sessionCost(path.join(dir, 'does-not-exist.jsonl'))
    expect(cost).toEqual({ costUsd: null, inputTokens: 0, outputTokens: 0 })
  })

  it('returns zeroed/null result when the file has no usable entries', async () => {
    const p = writeTranscript(['garbage', '{ not valid json', '123'])
    const cost = await sessionCost(p)
    expect(cost).toEqual({ costUsd: null, inputTokens: 0, outputTokens: 0 })
  })
})

describe('cache token accounting', () => {
  it('counts cache creation and cache read tokens as input volume', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cost-cache-'))
    const file = path.join(dir, 't.jsonl')
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 50 } }
    }) + '\n')
    const c = await sessionCost(file)
    expect(c.inputTokens).toBe(402)
    expect(c.outputTokens).toBe(50)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
