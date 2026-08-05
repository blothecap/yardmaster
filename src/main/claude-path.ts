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
