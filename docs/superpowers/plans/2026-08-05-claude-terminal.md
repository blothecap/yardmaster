# Claude Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated macOS Electron app that runs multiple named Claude Code sessions in an IDE-like layout — sidebar of sessions with live status, xterm.js terminal pane, keyboard switching, and OS notifications.

**Architecture:** Electron main process owns everything stateful: `SessionManager` (node-pty lifecycle + status state machine), `HookServer` (local HTTP endpoint that injected Claude Code hooks call), and `Store` (sessions.json). The React renderer is dumb: it renders state pushed over IPC and sends user intents back. One xterm.js instance per session, mounted once, toggled with CSS.

**Tech Stack:** Electron 43, electron-vite 5, React 19, TypeScript ^5.9, @xterm/xterm 6, node-pty 1.1, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-05-claude-terminal-design.md`

## Global Constraints

- macOS only; personal tool; run via `npm run dev` (no packaging/installer in v1).
- Dark theme only, one monospace font, no theming config.
- No daemon, no tmux, one window, no tabs/splits.
- Status comes from Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`) hitting a local HTTP server — never from parsing terminal output.
- Hook calls are fire-and-forget (`curl --max-time 2 … || true`); a failed hook must never block Claude.
- The generated per-session settings file contains ONLY hook additions; the user's own `~/.claude` settings must remain untouched.
- Sessions resume with `claude --resume <claudeSessionId>` lazily (on activation after relaunch), never eagerly at startup.
- Renderer has no business logic; main process is the single source of truth for session state.
- Unit tests (Vitest) cover Store, settings generation, HookServer, SessionManager, notification policy. Renderer is verified by manual smoke checklist only.
- Commit after every task (and after each green test cycle within a task where noted).

## File Structure

```
package.json, electron.vite.config.ts, vitest.config.ts, tsconfig.json, .gitignore
src/shared/types.ts            # Session types, status, hook events, IPC payloads
src/main/index.ts              # app entry: window, menu, wiring, notifications
src/main/store.ts              # sessions.json load/save with corrupt-file recovery
src/main/settings-gen.ts       # per-session Claude settings file with hook commands
src/main/hook-server.ts        # local HTTP listener for hook callbacks
src/main/session-manager.ts    # pty lifecycle + status state machine (deps injected)
src/main/claude-path.ts        # resolve claude binary via login shell
src/main/notify-policy.ts      # pure decision: should a transition notify?
src/main/*.test.ts             # Vitest unit tests colocated with modules
src/preload/index.ts           # contextBridge API
src/renderer/index.html
src/renderer/src/main.tsx      # React root
src/renderer/src/App.tsx       # layout, state, shortcut dispatch
src/renderer/src/app.css       # dark theme styles
src/renderer/src/terminal-registry.ts   # Map<sessionId, Terminal>
src/renderer/src/components/Sidebar.tsx
src/renderer/src/components/TerminalPane.tsx
src/renderer/src/components/NewSessionDialog.tsx
docs/smoke-checklist.md        # manual E2E checklist
```

---

### Task 1: Project scaffold + shared types

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `.gitignore`
- Create: `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/app.css`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the types every later task imports from `../shared/types`:
  `SessionStatus`, `SessionMeta`, `SessionView`, `HookEvent`, `ShortcutAction` (exact definitions below). A runnable empty Electron window via `npm run dev`.

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "claude-terminal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "postinstall": "electron-rebuild -f -w node-pty"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "node-pty": "^1.1.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^4.2.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.0",
    "electron": "^43.0.0",
    "electron-vite": "^5.0.0",
    "typescript": "^5.9.0",
    "vite": "^7.0.0",
    "vitest": "^4.1.0"
  }
}
```

`electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
out/
dist/
*.log
```

- [ ] **Step 2: Write shared types**

`src/shared/types.ts`:

```ts
export type SessionStatus = 'working' | 'needs-you' | 'idle' | 'exited'

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop'

export const HOOK_EVENTS: HookEvent[] = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop']

/** Persisted to sessions.json */
export interface SessionMeta {
  id: string // app-level UUID, not the Claude session id
  name: string
  cwd: string
  claudeSessionId: string | null
  order: number
}

/** Pushed to the renderer */
export interface SessionView extends SessionMeta {
  status: SessionStatus
  lastActivityAt: number | null
  statusChangedAt: number
}

export type ShortcutAction =
  | { type: 'jump'; index: number } // Cmd+1..9 (index 0-based)
  | { type: 'next' } // Cmd+J / Cmd+Shift+]
  | { type: 'prev' } // Cmd+K / Cmd+Shift+[
  | { type: 'new' } // Cmd+N
  | { type: 'rename' } // Cmd+R
  | { type: 'close' } // Cmd+W
  | { type: 'oldest-needs-you' } // Cmd+E
  | { type: 'toggle-sidebar' } // Cmd+B
```

- [ ] **Step 3: Write minimal main / preload / renderer**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Claude Terminal',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
```

`src/preload/index.ts` (placeholder, expanded in Task 6):

```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', { ping: (): string => 'pong' })
```

`src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>Claude Terminal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/renderer/src/App.tsx` (placeholder, replaced in Task 7):

```tsx
export default function App(): React.JSX.Element {
  return <div className="app">Claude Terminal</div>
}
```

`src/renderer/src/app.css`:

```css
:root {
  --bg: #16161e;
  --bg-sidebar: #1a1b26;
  --bg-hover: #24283b;
  --bg-active: #2f334d;
  --fg: #c0caf5;
  --fg-dim: #565f89;
  --accent: #7aa2f7;
  --status-working: #e0af68;
  --status-needs-you: #f7768e;
  --status-idle: #9ece6a;
  --status-exited: #565f89;
  --font-mono: 'SF Mono', 'Menlo', monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root, .app { height: 100%; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  user-select: none;
}
```

- [ ] **Step 4: Install and smoke-run**

Run: `npm install`
Expected: installs cleanly; postinstall rebuilds node-pty against Electron (prints `✔ Rebuild Complete` or similar). If rebuild fails, check Xcode CLT: `xcode-select -p` must print a path.

Run: `npm run dev`
Expected: a dark window titled "Claude Terminal" opens showing the text "Claude Terminal". Quit with Cmd+Q.

Run: `npm test`
Expected: Vitest reports "No test files found" — exits nonzero; that's fine until Task 2 adds tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold Electron + React + electron-vite project with shared types"
```

---

### Task 2: Store (sessions.json persistence)

**Files:**
- Create: `src/main/store.ts`
- Test: `src/main/store.test.ts`

**Interfaces:**
- Consumes: `SessionMeta` from `../shared/types`.
- Produces:
  ```ts
  class Store {
    constructor(filePath: string)
    load(): { sessions: SessionMeta[]; corruptBackupPath: string | null }
    save(sessions: SessionMeta[]): void
  }
  ```
  Later tasks construct it as `new Store(path.join(app.getPath('userData'), 'sessions.json'))`.

- [ ] **Step 1: Write the failing tests**

`src/main/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store'
import type { SessionMeta } from '../shared/types'

const sample: SessionMeta[] = [
  { id: 'a1', name: 'fix-auth', cwd: '/tmp/proj', claudeSessionId: 'cs-1', order: 0 },
  { id: 'b2', name: 'refactor', cwd: '/tmp/other', claudeSessionId: null, order: 1 }
]

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-store-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('Store', () => {
  it('returns empty list when file does not exist', () => {
    const store = new Store(path.join(dir, 'sessions.json'))
    expect(store.load()).toEqual({ sessions: [], corruptBackupPath: null })
  })

  it('round-trips sessions', () => {
    const file = path.join(dir, 'sessions.json')
    new Store(file).save(sample)
    expect(new Store(file).load().sessions).toEqual(sample)
  })

  it('creates parent directory on save', () => {
    const file = path.join(dir, 'nested', 'deep', 'sessions.json')
    new Store(file).save(sample)
    expect(new Store(file).load().sessions).toEqual(sample)
  })

  it('backs up corrupt file and returns empty list with backup path', () => {
    const file = path.join(dir, 'sessions.json')
    fs.writeFileSync(file, '{not json!!')
    const result = new Store(file).load()
    expect(result.sessions).toEqual([])
    expect(result.corruptBackupPath).toMatch(/sessions\.json\.corrupt-/)
    expect(fs.existsSync(result.corruptBackupPath!)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('treats non-array JSON as corrupt', () => {
    const file = path.join(dir, 'sessions.json')
    fs.writeFileSync(file, '{"sessions": "nope"}')
    const result = new Store(file).load()
    expect(result.sessions).toEqual([])
    expect(result.corruptBackupPath).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './store'` (or equivalent).

- [ ] **Step 3: Implement Store**

`src/main/store.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { SessionMeta } from '../shared/types'

export class Store {
  constructor(private filePath: string) {}

  load(): { sessions: SessionMeta[]; corruptBackupPath: string | null } {
    if (!fs.existsSync(this.filePath)) return { sessions: [], corruptBackupPath: null }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('sessions.json root must be an array')
      return { sessions: parsed as SessionMeta[], corruptBackupPath: null }
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      fs.renameSync(this.filePath, backup)
      return { sessions: [], corruptBackupPath: backup }
    }
  }

  save(sessions: SessionMeta[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(sessions, null, 2))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/store.ts src/main/store.test.ts
git commit -m "feat: sessions.json store with corrupt-file recovery"
```

---

### Task 3: Settings generator (hook injection)

**Files:**
- Create: `src/main/settings-gen.ts`
- Test: `src/main/settings-gen.test.ts`

**Interfaces:**
- Consumes: `HOOK_EVENTS`, `HookEvent` from `../shared/types`.
- Produces:
  ```ts
  function buildHookSettings(port: number, appSessionId: string): object
  function writeSessionSettings(settingsDir: string, port: number, appSessionId: string): string // returns absolute file path
  ```
  SessionManager (Task 5) injects `writeSessionSettings` (curried) as its `writeSettings` dependency; the real wiring happens in Task 6.

**Background for the implementer:** Claude Code merges `--settings <file>` on top of the user's own settings. Hook config shape is `{ "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "<shell command>" } ] } ] } }`. Each hook command receives a JSON payload on stdin (containing `session_id`, `hook_event_name`, etc.); our command pipes that stdin straight to the HookServer with curl.

- [ ] **Step 1: Write the failing tests**

`src/main/settings-gen.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildHookSettings, writeSessionSettings } from './settings-gen'
import { HOOK_EVENTS } from '../shared/types'

describe('buildHookSettings', () => {
  const settings = buildHookSettings(43210, 'app-uuid-1') as any

  it('defines exactly our four hook events and nothing else', () => {
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('each hook curls the right URL, pipes stdin, and can never fail', () => {
    for (const event of HOOK_EVENTS) {
      const cmd: string = settings.hooks[event][0].hooks[0].command
      expect(settings.hooks[event][0].hooks[0].type).toBe('command')
      expect(cmd).toContain(`http://127.0.0.1:43210/hook/app-uuid-1/${event}`)
      expect(cmd).toContain('--data-binary @-')
      expect(cmd).toContain('--max-time 2')
      expect(cmd.trim().endsWith('|| true')).toBe(true)
    }
  })
})

describe('writeSessionSettings', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-settings-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes a parseable settings file named after the app session id', () => {
    const file = writeSessionSettings(dir, 43210, 'app-uuid-1')
    expect(file).toBe(path.join(dir, 'session-app-uuid-1.settings.json'))
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(parsed).toEqual(buildHookSettings(43210, 'app-uuid-1'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './settings-gen'`.

- [ ] **Step 3: Implement**

`src/main/settings-gen.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { HOOK_EVENTS } from '../shared/types'

export function buildHookSettings(port: number, appSessionId: string): object {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (Store's 5 + these 3).

- [ ] **Step 5: Commit**

```bash
git add src/main/settings-gen.ts src/main/settings-gen.test.ts
git commit -m "feat: per-session Claude settings generator with status hooks"
```

---

### Task 4: HookServer

**Files:**
- Create: `src/main/hook-server.ts`
- Test: `src/main/hook-server.test.ts`

**Interfaces:**
- Consumes: `HookEvent`, `HOOK_EVENTS` from `../shared/types`.
- Produces:
  ```ts
  type HookCallback = (appSessionId: string, event: HookEvent, payload: Record<string, unknown>) => void
  class HookServer {
    onEvent(cb: HookCallback): void
    start(): Promise<number>   // resolves with the ephemeral port, listens on 127.0.0.1 only
    stop(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests** (real HTTP, no mocks)

`src/main/hook-server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './hook-server'`.

- [ ] **Step 3: Implement**

`src/main/hook-server.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hook-server.ts src/main/hook-server.test.ts
git commit -m "feat: local HTTP server receiving Claude Code hook callbacks"
```

---

### Task 5: SessionManager (core state machine)

**Files:**
- Create: `src/main/session-manager.ts`
- Test: `src/main/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionMeta`, `SessionView`, `SessionStatus`, `HookEvent` from `../shared/types`; `Store` from `./store` (test uses a real Store on a temp file).
- Produces:
  ```ts
  interface PtyLike {
    onData(cb: (data: string) => void): void
    onExit(cb: (e: { exitCode: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
  }
  interface SpawnOpts { cwd: string; settingsPath: string; resumeId: string | null }
  type PtySpawner = (opts: SpawnOpts) => PtyLike

  interface SessionManagerDeps {
    store: Store
    spawner: PtySpawner
    writeSettings: (appSessionId: string) => string
    now?: () => number // defaults to Date.now
  }

  class SessionManager extends EventEmitter {
    constructor(deps: SessionManagerDeps)
    list(): SessionView[]                       // sorted by order
    create(name: string, cwd: string): SessionView  // spawns immediately, status 'idle'
    activate(id: string): void                  // respawn if exited (uses --resume when claudeSessionId set)
    setActive(id: string | null): void
    getActiveId(): string | null
    rename(id: string, name: string): void
    close(id: string): void                     // kill pty -> 'exited', stays listed
    remove(id: string): void                    // kill + delete from store
    reorder(ids: string[]): void
    write(id: string, data: string): void       // '\r' in data => status 'working'
    resize(id: string, cols: number, rows: number): void
    handleHookEvent(appSessionId: string, event: HookEvent, payload: Record<string, unknown>): void
    disposeAll(): void                          // kill all ptys (app quit)
  }
  // Events emitted:
  //   'changed'            (views: SessionView[])
  //   'data'               (id: string, chunk: string)
  //   'status-transition'  ({ id, name, from, to }: { id: string; name: string; from: SessionStatus; to: SessionStatus })
  ```

**Behavior rules (implement exactly):**
1. `create`: id = `crypto.randomUUID()`, order = max+1, spawn fresh (no resume), status `idle`, persist.
2. Hook mapping: `SessionStart` → store `payload.session_id` as `claudeSessionId` (persist); `UserPromptSubmit` → `working`; `Notification` → `needs-you`; `Stop` → `idle`. Unknown `appSessionId` → ignore silently.
3. `write` forwards to pty; if the chunk contains `'\r'`, transition to `working` (instant feedback before the hook arrives).
4. Pty exit: normally → `exited`, pty ref cleared. **Resume fallback:** if the session was spawned with a resumeId, exited with code ≠ 0, and less than 5000 ms after spawn → emit `data` with `"\r\n[claude-terminal] resume failed — starting a fresh session\r\n"`, clear `claudeSessionId` (persist), respawn fresh instead of marking exited.
5. `activate` on an `exited` session: `writeSettings(id)` again, spawn with `resumeId = claudeSessionId`, status `idle`. On a live session: no-op.
6. Every transition updates `statusChangedAt`; `data` from pty and hook events update `lastActivityAt`. Transitions to the same status do not emit `status-transition` (but `changed` still fires on meta edits).
7. Any mutation (create/rename/remove/reorder/claudeSessionId change) persists via `store.save` and emits `changed`.

- [ ] **Step 1: Write the failing tests**

`src/main/session-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager, type PtyLike, type SpawnOpts } from './session-manager'
import { Store } from './store'

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: ((e: { exitCode: number }) => void) | null = null
  written: string[] = []
  killed = false
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(): void {}
  kill(): void { this.killed = true; this.exitCb?.({ exitCode: 0 }) }
}

let dir: string
let store: Store
let spawns: Array<{ opts: SpawnOpts; pty: FakePty }>
let clock: { t: number }

function makeManager(): SessionManager {
  return new SessionManager({
    store,
    spawner: (opts) => {
      const pty = new FakePty()
      spawns.push({ opts, pty })
      return pty
    },
    writeSettings: (id) => `/fake/settings-${id}.json`,
    now: () => clock.t
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sm-'))
  store = new Store(path.join(dir, 'sessions.json'))
  spawns = []
  clock = { t: 1000 }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('create', () => {
  it('spawns claude fresh in the cwd with generated settings, status idle, persisted', () => {
    const m = makeManager()
    const view = m.create('fix-auth', '/tmp/proj')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].opts).toEqual({ cwd: '/tmp/proj', settingsPath: `/fake/settings-${view.id}.json`, resumeId: null })
    expect(view.status).toBe('idle')
    expect(store.load().sessions).toHaveLength(1)
  })

  it('assigns increasing order', () => {
    const m = makeManager()
    const a = m.create('a', '/tmp')
    const b = m.create('b', '/tmp')
    expect(a.order).toBe(0)
    expect(b.order).toBe(1)
  })
})

describe('hook events', () => {
  it('SessionStart records claudeSessionId and persists it', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-42' })
    expect(m.list()[0].claudeSessionId).toBe('cs-42')
    expect(store.load().sessions[0].claudeSessionId).toBe('cs-42')
  })

  it('maps UserPromptSubmit/Notification/Stop to statuses and emits transitions', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const transitions: Array<{ from: string; to: string }> = []
    m.on('status-transition', (t) => transitions.push({ from: t.from, to: t.to }))
    m.handleHookEvent(v.id, 'UserPromptSubmit', {})
    m.handleHookEvent(v.id, 'Notification', {})
    m.handleHookEvent(v.id, 'Stop', {})
    expect(transitions).toEqual([
      { from: 'idle', to: 'working' },
      { from: 'working', to: 'needs-you' },
      { from: 'needs-you', to: 'idle' }
    ])
  })

  it('ignores unknown session ids', () => {
    const m = makeManager()
    expect(() => m.handleHookEvent('ghost', 'Stop', {})).not.toThrow()
  })

  it('same-status hook does not emit a transition', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const spy = vi.fn()
    m.on('status-transition', spy)
    m.handleHookEvent(v.id, 'Stop', {}) // already idle
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('write', () => {
  it('forwards keystrokes and flips to working on Enter', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.write(v.id, 'hello')
    expect(m.list()[0].status).toBe('idle')
    m.write(v.id, '\r')
    expect(spawns[0].pty.written).toEqual(['hello', '\r'])
    expect(m.list()[0].status).toBe('working')
  })
})

describe('exit, close, activate, remove', () => {
  it('pty exit marks session exited', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    spawns[0].pty.exitCb!({ exitCode: 0 })
    expect(m.list()[0].status).toBe('exited')
  })

  it('close kills the pty but keeps the session listed', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.close(v.id)
    expect(spawns[0].pty.killed).toBe(true)
    expect(m.list()).toHaveLength(1)
    expect(m.list()[0].status).toBe('exited')
  })

  it('activate respawns an exited session with --resume id', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-42' })
    m.close(v.id)
    m.activate(v.id)
    expect(spawns).toHaveLength(2)
    expect(spawns[1].opts.resumeId).toBe('cs-42')
    expect(m.list()[0].status).toBe('idle')
  })

  it('activate on a live session does not respawn', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.activate(v.id)
    expect(spawns).toHaveLength(1)
  })

  it('remove deletes from store', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    m.remove(v.id)
    expect(m.list()).toHaveLength(0)
    expect(store.load().sessions).toHaveLength(0)
  })
})

describe('resume fallback', () => {
  function resumedSession(m: SessionManager): string {
    const v = m.create('a', '/tmp/proj')
    m.handleHookEvent(v.id, 'SessionStart', { session_id: 'cs-old' })
    m.close(v.id)
    m.activate(v.id) // spawns[1] with resumeId cs-old
    return v.id
  }

  it('fast nonzero exit after resume respawns fresh and clears claudeSessionId', () => {
    const m = makeManager()
    const id = resumedSession(m)
    const chunks: string[] = []
    m.on('data', (_id: string, c: string) => chunks.push(c))
    clock.t += 2000 // < 5000ms
    spawns[1].pty.exitCb!({ exitCode: 1 })
    expect(spawns).toHaveLength(3)
    expect(spawns[2].opts.resumeId).toBeNull()
    expect(m.list()[0].claudeSessionId).toBeNull()
    expect(chunks.join('')).toContain('resume failed')
    expect(m.list()[0].status).toBe('idle')
  })

  it('slow exit after resume is a normal exit', () => {
    const m = makeManager()
    resumedSession(m)
    clock.t += 60000
    spawns[1].pty.exitCb!({ exitCode: 1 })
    expect(spawns).toHaveLength(2)
    expect(m.list()[0].status).toBe('exited')
  })
})

describe('restore from store', () => {
  it('lists persisted sessions as exited without spawning', () => {
    store.save([{ id: 'x1', name: 'old', cwd: '/tmp', claudeSessionId: 'cs-1', order: 0 }])
    const m = makeManager()
    expect(spawns).toHaveLength(0)
    expect(m.list()).toHaveLength(1)
    expect(m.list()[0].status).toBe('exited')
  })
})

describe('reorder and rename', () => {
  it('reorder rewrites order fields and list() sorts by them', () => {
    const m = makeManager()
    const a = m.create('a', '/tmp')
    const b = m.create('b', '/tmp')
    m.reorder([b.id, a.id])
    expect(m.list().map((s) => s.name)).toEqual(['b', 'a'])
  })

  it('rename persists and emits changed', () => {
    const m = makeManager()
    const v = m.create('a', '/tmp')
    const spy = vi.fn()
    m.on('changed', spy)
    m.rename(v.id, 'better-name')
    expect(store.load().sessions[0].name).toBe('better-name')
    expect(spy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './session-manager'`.

- [ ] **Step 3: Implement**

`src/main/session-manager.ts`:

```ts
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { HookEvent, SessionMeta, SessionStatus, SessionView } from '../shared/types'
import type { Store } from './store'

export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOpts {
  cwd: string
  settingsPath: string
  resumeId: string | null
}

export type PtySpawner = (opts: SpawnOpts) => PtyLike

export interface SessionManagerDeps {
  store: Store
  spawner: PtySpawner
  writeSettings: (appSessionId: string) => string
  now?: () => number
}

const RESUME_FAIL_WINDOW_MS = 5000

interface InternalSession {
  meta: SessionMeta
  status: SessionStatus
  pty: PtyLike | null
  lastActivityAt: number | null
  statusChangedAt: number
  spawnedAt: number
  spawnedWithResume: boolean
  closing: boolean
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, InternalSession>()
  private deps: Required<SessionManagerDeps>
  private activeId: string | null = null

  constructor(deps: SessionManagerDeps) {
    super()
    this.deps = { now: Date.now, ...deps }
    for (const meta of this.deps.store.load().sessions) {
      this.sessions.set(meta.id, {
        meta,
        status: 'exited',
        pty: null,
        lastActivityAt: null,
        statusChangedAt: this.deps.now(),
        spawnedAt: 0,
        spawnedWithResume: false,
        closing: false
      })
    }
  }

  list(): SessionView[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.meta.order - b.meta.order)
      .map((s) => ({
        ...s.meta,
        status: s.status,
        lastActivityAt: s.lastActivityAt,
        statusChangedAt: s.statusChangedAt
      }))
  }

  create(name: string, cwd: string): SessionView {
    const order = Math.max(-1, ...[...this.sessions.values()].map((s) => s.meta.order)) + 1
    const meta: SessionMeta = { id: crypto.randomUUID(), name, cwd, claudeSessionId: null, order }
    const session: InternalSession = {
      meta,
      status: 'idle',
      pty: null,
      lastActivityAt: null,
      statusChangedAt: this.deps.now(),
      spawnedAt: 0,
      spawnedWithResume: false,
      closing: false
    }
    this.sessions.set(meta.id, session)
    this.spawn(session, null)
    this.persist()
    return this.list().find((v) => v.id === meta.id)!
  }

  activate(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.pty) return
    this.spawn(s, s.meta.claudeSessionId)
    this.transition(s, 'idle')
    this.emitChanged()
  }

  setActive(id: string | null): void {
    this.activeId = id
  }

  getActiveId(): string | null {
    return this.activeId
  }

  rename(id: string, name: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.meta.name = name
    this.persist()
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    s.closing = true
    s.pty.kill()
  }

  remove(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.closing = true
    s.pty?.kill()
    this.sessions.delete(id)
    this.persist()
  }

  reorder(ids: string[]): void {
    ids.forEach((id, i) => {
      const s = this.sessions.get(id)
      if (s) s.meta.order = i
    })
    this.persist()
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    s.pty.write(data)
    if (data.includes('\r')) {
      this.transition(s, 'working')
      this.emitChanged()
    }
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty?.resize(cols, rows)
  }

  handleHookEvent(appSessionId: string, event: HookEvent, payload: Record<string, unknown>): void {
    const s = this.sessions.get(appSessionId)
    if (!s) return
    s.lastActivityAt = this.deps.now()
    if (event === 'SessionStart') {
      const sid = payload.session_id
      if (typeof sid === 'string' && sid && s.meta.claudeSessionId !== sid) {
        s.meta.claudeSessionId = sid
        this.persist()
        return
      }
    } else if (event === 'UserPromptSubmit') {
      this.transition(s, 'working')
    } else if (event === 'Notification') {
      this.transition(s, 'needs-you')
    } else if (event === 'Stop') {
      this.transition(s, 'idle')
    }
    this.emitChanged()
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      s.closing = true
      s.pty?.kill()
    }
  }

  private spawn(s: InternalSession, resumeId: string | null): void {
    const settingsPath = this.deps.writeSettings(s.meta.id)
    s.pty = this.deps.spawner({ cwd: s.meta.cwd, settingsPath, resumeId })
    s.spawnedAt = this.deps.now()
    s.spawnedWithResume = resumeId !== null
    s.closing = false
    s.pty.onData((chunk) => {
      s.lastActivityAt = this.deps.now()
      this.emit('data', s.meta.id, chunk)
    })
    s.pty.onExit(({ exitCode }) => this.handleExit(s, exitCode))
  }

  private handleExit(s: InternalSession, exitCode: number): void {
    const wasClosing = s.closing
    s.pty = null
    const fastResumeFailure =
      !wasClosing &&
      s.spawnedWithResume &&
      exitCode !== 0 &&
      this.deps.now() - s.spawnedAt < RESUME_FAIL_WINDOW_MS
    if (fastResumeFailure) {
      this.emit('data', s.meta.id, '\r\n[claude-terminal] resume failed — starting a fresh session\r\n')
      s.meta.claudeSessionId = null
      this.spawn(s, null)
      this.transition(s, 'idle')
      this.persist()
      return
    }
    this.transition(s, 'exited')
    this.emitChanged()
  }

  private transition(s: InternalSession, to: SessionStatus): void {
    if (s.status === to) return
    const from = s.status
    s.status = to
    s.statusChangedAt = this.deps.now()
    this.emit('status-transition', { id: s.meta.id, name: s.meta.name, from, to })
  }

  private persist(): void {
    this.deps.store.save([...this.sessions.values()].map((s) => s.meta))
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (should be ~28 across 4 files).

- [ ] **Step 5: Commit**

```bash
git add src/main/session-manager.ts src/main/session-manager.test.ts
git commit -m "feat: SessionManager pty lifecycle and hook-driven status state machine"
```

---

### Task 6: Main-process wiring (claude path, real spawner, IPC, preload, menu)

**Files:**
- Create: `src/main/claude-path.ts`
- Modify: `src/main/index.ts` (full replacement below)
- Modify: `src/preload/index.ts` (full replacement below)
- Create: `src/preload/index.d.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `window.api` (exact shape in `index.d.ts` below) — the ONLY surface the renderer may use. Menu-driven shortcut events arrive as `api.onShortcut(cb)` with `ShortcutAction` payloads.

- [ ] **Step 1: Implement claude-path**

`src/main/claude-path.ts`:

```ts
import { execFile } from 'node:child_process'

/**
 * GUI-launched Electron apps don't inherit the user's shell PATH, so resolve
 * the claude binary through a login shell once at startup.
 */
export function resolveClaudePath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL ?? '/bin/zsh', ['-lc', 'command -v claude'], (err, stdout) => {
      const p = stdout.trim()
      resolve(err || !p ? null : p)
    })
  })
}
```

- [ ] **Step 2: Implement full main entry**

`src/main/index.ts` (replace entirely):

```ts
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron'
import path from 'node:path'
import * as pty from 'node-pty' // CJS module — namespace import, not default
import type { ShortcutAction } from '../shared/types'
import { Store } from './store'
import { writeSessionSettings } from './settings-gen'
import { HookServer } from './hook-server'
import { SessionManager, type SpawnOpts } from './session-manager'
import { resolveClaudePath } from './claude-path'
import { shouldNotify } from './notify-policy'

let win: BrowserWindow | null = null
let manager: SessionManager | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Claude Terminal',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

function sendShortcut(action: ShortcutAction): void {
  win?.webContents.send('app:shortcut', action)
}

function buildMenu(): void {
  const jumpItems = Array.from({ length: 9 }, (_, i) => ({
    label: `Session ${i + 1}`,
    accelerator: `Cmd+${i + 1}`,
    click: () => sendShortcut({ type: 'jump', index: i })
  }))
  const menu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Session',
      submenu: [
        { label: 'New Session', accelerator: 'Cmd+N', click: () => sendShortcut({ type: 'new' }) },
        { label: 'Rename Session', accelerator: 'Cmd+R', click: () => sendShortcut({ type: 'rename' }) },
        { label: 'Close Session', accelerator: 'Cmd+W', click: () => sendShortcut({ type: 'close' }) },
        { type: 'separator' },
        ...jumpItems
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        { label: 'Next Session', accelerator: 'Cmd+J', click: () => sendShortcut({ type: 'next' }) },
        { label: 'Previous Session', accelerator: 'Cmd+K', click: () => sendShortcut({ type: 'prev' }) },
        { label: 'Next Session (alt)', accelerator: 'Cmd+Shift+]', click: () => sendShortcut({ type: 'next' }) },
        { label: 'Previous Session (alt)', accelerator: 'Cmd+Shift+[', click: () => sendShortcut({ type: 'prev' }) },
        { label: 'Oldest Needs-You', accelerator: 'Cmd+E', click: () => sendShortcut({ type: 'oldest-needs-you' }) },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => sendShortcut({ type: 'toggle-sidebar' }) }
      ]
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(async () => {
  buildMenu()

  const claudePath = await resolveClaudePath()
  const hookServer = new HookServer()
  const port = await hookServer.start()
  const userData = app.getPath('userData')
  const store = new Store(path.join(userData, 'sessions.json'))
  const { corruptBackupPath } = store.load()
  const settingsDir = path.join(userData, 'session-settings')

  const adapt = (proc: pty.IPty) => ({
    onData: (cb: (d: string) => void) => proc.onData(cb),
    onExit: (cb: (e: { exitCode: number }) => void) => proc.onExit(cb),
    write: (d: string) => proc.write(d),
    resize: (c: number, r: number) => proc.resize(c, r),
    kill: () => proc.kill()
  })
  const spawner = (opts: SpawnOpts): ReturnType<typeof adapt> => {
    const args = ['--settings', opts.settingsPath, ...(opts.resumeId ? ['--resume', opts.resumeId] : [])]
    const proc = pty.spawn(claudePath!, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    return adapt(proc)
  }

  manager = new SessionManager({
    store,
    spawner,
    writeSettings: (appSessionId) => writeSessionSettings(settingsDir, port, appSessionId)
  })

  hookServer.onEvent((id, event, payload) => manager!.handleHookEvent(id, event, payload))

  manager.on('changed', (views) => {
    win?.webContents.send('sessions:changed', views)
    app.setBadgeCount(views.filter((v: { status: string }) => v.status === 'needs-you').length)
  })
  manager.on('data', (id, chunk) => win?.webContents.send('sessions:data', { id, data: chunk }))
  manager.on('status-transition', (t) => {
    if (shouldNotify(t, manager!.getActiveId())) {
      const n = new Notification({
        title: t.name,
        body: t.to === 'needs-you' ? 'Needs your input' : 'Finished responding'
      })
      n.on('click', () => {
        win?.show()
        win?.webContents.send('sessions:focus', t.id)
      })
      n.show()
    }
  })

  // IPC
  ipcMain.handle('app:init', () => ({
    claudeFound: claudePath !== null,
    corruptBackupPath,
    home: app.getPath('home'),
    sessions: manager!.list()
  }))
  ipcMain.handle('sessions:create', (_e, { name, cwd }) => manager!.create(name, cwd))
  ipcMain.handle('sessions:activate', (_e, id) => manager!.activate(id))
  ipcMain.handle('sessions:setActive', (_e, id) => manager!.setActive(id))
  ipcMain.handle('sessions:rename', (_e, { id, name }) => manager!.rename(id, name))
  ipcMain.handle('sessions:close', (_e, id) => manager!.close(id))
  ipcMain.handle('sessions:remove', (_e, id) => manager!.remove(id))
  ipcMain.handle('sessions:reorder', (_e, ids) => manager!.reorder(ids))
  ipcMain.on('sessions:input', (_e, { id, data }) => manager!.write(id, data))
  ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => manager!.resize(id, cols, rows))
  ipcMain.handle('app:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  createWindow()
})

app.on('before-quit', () => manager?.disposeAll())
app.on('window-all-closed', () => app.quit())
```

Note: `notify-policy` is imported here but implemented in Task 7's sibling — to keep this task runnable, create the stub now (real tests come in Task 11):

`src/main/notify-policy.ts`:

```ts
import type { SessionStatus } from '../shared/types'

export interface Transition {
  id: string
  name: string
  from: SessionStatus
  to: SessionStatus
}

/** Notify only for background sessions finishing work or needing input. */
export function shouldNotify(t: Transition, activeId: string | null): boolean {
  if (t.id === activeId) return false
  if (t.from !== 'working') return false
  return t.to === 'needs-you' || t.to === 'idle'
}
```

- [ ] **Step 3: Implement preload + types**

`src/preload/index.ts` (replace entirely):

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { SessionView, ShortcutAction } from '../shared/types'

export interface InitState {
  claudeFound: boolean
  corruptBackupPath: string | null
  home: string
  sessions: SessionView[]
}

const api = {
  init: (): Promise<InitState> => ipcRenderer.invoke('app:init'),
  create: (name: string, cwd: string): Promise<SessionView> =>
    ipcRenderer.invoke('sessions:create', { name, cwd }),
  activate: (id: string): Promise<void> => ipcRenderer.invoke('sessions:activate', id),
  setActive: (id: string | null): Promise<void> => ipcRenderer.invoke('sessions:setActive', id),
  rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('sessions:rename', { id, name }),
  close: (id: string): Promise<void> => ipcRenderer.invoke('sessions:close', id),
  remove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id),
  reorder: (ids: string[]): Promise<void> => ipcRenderer.invoke('sessions:reorder', ids),
  input: (id: string, data: string): void => ipcRenderer.send('sessions:input', { id, data }),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('sessions:resize', { id, cols, rows }),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('app:pickDirectory'),
  onChanged: (cb: (views: SessionView[]) => void): void => {
    ipcRenderer.on('sessions:changed', (_e, views) => cb(views))
  },
  onData: (cb: (id: string, data: string) => void): void => {
    ipcRenderer.on('sessions:data', (_e, { id, data }) => cb(id, data))
  },
  onFocus: (cb: (id: string) => void): void => {
    ipcRenderer.on('sessions:focus', (_e, id) => cb(id))
  },
  onShortcut: (cb: (action: ShortcutAction) => void): void => {
    ipcRenderer.on('app:shortcut', (_e, action) => cb(action))
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
```

`src/preload/index.d.ts`:

```ts
import type { Api } from './index'

declare global {
  interface Window {
    api: Api
  }
}
```

- [ ] **Step 4: Verify it runs**

Run: `npm test`
Expected: all existing tests still PASS.

Run: `npm run dev`
Expected: window opens (still the placeholder UI). In the devtools console (Cmd+Option+I) run `await window.api.init()` — expect `{ claudeFound: true, corruptBackupPath: null, home: "/Users/…", sessions: [] }`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire main process — real pty spawner, hook server, IPC, menu shortcuts"
```

---

### Task 7: Renderer shell — App state + Sidebar

**Files:**
- Create: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx` (full replacement)
- Modify: `src/renderer/src/app.css` (append styles)

**Interfaces:**
- Consumes: `window.api` (Task 6), `SessionView`, `ShortcutAction` from `../../shared/types`.
- Produces: `<Sidebar>` props contract used by App:
  ```ts
  interface SidebarProps {
    sessions: SessionView[]
    activeId: string | null
    collapsed: boolean
    home: string
    renamingId: string | null
    onSelect(id: string): void
    onRename(id: string, name: string): void
    onRenameStart(id: string): void
    onRenameEnd(): void
    onRemove(id: string): void
    onReorder(ids: string[]): void
    onNew(): void
  }
  ```
  App exports nothing new but establishes: `activeId` state, `switchTo(id)` = `setActive` + `activate` + focus, and shortcut dispatch. Terminal area is a placeholder `<div>` until Task 8.

- [ ] **Step 1: Implement App**

`src/renderer/src/App.tsx` (replace entirely):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionView, ShortcutAction } from '../../shared/types'
import Sidebar from './components/Sidebar'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [claudeFound, setClaudeFound] = useState(true)
  const [corruptBackup, setCorruptBackup] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Refs mirror state that shortcut/event handlers need without re-subscribing
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const switchTo = useCallback((id: string) => {
    setActiveId(id)
    window.api.setActive(id)
    window.api.activate(id)
  }, [])

  useEffect(() => {
    window.api.init().then((init) => {
      setClaudeFound(init.claudeFound)
      setCorruptBackup(init.corruptBackupPath)
      setHome(init.home)
      setSessions(init.sessions)
      if (init.sessions.length > 0) switchTo(init.sessions[0].id)
    })
    window.api.onChanged(setSessions)
    window.api.onFocus((id) => switchTo(id))
    window.api.onShortcut((action) => handleShortcut(action))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleShortcut = useCallback((action: ShortcutAction) => {
    const list = sessionsRef.current
    const current = activeIdRef.current
    const idx = list.findIndex((s) => s.id === current)
    switch (action.type) {
      case 'jump':
        if (list[action.index]) switchTo(list[action.index].id)
        break
      case 'next':
        if (list.length) switchTo(list[(idx + 1) % list.length].id)
        break
      case 'prev':
        if (list.length) switchTo(list[(idx - 1 + list.length) % list.length].id)
        break
      case 'new':
        setDialogOpen(true)
        break
      case 'rename':
        if (current) setRenamingId(current)
        break
      case 'close':
        if (current) window.api.close(current)
        break
      case 'oldest-needs-you': {
        const needy = list
          .filter((s) => s.status === 'needs-you')
          .sort((a, b) => a.statusChangedAt - b.statusChangedAt)
        if (needy[0]) switchTo(needy[0].id)
        break
      }
      case 'toggle-sidebar':
        setCollapsed((c) => !c)
        break
    }
  }, [switchTo])

  if (!claudeFound) {
    return (
      <div className="app fullscreen-message">
        <h1>claude not found</h1>
        <p>
          Claude Terminal could not find the <code>claude</code> binary on your PATH.
          Install Claude Code (<code>npm install -g @anthropic-ai/claude-code</code>) or make
          sure your login shell exposes it, then relaunch this app.
        </p>
      </div>
    )
  }

  return (
    <div className="app layout">
      {!collapsed && (
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          collapsed={collapsed}
          home={home}
          renamingId={renamingId}
          onSelect={switchTo}
          onRename={(id, name) => { window.api.rename(id, name); setRenamingId(null) }}
          onRenameStart={setRenamingId}
          onRenameEnd={() => setRenamingId(null)}
          onRemove={(id) => window.api.remove(id)}
          onReorder={(ids) => window.api.reorder(ids)}
          onNew={() => setDialogOpen(true)}
        />
      )}
      <main className="terminal-area">
        {corruptBackup && (
          <div className="banner">
            sessions.json was corrupt — a backup was saved to {corruptBackup}
          </div>
        )}
        {/* TerminalPane mounts here in Task 8; NewSessionDialog in Task 9 */}
        {sessions.length === 0 && (
          <div className="empty-state">No sessions yet — press ⌘N to create one.</div>
        )}
      </main>
      {dialogOpen && <div className="dialog-placeholder" onClick={() => setDialogOpen(false)} />}
    </div>
  )
}
```

- [ ] **Step 2: Implement Sidebar**

`src/renderer/src/components/Sidebar.tsx`:

```tsx
import { useRef, useState } from 'react'
import type { SessionView } from '../../../shared/types'

interface SidebarProps {
  sessions: SessionView[]
  activeId: string | null
  collapsed: boolean
  home: string
  renamingId: string | null
  onSelect(id: string): void
  onRename(id: string, name: string): void
  onRenameStart(id: string): void
  onRenameEnd(): void
  onRemove(id: string): void
  onReorder(ids: string[]): void
  onNew(): void
}

function shortCwd(cwd: string, home: string): string {
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function Sidebar(props: SidebarProps): React.JSX.Element {
  const dragId = useRef<string | null>(null)
  const [editText, setEditText] = useState('')

  const handleDrop = (targetId: string): void => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const ids = props.sessions.map((s) => s.id)
    ids.splice(ids.indexOf(targetId), 0, ...ids.splice(ids.indexOf(from), 1))
    props.onReorder(ids)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Sessions</span>
        <button className="new-btn" title="New session (⌘N)" onClick={props.onNew}>+</button>
      </div>
      <ul>
        {props.sessions.map((s) => (
          <li
            key={s.id}
            draggable
            onDragStart={() => { dragId.current = s.id }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(s.id)}
            className={[
              'session-row',
              s.id === props.activeId ? 'active' : '',
              s.status === 'needs-you' ? 'needs-you' : ''
            ].join(' ')}
            onClick={() => props.onSelect(s.id)}
            onDoubleClick={() => { setEditText(s.name); props.onRenameStart(s.id) }}
          >
            <span className={`dot dot-${s.status}`} />
            {props.renamingId === s.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onFocus={(e) => { setEditText(s.name); e.target.select() }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editText.trim()) props.onRename(s.id, editText.trim())
                  if (e.key === 'Escape') props.onRenameEnd()
                }}
                onBlur={() => props.onRenameEnd()}
              />
            ) : (
              <div className="session-labels">
                <div className="session-name">{s.name}</div>
                <div className="session-cwd">{shortCwd(s.cwd, props.home)}</div>
              </div>
            )}
            <span className="session-time">{relativeTime(s.lastActivityAt)}</span>
            <button
              className="remove-btn"
              title="Remove session"
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Remove session "${s.name}"? This deletes it from the sidebar.`)) {
                  props.onRemove(s.id)
                }
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 3: Append styles**

Append to `src/renderer/src/app.css`:

```css
.layout { display: flex; }
.sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--bg-sidebar);
  border-right: 1px solid #101014;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  color: var(--fg-dim);
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.08em;
}
.new-btn, .remove-btn {
  background: none;
  border: none;
  color: var(--fg-dim);
  font-size: 14px;
  cursor: pointer;
}
.new-btn:hover, .remove-btn:hover { color: var(--fg); }
.sidebar ul { list-style: none; }
.session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
}
.session-row:hover { background: var(--bg-hover); }
.session-row.active { background: var(--bg-active); }
.session-row .remove-btn { visibility: hidden; }
.session-row:hover .remove-btn { visibility: visible; }
.session-labels { flex: 1; min-width: 0; }
.session-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-cwd { color: var(--fg-dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-time { color: var(--fg-dim); font-size: 10px; }
.session-row input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--accent);
  color: var(--fg);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 13px;
}
.dot { width: 8px; height: 8px; min-width: 8px; border-radius: 50%; }
.dot-working { background: var(--status-working); animation: pulse 1.2s ease-in-out infinite; }
.dot-needs-you { background: var(--status-needs-you); }
.dot-idle { background: var(--status-idle); }
.dot-exited { background: var(--status-exited); }
@keyframes pulse { 50% { opacity: 0.3; } }
.terminal-area { flex: 1; position: relative; min-width: 0; }
.banner {
  background: #3b2d3a;
  color: #f7768e;
  padding: 6px 12px;
  font-size: 12px;
}
.empty-state, .fullscreen-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--fg-dim);
  gap: 12px;
  text-align: center;
  padding: 40px;
}
.fullscreen-message h1 { color: var(--fg); font-size: 20px; }
.fullscreen-message code { font-family: var(--font-mono); color: var(--accent); }
```

- [ ] **Step 4: Verify manually**

Run: `npm run dev`
Expected: sidebar with "Sessions" header and + button; empty state message in main area; Cmd+B hides/shows the sidebar. (Creating sessions isn't wired to a real dialog yet — clicking + shows nothing but must not error.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: renderer shell with session sidebar, status dots, shortcut dispatch"
```

---

### Task 8: TerminalPane (xterm.js) + data flow

**Files:**
- Create: `src/renderer/src/terminal-registry.ts`
- Create: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/App.tsx` (add pane mounting + data dispatch)
- Modify: `src/renderer/src/app.css` (append)

**Interfaces:**
- Consumes: `window.api.input/resize/onData`, `SessionView`.
- Produces:
  ```ts
  // terminal-registry.ts
  function registerTerminal(id: string, term: Terminal): void
  function unregisterTerminal(id: string): void
  function getTerminal(id: string): Terminal | undefined
  ```
  `<TerminalPane sessionId={string} visible={boolean} />` — mounts one xterm instance for its session, keeps it alive while hidden.

- [ ] **Step 1: Implement terminal registry**

`src/renderer/src/terminal-registry.ts`:

```ts
import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): void {
  terminals.set(id, term)
}

export function unregisterTerminal(id: string): void {
  terminals.get(id)?.dispose()
  terminals.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return terminals.get(id)
}
```

- [ ] **Step 2: Implement TerminalPane**

`src/renderer/src/components/TerminalPane.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { registerTerminal, unregisterTerminal } from '../terminal-registry'

interface TerminalPaneProps {
  sessionId: string
  visible: boolean
}

export default function TerminalPane({ sessionId, visible }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: '#16161e',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#2f334d'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current!)
    fit.fit()
    term.onData((data) => window.api.input(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.resize(sessionId, cols, rows))
    registerTerminal(sessionId, term)
    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => {
      if (containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })
    observer.observe(containerRef.current!)
    return () => {
      observer.disconnect()
      unregisterTerminal(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [visible])

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}
```

- [ ] **Step 3: Mount panes and dispatch data in App**

In `src/renderer/src/App.tsx`:

Add imports:

```tsx
import TerminalPane from './components/TerminalPane'
import { getTerminal } from './terminal-registry'
```

Inside the init `useEffect`, after `window.api.onFocus(...)`, add:

```tsx
window.api.onData((id, data) => getTerminal(id)?.write(data))
```

In the `<main className="terminal-area">` block, replace the Task 7 comment line with:

```tsx
{sessions.map((s) => (
  <TerminalPane key={s.id} sessionId={s.id} visible={s.id === activeId} />
))}
```

Also render exited-session overlay: add just below the panes (inside `<main>`):

```tsx
{activeId && sessions.find((s) => s.id === activeId)?.status === 'exited' && (
  <div className="exited-overlay">
    <p>Session exited.</p>
    <button onClick={() => window.api.activate(activeId)}>Relaunch</button>
  </div>
)}
```

- [ ] **Step 4: Append styles**

Append to `src/renderer/src/app.css`:

```css
.terminal-pane { position: absolute; inset: 0; padding: 8px; }
.exited-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(22, 22, 30, 0.85);
}
.exited-overlay button {
  background: var(--accent);
  color: #16161e;
  border: none;
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
```

- [ ] **Step 5: Verify manually with a temporary session**

Run: `npm run dev`, then in devtools console: `await window.api.create('test', '/path/to/your/project')` and click the session row.
Expected: Claude Code boots inside the pane, is fully interactive (arrow keys, Shift+Tab mode switch), resizes with the window, and after Claude finishes its first response the sidebar dot turns green (Stop hook). Typing a prompt + Enter turns it orange (working).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: xterm.js terminal panes with live pty data flow"
```

---

### Task 9: New-session dialog + full session CRUD

**Files:**
- Create: `src/renderer/src/components/NewSessionDialog.tsx`
- Modify: `src/renderer/src/App.tsx` (replace `.dialog-placeholder` with real dialog)
- Modify: `src/renderer/src/app.css` (append)

**Interfaces:**
- Consumes: `window.api.create/pickDirectory`, existing sessions (for recent dirs).
- Produces:
  ```ts
  interface NewSessionDialogProps {
    recentDirs: string[]  // deduped cwds of existing sessions, most recent first
    home: string
    onCreate(name: string, cwd: string): void
    onCancel(): void
  }
  ```

- [ ] **Step 1: Implement dialog**

`src/renderer/src/components/NewSessionDialog.tsx`:

```tsx
import { useState } from 'react'

interface NewSessionDialogProps {
  recentDirs: string[]
  home: string
  onCreate(name: string, cwd: string): void
  onCancel(): void
}

export default function NewSessionDialog(props: NewSessionDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(props.recentDirs[0] ?? props.home)

  const submit = (): void => {
    if (name.trim() && cwd) props.onCreate(name.trim(), cwd)
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New Session</h2>
        <label>
          Name
          <input
            autoFocus
            placeholder="e.g. fix-auth-bug"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') props.onCancel()
            }}
          />
        </label>
        <label>
          Directory
          <div className="dir-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <button
              onClick={async () => {
                const picked = await window.api.pickDirectory()
                if (picked) setCwd(picked)
              }}
            >
              Browse…
            </button>
          </div>
        </label>
        {props.recentDirs.length > 0 && (
          <div className="recent-dirs">
            {props.recentDirs.slice(0, 5).map((d) => (
              <button key={d} className="recent-dir" onClick={() => setCwd(d)}>
                {d.startsWith(props.home) ? '~' + d.slice(props.home.length) : d}
              </button>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" disabled={!name.trim() || !cwd} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire into App**

In `src/renderer/src/App.tsx`, add import:

```tsx
import NewSessionDialog from './components/NewSessionDialog'
```

Replace the `{dialogOpen && <div className="dialog-placeholder" …/>}` line with:

```tsx
{dialogOpen && (
  <NewSessionDialog
    recentDirs={[...new Set(sessions.map((s) => s.cwd))]}
    home={home}
    onCreate={async (name, cwd) => {
      const view = await window.api.create(name, cwd)
      setDialogOpen(false)
      switchTo(view.id)
    }}
    onCancel={() => setDialogOpen(false)}
  />
)}
```

- [ ] **Step 3: Append styles**

Append to `src/renderer/src/app.css`:

```css
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.dialog {
  background: var(--bg-sidebar);
  border: 1px solid var(--bg-active);
  border-radius: 8px;
  padding: 20px;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dialog h2 { font-size: 15px; }
.dialog label { display: flex; flex-direction: column; gap: 6px; color: var(--fg-dim); font-size: 12px; }
.dialog input {
  background: var(--bg);
  border: 1px solid var(--bg-active);
  color: var(--fg);
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 13px;
  width: 100%;
}
.dialog input:focus { outline: none; border-color: var(--accent); }
.dir-row { display: flex; gap: 6px; }
.dir-row input { flex: 1; }
.dialog button {
  background: var(--bg-hover);
  color: var(--fg);
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.dialog button.primary { background: var(--accent); color: #16161e; }
.dialog button:disabled { opacity: 0.4; cursor: default; }
.recent-dirs { display: flex; flex-wrap: wrap; gap: 6px; }
.recent-dir { font-family: var(--font-mono); font-size: 11px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 4: Verify manually**

Run: `npm run dev`
Expected: Cmd+N (and the + button) opens the dialog; recents show cwds of existing sessions; Browse… opens the macOS directory picker; Create spawns a live Claude session and switches to it; double-click renames; hover × with confirm removes; drag reorders; Cmd+W closes (row goes gray, Relaunch overlay appears; Relaunch resumes the same conversation).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: new-session dialog and complete session CRUD in the UI"
```

---

### Task 10: Notification policy tests + notification behavior

**Files:**
- Test: `src/main/notify-policy.test.ts` (notify-policy.ts itself was created in Task 6)

**Interfaces:**
- Consumes: `shouldNotify(t: Transition, activeId: string | null): boolean` from Task 6.
- Produces: verified notification policy; no new exports.

- [ ] **Step 1: Write the tests**

`src/main/notify-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldNotify } from './notify-policy'

const t = (from: string, to: string, id = 's1') =>
  ({ id, name: 'sess', from, to }) as Parameters<typeof shouldNotify>[0]

describe('shouldNotify', () => {
  it('notifies when a background session finishes working', () => {
    expect(shouldNotify(t('working', 'idle'), 'other')).toBe(true)
    expect(shouldNotify(t('working', 'idle'), null)).toBe(true)
  })

  it('notifies when a background session needs input', () => {
    expect(shouldNotify(t('working', 'needs-you'), 'other')).toBe(true)
  })

  it('never notifies for the active session', () => {
    expect(shouldNotify(t('working', 'idle', 's1'), 's1')).toBe(false)
    expect(shouldNotify(t('working', 'needs-you', 's1'), 's1')).toBe(false)
  })

  it('does not notify for transitions not coming from working (spawn noise)', () => {
    expect(shouldNotify(t('exited', 'idle'), 'other')).toBe(false)
    expect(shouldNotify(t('idle', 'needs-you'), 'other')).toBe(false)
  })

  it('does not notify on exit', () => {
    expect(shouldNotify(t('working', 'exited'), 'other')).toBe(false)
  })
})
```

Note: one behavior decision is embedded here — `idle → needs-you` (a Notification hook firing while the session wasn't marked working, e.g. Claude idle-prompt reminders) does NOT notify. If that proves annoying in practice, loosening it is a one-line change in `shouldNotify`, but start strict to avoid notification spam.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: all PASS (policy was already implemented in Task 6; if any fail, fix `notify-policy.ts` to match these tests — the tests are the contract).

- [ ] **Step 3: Manual notification check**

Run: `npm run dev`. Create two sessions. In session A, give Claude a long task ("summarize this repo file by file"), switch to session B while A works.
Expected: when A finishes, a macOS notification "«A's name» — Finished responding" appears (first run: macOS asks permission — accept); dock badge shows count when a session is in needs-you; clicking the notification switches to A.

- [ ] **Step 4: Commit**

```bash
git add src/main/notify-policy.test.ts
git commit -m "test: notification policy contract"
```

---

### Task 11: Relaunch/resume flow verification + smoke checklist

**Files:**
- Create: `docs/smoke-checklist.md`

**Interfaces:**
- Consumes: the whole app.
- Produces: the manual E2E checklist used before calling any future change done.

- [ ] **Step 1: Write the checklist**

`docs/smoke-checklist.md`:

```markdown
# Claude Terminal — manual smoke checklist

Run through this before declaring a build good. Prereq: `claude` installed and logged in.

## Session basics
- [ ] `npm run dev` opens the app with sidebar + empty state
- [ ] ⌘N opens dialog; create session "smoke-a" in a real repo dir
- [ ] Claude boots in the pane; typing + Enter gets a response
- [ ] Dot: orange while working, green after response (Stop hook)
- [ ] Trigger a permission prompt (ask Claude to run a shell command); dot turns red (needs-you)
- [ ] Create "smoke-b"; ⌘1/⌘2, ⌘J/⌘K switch instantly; scrollback intact after switching
- [ ] Double-click rename works; drag reorder works; ⌘B toggles sidebar
- [ ] ⌘E jumps to the needs-you session

## Notifications
- [ ] Long task in A, switch to B → notification on A's completion; click focuses A
- [ ] Dock badge counts needs-you sessions; clears when handled

## Lifecycle
- [ ] ⌘W closes active session → gray dot + Relaunch overlay
- [ ] Relaunch resumes the same conversation (asks Claude "what did I ask before?" to confirm)
- [ ] Quit app, relaunch: sessions listed gray; clicking one resumes its conversation
- [ ] Remove (×) asks confirm and deletes; survives relaunch (stays gone)

## Error paths
- [ ] Corrupt `~/Library/Application Support/claude-terminal/sessions.json` (write garbage) → app opens with banner naming the backup file, empty sidebar
- [ ] Session with a deleted/expired claude session id: relaunch falls back to a fresh session with the "[claude-terminal] resume failed" note in the pane
```

- [ ] **Step 2: Execute the checklist**

Run every item. Fix anything that fails before committing (each fix is a normal TDD cycle if it touches tested modules).

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-checklist.md
git commit -m "docs: manual smoke checklist"
```

---

## Self-review notes (already applied)

- Spec coverage: naming/switching (Tasks 7, 9), status model + hooks (3–5), notifications + badge (6, 10), resume-on-relaunch + lazy activate (5, 6, 8), close-vs-remove (5, 9), all error paths (2, 5, 6, 7, 11), shortcuts incl. Cmd+E oldest-needs-you (6, 7).
- `Notification` shows "Finished responding" only from `working` state — matches notify-policy tests.
- Type names cross-checked: `SessionView.statusChangedAt` used by Cmd+E selector (Task 7) is defined in Task 1 and populated in Task 5.
```
