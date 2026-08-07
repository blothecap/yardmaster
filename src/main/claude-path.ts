import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function shellProbe(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL ?? '/bin/zsh', args, { timeout: 5000 }, (err, stdout) => {
      const p = stdout.trim().split('\n').pop() ?? ''
      resolve(err || !p ? null : p)
    })
  })
}

/** Candidate install locations, best-first. Exported for tests. */
export function knownClaudeLocations(home: string): string[] {
  const fixed = [
    path.join(home, '.local', 'bin', 'claude'), // native installer
    path.join(home, '.claude', 'local', 'claude'), // claude migrate-installer
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude')
  ]
  // npm-under-nvm: newest node version first
  let nvm: string[] = []
  try {
    const base = path.join(home, '.nvm', 'versions', 'node')
    nvm = fs
      .readdirSync(base)
      .sort()
      .reverse()
      .map((v) => path.join(base, v, 'bin', 'claude'))
  } catch {
    nvm = []
  }
  return [...fixed, ...nvm]
}

/**
 * GUI-launched Electron apps don't inherit the user's shell PATH, so resolve
 * the claude binary at startup. Try a login shell first (.zprofile), then an
 * interactive login shell (.zshrc — where most PATH edits actually live),
 * then well-known install locations.
 */
export async function resolveClaudePath(): Promise<string | null> {
  const fromLogin = await shellProbe(['-lc', 'command -v claude'])
  if (fromLogin) return fromLogin
  const fromInteractive = await shellProbe(['-lic', 'command -v claude'])
  if (fromInteractive) return fromInteractive
  for (const candidate of knownClaudeLocations(os.homedir())) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Finder-launched apps get launchd's minimal environment, so an npm-installed
 * `claude` (a `#!/usr/bin/env node` script) fails with "node: no such file".
 * Capture the user's full login-shell environment once so ptys behave like
 * their own terminal. Null-separated to survive multiline values.
 */
export function resolveLoginEnv(): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL ?? '/bin/zsh', ['-lc', 'env -0'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const env: Record<string, string> = {}
      for (const entry of stdout.split('\0')) {
        if (!entry) continue
        const eq = entry.indexOf('=')
        if (eq <= 0) continue
        env[entry.slice(0, eq)] = entry.slice(eq + 1)
      }
      resolve(Object.keys(env).length > 0 ? env : null)
    })
  })
}
