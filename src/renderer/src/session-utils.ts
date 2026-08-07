import type { SessionView } from '../../shared/types'

export function shortCwd(cwd: string, home: string): string {
  if (!home) return cwd
  if (cwd === home) return '~'
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length)
  return cwd
}

export function keyOf(s: SessionView): string {
  return s.worktree?.repoRoot ?? s.cwd
}

/** Last path segment; falls back to parent/name when another group shares the basename. */
export function projectName(key: string, allKeys: string[]): string {
  const parts = key.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? key
  const clash = allKeys.some((k) => {
    if (k === key) return false
    const p = k.split('/').filter(Boolean)
    return p[p.length - 1] === base
  })
  return clash && parts.length >= 2 ? `${parts[parts.length - 2]}/${base}` : base
}

/** Human-readable token count: 950, 12.3k, 803k, 1.2M, 803M, 1.1B. */
export function formatTokens(n: number): string {
  const fmt = (v: number, unit: string): string => {
    const r = v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')
    return `${r}${unit}`
  }
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return fmt(n / 1000, 'k')
  if (n < 1_000_000_000) return fmt(n / 1_000_000, 'M')
  return fmt(n / 1_000_000_000, 'B')
}

export function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
