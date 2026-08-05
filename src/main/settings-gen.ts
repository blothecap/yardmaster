import fs from 'node:fs'
import path from 'node:path'
import { HOOK_EVENTS } from '../shared/types'

export function buildHookSettings(port: number, appSessionId: string): object {
  if (!/^[0-9a-zA-Z-]+$/.test(appSessionId)) {
    throw new Error(`invalid appSessionId: ${appSessionId}`)
  }
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) {
    const url = `http://127.0.0.1:${port}/hook/${appSessionId}/${event}`
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: `curl -s --max-time 2 -X POST '${url}' -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`
          }
        ]
      }
    ]
  }
  return { hooks }
}

export function writeSessionSettings(settingsDir: string, port: number, appSessionId: string): string {
  fs.mkdirSync(settingsDir, { recursive: true })
  const file = path.join(settingsDir, `session-${appSessionId}.settings.json`)
  fs.writeFileSync(file, JSON.stringify(buildHookSettings(port, appSessionId), null, 2))
  return file
}
