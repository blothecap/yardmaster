import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HookServer } from './hook-server'
import type { HookEvent } from '../shared/types'

let server: HookServer
let port: number
let received: Array<{ id: string; event: HookEvent; payload: Record<string, unknown> }>

beforeEach(async () => {
  server = new HookServer()
  received = []
  server.onEvent((id, event, payload) => received.push({ id, event, payload }))
  port = await server.start()
})
afterEach(async () => { await server.stop() })

async function post(pathname: string, body: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  return res.status
}

describe('HookServer', () => {
  it('starts on an ephemeral port', () => {
    expect(port).toBeGreaterThan(0)
  })

  it('dispatches a valid hook call to the callback', async () => {
    const status = await post('/hook/app-1/Stop', JSON.stringify({ session_id: 'cs-9' }))
    expect(status).toBe(200)
    expect(received).toEqual([{ id: 'app-1', event: 'Stop', payload: { session_id: 'cs-9' } }])
  })

  it('accepts an empty/garbage body (payload defaults to {})', async () => {
    const status = await post('/hook/app-1/Notification', 'not json')
    expect(status).toBe(200)
    expect(received[0].payload).toEqual({})
  })

  it('rejects unknown event names with 404 and no callback', async () => {
    const status = await post('/hook/app-1/Sneaky', '{}')
    expect(status).toBe(404)
    expect(received).toEqual([])
  })

  it('rejects malformed paths with 404', async () => {
    expect(await post('/nope', '{}')).toBe(404)
    expect(await post('/hook/onlyone', '{}')).toBe(404)
  })
})
