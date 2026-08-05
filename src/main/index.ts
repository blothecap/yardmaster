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
