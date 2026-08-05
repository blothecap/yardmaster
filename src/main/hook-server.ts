import http from 'node:http'
import { HOOK_EVENTS, type HookEvent } from '../shared/types'

export type HookCallback = (
  appSessionId: string,
  event: HookEvent,
  payload: Record<string, unknown>
) => void

export class HookServer {
  private server: http.Server | null = null
  private callback: HookCallback | null = null

  onEvent(cb: HookCallback): void {
    this.callback = cb
  }

  start(): Promise<number> {
    if (this.server) return Promise.reject(new Error('HookServer already started'))
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res))
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parts = (req.url ?? '').split('/').filter(Boolean) // ['hook', id, event]
    const [root, appSessionId, event] = parts
    if (req.method !== 'POST' || root !== 'hook' || !appSessionId || !HOOK_EVENTS.includes(event as HookEvent)) {
      res.statusCode = 404
      return res.end()
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed
      } catch { /* fire-and-forget contract: garbage in, empty payload */ }
      this.callback?.(appSessionId, event as HookEvent, payload)
      res.statusCode = 200
      res.end()
    })
  }
}
