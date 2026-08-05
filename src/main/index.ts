import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import * as pty from 'node-pty' // CJS module — namespace import, not default
import type { ShortcutAction } from '../shared/types'
import { Store } from './store'
import { writeSessionSettings } from './settings-gen'
import { HookServer } from './hook-server'
import { SessionManager, type SpawnOpts } from './session-manager'
import { ShellManager } from './shell-manager'
import { resolveClaudePath } from './claude-path'
import { shouldNotify } from './notify-policy'

let win: BrowserWindow | null = null
let manager: SessionManager | null = null
let shellManager: ShellManager | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Claude Terminal',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  win.on('closed', () => { win = null })
}

function safeSend(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function sendShortcut(action: ShortcutAction): void {
  safeSend('app:shortcut', action)
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
        { label: 'Toggle Shell', accelerator: 'Cmd+T', click: () => sendShortcut({ type: 'toggle-shell' }) },
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
        { label: 'Next Session (down)', accelerator: 'Cmd+Down', click: () => sendShortcut({ type: 'next' }) },
        { label: 'Previous Session (up)', accelerator: 'Cmd+Up', click: () => sendShortcut({ type: 'prev' }) },
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
  try {
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
      if (!claudePath) throw new Error('claude binary not found — cannot spawn session')
      const args = ['--settings', opts.settingsPath, ...(opts.resumeId ? ['--resume', opts.resumeId] : [])]
      const proc = pty.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
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

    shellManager = new ShellManager({
      spawner: (cwd) =>
        adapt(
          pty.spawn(process.env.SHELL ?? '/bin/zsh', ['-l'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd,
            env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
          })
        )
    })
    shellManager.on('data', (id, chunk) => safeSend('shell:data', { id, data: chunk }))
    shellManager.on('exit', (id) => safeSend('shell:exit', id))

    hookServer.onEvent((id, event, payload) => manager!.handleHookEvent(id, event, payload))

    manager.on('changed', (views) => {
      safeSend('sessions:changed', views)
      app.setBadgeCount(views.filter((v: { status: string }) => v.status === 'needs-you').length)
    })
    manager.on('data', (id, chunk) => safeSend('sessions:data', { id, data: chunk }))
    manager.on('status-transition', (t) => {
      if (shouldNotify(t, manager!.getActiveId())) {
        const n = new Notification({
          title: t.name,
          body: t.to === 'needs-you' ? 'Needs your input' : 'Finished responding'
        })
        n.on('click', () => {
          if (win && !win.isDestroyed()) {
            win.show()
            safeSend('sessions:focus', t.id)
          }
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
    ipcMain.handle('sessions:create', (_e, { name, cwd }) => {
      let ok = false
      try { ok = fs.statSync(cwd).isDirectory() } catch { ok = false }
      if (!ok) throw new Error(`not a directory: ${cwd}`)
      return manager!.create(name, cwd)
    })
    ipcMain.handle('sessions:activate', (_e, id) => manager!.activate(id))
    ipcMain.handle('sessions:setActive', (_e, id) => manager!.setActive(id))
    ipcMain.handle('sessions:rename', (_e, { id, name }) => manager!.rename(id, name))
    ipcMain.handle('sessions:close', (_e, id) => {
      shellManager!.kill(id)
      manager!.close(id)
    })
    ipcMain.handle('sessions:remove', (_e, id) => {
      shellManager!.kill(id)
      manager!.remove(id)
    })
    ipcMain.handle('shell:ensure', (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session) return false
      shellManager!.ensure(id, session.cwd)
      return true
    })
    ipcMain.handle('shell:isRunning', (_e, id: string) => shellManager!.isRunning(id))
    ipcMain.on('shell:input', (_e, { id, data }) => shellManager!.write(id, data))
    ipcMain.on('shell:resize', (_e, { id, cols, rows }) => shellManager!.resize(id, cols, rows))
    ipcMain.handle('sessions:reorder', (_e, ids) => manager!.reorder(ids))
    ipcMain.on('sessions:contextMenu', (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session || !win || win.isDestroyed()) return
      const live = session.status !== 'exited'
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: 'Rename', click: () => safeSend('sessions:startRename', id) },
        live
          ? { label: 'Close', click: () => manager!.close(id) }
          : { label: 'Relaunch', click: () => safeSend('sessions:focus', id) },
        { type: 'separator' },
        {
          label: 'Remove…',
          click: async () => {
            if (!win || win.isDestroyed()) return
            const r = await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Remove', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: `Remove session "${session.name}"?`,
              detail: 'This deletes it from the sidebar. The Claude conversation itself is not deleted.'
            })
            if (r.response === 0) manager!.remove(id)
          }
        }
      ]
      Menu.buildFromTemplate(template).popup({ window: win })
    })
    ipcMain.on('sessions:input', (_e, { id, data }) => manager!.write(id, data))
    ipcMain.on('sessions:resize', (_e, { id, cols, rows }) => manager!.resize(id, cols, rows))
    ipcMain.handle('app:pickDirectory', async () => {
      const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })

    createWindow()
  } catch (err) {
    dialog.showErrorBox('Claude Terminal failed to start', err instanceof Error ? err.stack ?? err.message : String(err))
    app.quit()
  }
})

app.on('before-quit', () => {
  shellManager?.disposeAll()
  manager?.disposeAll()
})
app.on('window-all-closed', () => app.quit())
