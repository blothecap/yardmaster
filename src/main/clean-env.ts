/**
 * Environment for spawned ptys. When the app itself is launched from inside a
 * Claude Code session (dev mode, or a user starting it from their terminal),
 * the child-session markers leak in and make every spawned Claude think it is
 * a nested child session — which silently disables transcript persistence
 * (breaking resume and the cost meter). Our sessions are top-level: scrub them.
 */
export function ptyEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}
