import fs from 'node:fs/promises'
import type { TranscriptCost } from '../shared/types'

// Re-exported for source compatibility — the shape is shared with SessionView, so its
// canonical definition lives in ../shared/types (same pattern as ChangedFile/git-review.ts).
export type { TranscriptCost }

/**
 * Reads a Claude Code transcript JSONL file and totals per-turn cost/token usage.
 * Tolerant of missing files and malformed lines — each line is parsed independently
 * and garbage lines are skipped rather than aborting the whole read.
 */
export async function sessionCost(transcriptPath: string): Promise<TranscriptCost> {
  let raw: string
  try {
    raw = await fs.readFile(transcriptPath, 'utf8')
  } catch {
    return { costUsd: null, inputTokens: 0, outputTokens: 0 }
  }

  let costUsd: number | null = null
  let inputTokens = 0
  let outputTokens = 0

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>

    if (typeof obj.costUSD === 'number') {
      costUsd = (costUsd ?? 0) + obj.costUSD
    }

    const usage = (obj.message as Record<string, unknown> | undefined)?.usage as
      | Record<string, unknown>
      | undefined
    if (usage) {
      // Cache tokens dominate real Claude Code sessions (input_tokens is often ~2);
      // count them as input so the meter reflects actual volume.
      if (typeof usage.cache_creation_input_tokens === 'number') {
        inputTokens += usage.cache_creation_input_tokens
      }
      if (typeof usage.cache_read_input_tokens === 'number') {
        inputTokens += usage.cache_read_input_tokens
      }
      if (typeof usage.input_tokens === 'number') inputTokens += usage.input_tokens
      if (typeof usage.output_tokens === 'number') outputTokens += usage.output_tokens
    }
  }

  return { costUsd, inputTokens, outputTokens }
}
