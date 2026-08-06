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
  const [resumableIds, setResumableIds] = useState<string[]>([])
  const [home, setHome] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogPrefill, setDialogPrefill] = useState<{ dir: string; worktree: boolean } | null>(null)
  const [shellCreated, setShellCreated] = useState<Set<string>>(new Set())
  const [rightPane, setRightPane] = useState<'inbox' | 'changes' | 'shell' | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('ct.sidebarWidth')) || 240)
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('ct.rightWidth')) || 380)

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
  const rightPaneRef = useRef(rightPane)
  rightPaneRef.current = rightPane
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const rightWidthRef = useRef(rightWidth)
  rightWidthRef.current = rightWidth

  const startVDrag = useCallback((which: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = which === 'left' ? sidebarWidthRef.current : rightWidthRef.current
    const onMove = (ev: MouseEvent): void => {
      const d = ev.clientX - startX
      if (which === 'left') setSidebarWidth(Math.min(420, Math.max(180, startW + d)))
      else setRightWidth(Math.min(720, Math.max(280, startW - d)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('ct.sidebarWidth', String(sidebarWidthRef.current))
      localStorage.setItem('ct.rightWidth', String(rightWidthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const switchTo = useCallback((id: string) => {
    setActiveId(id)
    window.api.setActive(id)
    window.api.activate(id)
  }, [])

  const jumpFromInbox = useCallback((id: string) => {
    switchTo(id)
    setRightPane(null)
  }, [switchTo])

  const closeRightPane = useCallback(() => setRightPane(null), [])

  const openShellFor = useCallback((id: string) => {
    window.api.shellEnsure(id)
    setShellCreated((prev) => new Set(prev).add(id))
  }, [])

  const toggleShellPane = useCallback(() => {
    if (rightPaneRef.current === 'shell') {
      setRightPane(null)
    } else {
      const current = activeIdRef.current
      if (current) openShellFor(current)
      setRightPane('shell')
    }
  }, [openShellFor])

  // Changes pane content is per-session — close it on session switch (inbox is global, stays open)
  useEffect(() => { setRightPane((p) => (p === 'changes' ? null : p)) }, [activeId])

  useEffect(() => {
    window.api.init().then((init) => {
      setClaudeFound(init.claudeFound)
      setCorruptBackup(init.corruptBackupPath)
      setHome(init.home)
      setSessions(init.sessions)
      setResumableIds(init.resumableIds)
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
        setRightPane((p) => (p === 'inbox' ? null : 'inbox'))
        break
      case 'toggle-sidebar':
        setCollapsed((c) => !c)
        break
      case 'toggle-shell':
        toggleShellPane()
        break
    }
  }, [switchTo, toggleShellPane])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null
  const needsYouCount = sessions.filter((s) => s.status === 'needs-you').length

  if (!claudeFound) {
    return (
      <div className="app fullscreen-message">
        <h1>claude not found</h1>
        <p>
          Switchyard could not find the <code>claude</code> binary on your PATH.
          Install Claude Code (<code>npm install -g @anthropic-ai/claude-code</code>) or make
          sure your login shell exposes it, then relaunch this app.
        </p>
      </div>
    )
  }

  return (
    <div
      className="app layout"
      style={{ '--sidebar-w': `${sidebarWidth}px`, '--right-w': `${rightWidth}px` } as React.CSSProperties}
    >
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
          onNew={() => { setDialogPrefill(null); setDialogOpen(true) }}
          onNewInProject={(dir, worktree) => { setDialogPrefill({ dir, worktree }); setDialogOpen(true) }}
          onOpenInbox={() => setRightPane('inbox')}
          activeSession={activeSession}
        />
      )}
      {!collapsed && <div className="v-divider" onMouseDown={(e) => startVDrag('left', e)} />}
      <main className="terminal-area">
        {corruptBackup && (
          <div className="banner">
            sessions.json was corrupt — a backup was saved to {corruptBackup}
          </div>
        )}
        {resumableIds.length > 0 && (
          <div className="banner banner-neutral">
            {resumableIds.length} session{resumableIds.length === 1 ? '' : 's'} were running when
            Switchyard last quit
            <button
              className="banner-action"
              onClick={() => {
                resumableIds.forEach((id) => window.api.activate(id))
                setResumableIds([])
              }}
            >
              Resume all
            </button>
            <button className="banner-action" onClick={() => setResumableIds([])}>
              Dismiss
            </button>
          </div>
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
        </div>
      </main>
      {rightPane && <div className="v-divider" onMouseDown={(e) => startVDrag('right', e)} />}
      {rightPane && (
        <aside className="right-pane">
          {rightPane === 'inbox' && (
            <Inbox sessions={displaySessions} onJump={jumpFromInbox} onClose={closeRightPane} />
          )}
          {rightPane === 'changes' && activeSession?.worktree && (
            <ReviewPane
              key={activeSession.id}
              sessionId={activeSession.id}
              branch={activeSession.worktree.branch}
              baseBranch={activeSession.worktree.baseBranch}
              onClose={closeRightPane}
            />
          )}
          {rightPane === 'changes' && !activeSession?.worktree && (
            <div className="right-pane-empty">
              The active session isn't a worktree session. Changes shows a worktree's diff
              against its base branch.
            </div>
          )}
          {rightPane === 'shell' && (
            <div className="shell-view">
              <div className="shell-view-header">
                <span className="shell-view-title">
                  Shell{activeSession ? ` — ${activeSession.name}` : ''}
                </span>
                <button className="shell-view-close" onClick={closeRightPane}>×</button>
              </div>
              <div className="shell-view-body">
                {sessions.filter((s) => shellCreated.has(s.id)).map((s) => (
                  <ShellPane key={s.id} sessionId={s.id} visible={s.id === activeId} />
                ))}
                {activeSession && !shellCreated.has(activeSession.id) && (
                  <div className="shell-view-empty">
                    <button
                      className="shell-open-btn"
                      onClick={() => openShellFor(activeSession.id)}
                    >
                      Open shell in {activeSession.name}
                    </button>
                  </div>
                )}
                {!activeSession && <div className="shell-view-empty">No active session.</div>}
              </div>
            </div>
          )}
        </aside>
      )}
      <nav className="activity-strip">
        <button
          className={`strip-btn${rightPane === 'inbox' ? ' active' : ''}`}
          title="Waiting on you (⌘E)"
          onClick={() => setRightPane((p) => (p === 'inbox' ? null : 'inbox'))}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {needsYouCount > 0 && <span className="strip-badge">{needsYouCount}</span>}
        </button>
        <button
          className={`strip-btn${rightPane === 'shell' ? ' active' : ''}`}
          title="Shell in this session's directory (⌘T)"
          disabled={!activeSession}
          onClick={toggleShellPane}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m7 9 3 3-3 3" />
            <path d="M13 15h4" />
          </svg>
        </button>
        <button
          className={`strip-btn${rightPane === 'changes' ? ' active' : ''}`}
          title={activeSession?.worktree ? 'Changes — worktree diff & merge' : 'Changes (worktree sessions only)'}
          disabled={!activeSession?.worktree}
          onClick={() => setRightPane((p) => (p === 'changes' ? null : 'changes'))}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="18" r="3" />
            <path d="M6 9v3a3 3 0 0 0 3 3h3" />
            <path d="M18 15v-3a3 3 0 0 0-3-3h-3" />
          </svg>
        </button>
      </nav>
      {dialogOpen && (
        <NewSessionDialog
          initialDir={dialogPrefill?.dir}
          initialWorktree={dialogPrefill?.worktree}
          recentDirs={[...new Set(
            [...sessions]
              .sort((a, b) => (b.lastActivityAt ?? b.statusChangedAt) - (a.lastActivityAt ?? a.statusChangedAt))
              .map((s) => s.worktree?.repoRoot ?? s.cwd) // worktree internals are never "projects"
          )]}
          home={home}
          onCreate={async (name, cwd, worktree, extraArgs) => {
            try {
              const view = await window.api.create(name, cwd, worktree, extraArgs)
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
