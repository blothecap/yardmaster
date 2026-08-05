/// <reference path="../../preload/index.d.ts" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionView, ShortcutAction } from '../../shared/types'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import ShellPane from './components/ShellPane'
import NewSessionDialog from './components/NewSessionDialog'
import ReviewPane from './components/ReviewPane'
import Inbox from './components/Inbox'
import { getTerminal } from './terminal-registry'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [claudeFound, setClaudeFound] = useState(true)
  const [corruptBackup, setCorruptBackup] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [shellOpen, setShellOpen] = useState<Set<string>>(new Set())
  const [shellCreated, setShellCreated] = useState<Set<string>>(new Set())
  const [shellHeight, setShellHeight] = useState(35) // % of the terminal area
  const [reviewOpen, setReviewOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)

  // Sidebar groups sessions sharing a directory (worktrees by repo root, plain by cwd);
  // shortcuts follow the same visible order
  const displaySessions = useMemo(() => {
    const keyOf = (s: SessionView): string => s.worktree?.repoRoot ?? s.cwd
    const seen = new Set<string>()
    const out: SessionView[] = []
    for (const s of sessions) {
      if (seen.has(s.id)) continue
      for (const t of sessions) {
        if (keyOf(t) === keyOf(s) && !seen.has(t.id)) {
          out.push(t)
          seen.add(t.id)
        }
      }
    }
    return out
  }, [sessions])

  // Refs mirror state that shortcut/event handlers need without re-subscribing
  const sessionsRef = useRef(displaySessions)
  sessionsRef.current = displaySessions
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const shellOpenRef = useRef(shellOpen)
  shellOpenRef.current = shellOpen
  const mainRef = useRef<HTMLElement>(null)

  const switchTo = useCallback((id: string) => {
    setActiveId(id)
    window.api.setActive(id)
    window.api.activate(id)
  }, [])

  const jumpFromInbox = useCallback((id: string) => {
    switchTo(id)
    setInboxOpen(false)
  }, [switchTo])

  const closeInbox = useCallback(() => setInboxOpen(false), [])

  const toggleShell = useCallback((id: string) => {
    if (shellOpenRef.current.has(id)) {
      setShellOpen((prev) => { const n = new Set(prev); n.delete(id); return n })
    } else {
      window.api.shellEnsure(id)
      setShellCreated((prev) => new Set(prev).add(id))
      setShellOpen((prev) => new Set(prev).add(id))
    }
  }, [])

  const startDividerDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const main = mainRef.current
    if (!main) return
    const onMove = (ev: MouseEvent): void => {
      const rect = main.getBoundingClientRect()
      const pct = ((rect.bottom - ev.clientY) / rect.height) * 100
      setShellHeight(Math.min(80, Math.max(15, pct)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Review pane holds no state across sessions — close it whenever the active session changes
  useEffect(() => { setReviewOpen(false) }, [activeId])

  useEffect(() => {
    window.api.init().then((init) => {
      setClaudeFound(init.claudeFound)
      setCorruptBackup(init.corruptBackupPath)
      setHome(init.home)
      setSessions(init.sessions)
      if (init.sessions.length > 0) {
        setActiveId(init.sessions[0].id)
        window.api.setActive(init.sessions[0].id)
      }
    })
    const offChanged = window.api.onChanged((views) => {
      setSessions(views)
      const current = activeIdRef.current
      if (current && !views.some((s) => s.id === current)) {
        const next = views[0]?.id ?? null
        setActiveId(next)
        window.api.setActive(next)
      }
    })
    const offFocus = window.api.onFocus((id) => switchTo(id))
    const offShortcut = window.api.onShortcut((action) => handleShortcut(action))
    const offData = window.api.onData((id, data) => getTerminal(id)?.write(data))
    const offStartRename = window.api.onStartRename((id) => setRenamingId(id))
    const offShellData = window.api.onShellData((id, data) => getTerminal(`shell:${id}`)?.write(data))
    const offShellExit = window.api.onShellExit((id) => {
      // shell ended (user typed exit, or its session closed) — the pane goes away
      setShellOpen((prev) => { const n = new Set(prev); n.delete(id); return n })
      setShellCreated((prev) => { const n = new Set(prev); n.delete(id); return n })
    })
    return () => { offChanged(); offFocus(); offShortcut(); offData(); offStartRename(); offShellData(); offShellExit() }
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
      case 'toggle-inbox':
        setInboxOpen((o) => !o)
        break
      case 'toggle-sidebar':
        setCollapsed((c) => !c)
        break
      case 'toggle-shell':
        if (current) toggleShell(current)
        break
    }
  }, [switchTo, toggleShell])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

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
          sessions={displaySessions}
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
      <main className="terminal-area" ref={mainRef}>
        {corruptBackup && (
          <div className="banner">
            sessions.json was corrupt — a backup was saved to {corruptBackup}
          </div>
        )}
        {inboxOpen && (
          <Inbox
            sessions={displaySessions}
            onJump={jumpFromInbox}
            onClose={closeInbox}
          />
        )}
        <div className="claude-pane-region">
          {sessions.map((s) => (
            <TerminalPane key={s.id} sessionId={s.id} visible={s.id === activeId} />
          ))}
          {activeId && sessions.find((s) => s.id === activeId)?.status === 'exited' && (
            <div className="exited-overlay">
              <p>Session exited.</p>
              <button onClick={() => window.api.activate(activeId)}>Relaunch</button>
            </div>
          )}
          {sessions.length === 0 && (
            <div className="empty-state">No sessions yet — press ⌘N to create one.</div>
          )}
          {activeSession?.worktree && !reviewOpen && (
            <button className="changes-btn" onClick={() => setReviewOpen(true)}>
              Changes
            </button>
          )}
          {activeSession?.worktree && reviewOpen && (
            <ReviewPane
              key={activeSession.id}
              sessionId={activeSession.id}
              branch={activeSession.worktree.branch}
              baseBranch={activeSession.worktree.baseBranch}
              onClose={() => setReviewOpen(false)}
            />
          )}
        </div>
        <div
          className="shell-divider"
          style={{ display: activeId && shellOpen.has(activeId) ? 'block' : 'none' }}
          onMouseDown={startDividerDrag}
        />
        <div
          className="shell-split"
          style={{
            display: activeId && shellOpen.has(activeId) ? 'block' : 'none',
            height: `${shellHeight}%`
          }}
        >
          {sessions.filter((s) => shellCreated.has(s.id)).map((s) => (
            <ShellPane
              key={s.id}
              sessionId={s.id}
              visible={s.id === activeId && shellOpen.has(s.id)}
            />
          ))}
        </div>
      </main>
      {dialogOpen && (
        <NewSessionDialog
          recentDirs={[...new Set(
            [...sessions]
              .sort((a, b) => (b.lastActivityAt ?? b.statusChangedAt) - (a.lastActivityAt ?? a.statusChangedAt))
              .map((s) => s.cwd)
          )]}
          home={home}
          onCreate={async (name, cwd, worktree) => {
            try {
              const view = await window.api.create(name, cwd, worktree)
              setDialogOpen(false)
              switchTo(view.id)
            } catch (err) {
              alert(`Could not create session: ${err instanceof Error ? err.message : err}`)
            }
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
