const RELEASES_API = 'https://api.github.com/repos/blothecap/yardmaster/releases/latest'

/** True when `latest` (e.g. "0.3.0" or "v0.3.0") is a higher semver than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Latest release tag ("0.3.0"), or null on any failure. Anonymous; never throws. */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'yardmaster-update-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: unknown }
    return typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null
  } catch {
    return null
  }
}

/**
 * Detached updater: waits for the app process to exit (respecting the quit
 * guard — gives up after 5 min if the user cancels), then pulls + rebuilds via
 * the public installer. The installer relaunches the app on success; on
 * failure we reopen the still-intact old install.
 */
export function updateHelperScript(pid: number): string {
  return `#!/bin/bash
i=0
while kill -0 ${pid} 2>/dev/null; do
  sleep 2; i=$((i+1))
  [ $i -ge 150 ] && exit 0
done
LOG="$HOME/Library/Logs/yardmaster-update.log"
echo "--- update $(date) ---" >> "$LOG"
if curl -fsSL https://yard-master.vercel.app/install.sh | bash >> "$LOG" 2>&1; then
  exit 0
fi
open /Applications/Yardmaster.app
`
}
