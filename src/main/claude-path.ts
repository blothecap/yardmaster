import { execFile } from 'node:child_process'

/**
 * GUI-launched Electron apps don't inherit the user's shell PATH, so resolve
 * the claude binary through a login shell once at startup.
 */
export function resolveClaudePath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL ?? '/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 }, (err, stdout) => {
      const p = stdout.trim()
      resolve(err || !p ? null : p)
    })
  })
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
