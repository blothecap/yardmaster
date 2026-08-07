import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import * as pty from 'node-pty' // CJS module — namespace import, not default
import { TERMINALS_ID, type ShortcutAction } from '../shared/types'
import { Store } from './store'
import { writeSessionSettings } from './settings-gen'
import { HookServer } from './hook-server'
import { SessionManager, type SpawnOpts } from './session-manager'
import { ShellManager } from './shell-manager'
import { resolveClaudePath, resolveLoginEnv } from './claude-path'
import { shouldNotify } from './notify-policy'
import { createWorktree, detectRepoRoot, removeWorktree } from './worktree'
import { ptyEnv } from './clean-env'
import {
  changedFiles,
  commitsSince,
  currentBranch,
  fileDiff,
  headCommit,
  mergeBranch,
  pushAndCreatePr,
  uncommittedDiff,
  uncommittedFiles
} from './git-review'
import { sessionCost } from './transcript-cost'
import { projectInfo } from './project-info'

let win: BrowserWindow | null = null
let manager: SessionManager | null = null
let shellManager: ShellManager | null = null
let quitConfirmed = false
let askingQuit = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Yardmaster',
    backgroundColor: '#0f0f0f',
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

  // Cmd+Up/Down are macOS text-editing keys (document start/end), so the focused
  // terminal textarea consumes them before menu accelerators fire. Intercept them
  // ahead of the page instead — this is their only binding (no menu item).
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.meta && !input.alt && !input.shift && !input.control &&
      (input.key === 'ArrowUp' || input.key === 'ArrowDown')
    ) {
      sendShortcut({ type: input.key === 'ArrowUp' ? 'prev' : 'next' })
      event.preventDefault()
    }
    if (
      input.type === 'keyDown' &&
      input.meta && input.alt && !input.shift && !input.control &&
      (input.key === 'ArrowLeft' || input.key === 'ArrowRight')
    ) {
      sendShortcut({ type: input.key === 'ArrowLeft' ? 'tab-prev' : 'tab-next' })
      event.preventDefault()
    }
  })
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
        { label: 'Close Terminal Tab', accelerator: 'Cmd+W', click: () => sendShortcut({ type: 'close' }) },
        { label: 'New Terminal Tab', accelerator: 'Cmd+T', click: () => sendShortcut({ type: 'new-shell' }) },
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
        { label: 'Waiting on You…', accelerator: 'Cmd+E', click: () => sendShortcut({ type: 'toggle-inbox' }) },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => sendShortcut({ type: 'toggle-sidebar' }) }
      ]
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}

app.setName('yardmaster')

// Two instances would fight over sessions.json and spawn duplicate ptys.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

/**
 * The app has been renamed twice (claude-terminal -> switchyard -> yardmaster);
 * carry existing sessions and per-session settings over to the new identity's
 * userData dir once, preferring the most recent prior identity.
 */
function migrateLegacyUserData(): void {
  const userData = app.getPath('userData')
  try {
    if (fs.existsSync(path.join(userData, 'sessions.json'))) return
    for (const prior of ['switchyard', 'claude-terminal']) {
      const legacy = path.join(app.getPath('appData'), prior)
      if (fs.existsSync(path.join(legacy, 'sessions.json'))) {
        fs.mkdirSync(userData, { recursive: true })
        fs.cpSync(legacy, userData, { recursive: true })
        return
      }
    }
  } catch {
    // migration is best-effort; a fresh start is the fallback
  }
}

app.whenReady().then(async () => {
  try {
    buildMenu()
    migrateLegacyUserData()
    try {
      app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'))
    } catch { /* dev nicety only; packaged builds get the bundled .icns */ }

    const claudePath = await resolveClaudePath()
    // Login-shell env so ptys see the user's real PATH (npm-installed claude
    // needs `node` resolvable; Finder launches only get launchd's bare PATH).
    const loginEnv = (await resolveLoginEnv()) ?? {}
    const sessionEnv = (): Record<string, string> => ptyEnv({ ...process.env, ...loginEnv })
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
      const args = [
        '--settings', opts.settingsPath,
        ...(opts.resumeId ? ['--resume', opts.resumeId] : []),
        ...opts.extraArgs
      ]
      const proc = pty.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: sessionEnv()
      })
      return adapt(proc)
    }

    manager = new SessionManager({
      store,
      spawner,
      writeSettings: (appSessionId) => writeSessionSettings(settingsDir, port, appSessionId),
      deleteSettings: (id) => fs.rmSync(path.join(settingsDir, `session-${id}.settings.json`), { force: true })
    })

    shellManager = new ShellManager({
      spawner: (cwd) =>
        adapt(
          pty.spawn(process.env.SHELL ?? '/bin/zsh', ['-l'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd,
            env: sessionEnv()
          })
        )
    })
    shellManager.on('data', (id, chunk) => safeSend('shell:data', { id, data: chunk }))
    shellManager.on('exit', (id) => safeSend('shell:exit', id))

    hookServer.onEvent((id, event, payload) => {
      manager!.handleHookEvent(id, event, payload)
      if (event === 'Stop' && typeof payload.transcript_path === 'string') {
        manager!.setTranscriptPath(id, payload.transcript_path)
        sessionCost(payload.transcript_path)
          .then((c) => manager!.setCost(id, c))
          .catch(() => {})
      }
    })

    manager.on('changed', (views) => {
      safeSend('sessions:changed', views)
      app.setBadgeCount(views.filter((v: { status: string }) => v.status === 'needs-you').length)
    })

    // Plain sessions don't know their branch (worktree sessions carry theirs); detect it
    // from cwd now and every 30s so checkouts made in the session show up in the sidebar.
    const refreshBranches = (): void => {
      for (const v of manager!.list()) {
        if (v.worktree) continue
        currentBranch(v.cwd)
          .then((b) => manager!.setBranch(v.id, b))
          .catch(() => {})
      }
    }
    refreshBranches()
    const branchTimer = setInterval(refreshBranches, 30_000)
    app.on('before-quit', () => clearInterval(branchTimer))

    // Usage meters live in memory; recompute them from the last known transcript
    // so relaunching the app doesn't blank every token count until the next Stop.
    for (const v of manager.list()) {
      if (v.transcriptPath) {
        sessionCost(v.transcriptPath)
          .then((c) => manager!.setCost(v.id, c))
          .catch(() => {})
      }
    }
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
      sessions: manager!.list(),
      resumableIds: manager!.getResumableIds()
    }))
    ipcMain.handle('sessions:create', async (_e, { name, cwd, worktree, extraArgs }) => {
      const cleanArgs = typeof extraArgs === 'string' && extraArgs.trim() ? extraArgs.trim() : null
      let ok = false
      try { ok = fs.statSync(cwd).isDirectory() } catch { ok = false }
      if (!ok) throw new Error(`not a directory: ${cwd}`)
      if (!worktree) {
        // Baseline for the plain-session Changes pane's "commits this session" list.
        const plainRepoRoot = await detectRepoRoot(cwd)
        const startCommit = plainRepoRoot ? await headCommit(cwd) : null
        return manager!.create(name, cwd, null, cleanArgs, startCommit)
      }
      const repoRoot = await detectRepoRoot(cwd)
      if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
      const wt = await createWorktree(repoRoot, name)
      try {
        return manager!.create(name, wt.path, { repoRoot, branch: wt.branch, baseBranch: wt.baseBranch }, cleanArgs)
      } catch (err) {
        await removeWorktree(repoRoot, wt.path, wt.branch, true).catch(() => {})
        throw err
      }
    })
    ipcMain.handle('app:checkGitRepo', (_e, dir: string) => detectRepoRoot(dir))
    ipcMain.handle('project:info', (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session) return { repoRoot: null, branch: null, dirtyFiles: 0, ahead: null }
      return projectInfo(session.cwd, session.worktree?.baseBranch)
    })
    ipcMain.handle('sessions:activate', (_e, id) => manager!.activate(id))
    ipcMain.handle('sessions:buffer', (_e, id: string) => manager!.getBuffer(id))
    ipcMain.handle('sessions:setActive', (_e, id) => manager!.setActive(id))
    ipcMain.handle('sessions:rename', (_e, { id, name }) => manager!.rename(id, name))
    ipcMain.handle('sessions:close', (_e, id) => {
      shellManager!.killForSession(id)
      manager!.close(id)
    })
    async function removeSessionFlow(id: string, plainAlreadyConfirmed: boolean): Promise<void> {
      const session = manager!.list().find((s) => s.id === id)
      if (!session || !win || win.isDestroyed()) return
      if (session.worktree) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Delete copy & branch', 'Delete copy, keep branch', 'Cancel'],
          defaultId: 2,
          cancelId: 2,
          message: `Remove session "${session.name}" and its worktree?`,
          detail: `Worktree: ${session.cwd}\nBranch: ${session.worktree.branch}\n\n"Keep branch" leaves the work recoverable in git.`
        })
        if (r.response === 2) return
        shellManager!.killForSession(id)
        manager!.remove(id)
        try {
          await removeWorktree(session.worktree.repoRoot, session.cwd, session.worktree.branch, r.response === 0)
        } catch (err) {
          dialog.showErrorBox(
            'Worktree cleanup failed',
            `The session was removed but its worktree could not be cleaned up:\n${err instanceof Error ? err.message : err}\n\nYou can clean it up manually with:\ngit worktree remove --force "${session.cwd}"`
          )
        }
        return
      }
      if (!plainAlreadyConfirmed) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Remove', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Remove session "${session.name}"?`,
          detail: 'This deletes it from the sidebar. The Claude conversation itself is not deleted.'
        })
        if (r.response !== 0) return
      }
      shellManager!.killForSession(id)
      manager!.remove(id)
    }
    ipcMain.handle('sessions:remove', (_e, id) => removeSessionFlow(id, true))
    ipcMain.handle('shell:ensure', (_e, { id, sessionId }: { id: string; sessionId: string }) => {
      if (sessionId === TERMINALS_ID) {
        shellManager!.ensure(id, app.getPath('home'))
        return true
      }
      const session = manager!.list().find((s) => s.id === sessionId)
      if (!session) return false
      shellManager!.ensure(id, session.cwd)
      return true
    })
    ipcMain.on('shell:kill', (_e, id: string) => shellManager!.kill(id))
    ipcMain.handle('shell:isRunning', (_e, id: string) => shellManager!.isRunning(id))
    ipcMain.handle('shell:buffer', (_e, id: string) => shellManager!.getBuffer(id))
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
          click: () => { void removeSessionFlow(id, false) }
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
    ipcMain.handle('review:files', async (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session) return { ok: false, error: 'session not found' }
      try {
        if (session.worktree) {
          const [files, commits] = await Promise.all([
            changedFiles(session.worktree.repoRoot, session.worktree.branch, session.worktree.baseBranch),
            commitsSince(session.cwd, session.worktree.baseBranch)
          ])
          return {
            ok: true,
            mode: 'worktree',
            branch: session.worktree.branch,
            baseBranch: session.worktree.baseBranch,
            files,
            commits
          }
        }
        // uncommittedFiles/commitsSince must run at repoRoot: porcelain status paths are
        // always repo-root-relative, but a session's cwd can be a nested subdirectory —
        // running there would mismatch pathspecs against those paths in review:diff below.
        const repoRoot = await detectRepoRoot(session.cwd)
        if (!repoRoot) return { ok: false, error: 'not a git repository' }
        const [files, branch, commits] = await Promise.all([
          uncommittedFiles(repoRoot),
          currentBranch(session.cwd),
          session.startCommit ? commitsSince(repoRoot, session.startCommit) : Promise.resolve([])
        ])
        return { ok: true, mode: 'plain', branch, files, commits }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('review:diff', async (_e, { id, file }: { id: string; file: string }) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session) return { ok: false, error: 'session not found' }
      try {
        let diff: string
        if (session.worktree) {
          diff = await fileDiff(
            session.cwd,
            session.worktree.repoRoot,
            session.worktree.branch,
            session.worktree.baseBranch,
            file
          )
        } else {
          const repoRoot = await detectRepoRoot(session.cwd)
          if (!repoRoot) return { ok: false, error: 'not a git repository' }
          diff = await uncommittedDiff(repoRoot, file)
        }
        return { ok: true, diff }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('review:merge', async (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session || !session.worktree) {
        return { ok: false, error: 'Merge is only available for worktree sessions.' }
      }
      try {
        const result = await mergeBranch(
          session.worktree.repoRoot,
          session.worktree.branch,
          session.worktree.baseBranch
        )
        if (result.ok && win && !win.isDestroyed()) {
          await dialog.showMessageBox(win, {
            type: 'info',
            message: `Merged ${session.worktree.branch} into ${session.worktree.baseBranch}.`,
            detail: "The session and worktree still exist — remove the session when you're done."
          })
        }
        return result
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('review:pr', async (_e, id: string) => {
      const session = manager!.list().find((s) => s.id === id)
      if (!session || !session.worktree) {
        return { ok: false, error: 'Push + PR is only available for worktree sessions.' }
      }
      try {
        const result = await pushAndCreatePr(
          session.cwd,
          session.worktree.branch,
          session.worktree.baseBranch
        )
        if (result.ok && win && !win.isDestroyed()) {
          if (result.url && /^https:\/\//.test(result.url)) {
            await shell.openExternal(result.url).catch(() => {})
            await dialog.showMessageBox(win, {
              type: 'info',
              message: 'Pull request created.',
              detail: result.url
            })
          } else {
            await dialog.showMessageBox(win, {
              type: 'info',
              message: 'Pull request created.',
              detail: "Couldn't parse the PR URL from gh's output — check GitHub."
            })
          }
        }
        return result
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    createWindow()
  } catch (err) {
    dialog.showErrorBox('Claude Terminal failed to start', err instanceof Error ? err.stack ?? err.message : String(err))
    app.quit()
  }
})

// Losing in-flight work on quit is surprising; warn once and let the user bail out.
// showMessageBox is async, so the guard re-enters before-quit on 'Quit Anyway' via
// quitConfirmed — and askingQuit stops a re-fire while the dialog is still open.
app.on('before-quit', (event) => {
  if (!quitConfirmed) {
    const working = manager?.list().filter((s) => s.status === 'working').length ?? 0
    if (working > 0) {
      event.preventDefault()
      if (askingQuit) return
      askingQuit = true
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: ['Quit Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${working} session(s) are still working`,
        detail: 'Quitting now interrupts their in-flight work, but the conversations themselves resume when you relaunch.'
      }
      const result = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
      result.then((r) => {
        askingQuit = false
        if (r.response === 0) {
          quitConfirmed = true
          app.quit()
        }
      })
      return
    }
  }
  // Final, confirmed pass: persist wasRunning (still-live ptys) before killing them.
  shellManager?.disposeAll()
  manager?.disposeAll()
})
app.on('window-all-closed', () => app.quit())
