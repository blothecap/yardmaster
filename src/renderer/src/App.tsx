/// <reference path="../../preload/index.d.ts" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TERMINALS_ID, type SessionView, type ShortcutAction } from '../../shared/types'
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
  const [rightPane, setRightPane] = useState<'inbox' | 'changes' | null>(null)
  // Tabs per session: shellTabs holds each session's shell ids (tab order),
  // activeTab holds which view a session is showing — 'claude' or a shell id.
  const [shellTabs, setShellTabs] = useState<Record<string, string[]>>({})
  const [activeTab, setActiveTab] = useState<Record<string, string>>({})
  const shellSeq = useRef(1)
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
    if (id === TERMINALS_ID) {
      window.api.setActive(null) // no Claude session is "active" — notify for all
      if ((shellTabsRef.current[TERMINALS_ID] ?? []).length === 0) newShellRef.current(TERMINALS_ID)
      return
    }
    window.api.setActive(id)
    window.api.activate(id)
  }, [])

  const jumpFromInbox = useCallback((id: string) => {
    switchTo(id)
    setRightPane(null)
  }, [switchTo])

  const closeRightPane = useCallback(() => setRightPane(null), [])

  const shellTabsRef = useRef(shellTabs)
  shellTabsRef.current = shellTabs
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const selectTab = useCallback((sessionId: string, tab: string) => {
    setActiveTab((prev) => ({ ...prev, [sessionId]: tab }))
  }, [])

  const newShell = useCallback((sessionId: string) => {
    const shellId = `${sessionId}::${shellSeq.current++}`
    window.api.shellEnsure(shellId, sessionId)
    setShellTabs((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), shellId] }))
    selectTab(sessionId, shellId)
  }, [selectTab])

  const newShellRef = useRef(newShell)
  newShellRef.current = newShell

  const cycleTab = useCallback((sessionId: string, dir: 1 | -1) => {
    const tabs = ['claude', ...(shellTabsRef.current[sessionId] ?? [])]
    const cur = activeTabRef.current[sessionId] ?? 'claude'
    const idx = Math.max(0, tabs.indexOf(cur))
    selectTab(sessionId, tabs[(idx + dir + tabs.length) % tabs.length])
  }, [selectTab])

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
      if (current && current !== TERMINALS_ID && !views.some((s) => s.id === current)) {
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
      // shell ended (user typed exit, closed the tab, or its session closed) —
      // drop its tab; if it was showing, fall back to the previous shell or Claude
      const sessionId = id.split('::')[0]
      setShellTabs((prev) => {
        const tabs = (prev[sessionId] ?? []).filter((t) => t !== id)
        const n = { ...prev }
        if (tabs.length) n[sessionId] = tabs
        else delete n[sessionId]
        return n
      })
      setActiveTab((prev) => {
        if (prev[sessionId] !== id) return prev
        const remaining = (shellTabsRef.current[sessionId] ?? []).filter((t) => t !== id)
        return { ...prev, [sessionId]: remaining[remaining.length - 1] ?? 'claude' }
      })
    })
    return () => { offChanged(); offFocus(); offShortcut(); offData(); offStartRename(); offShellData(); offShellExit() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleShortcut = useCallback((action: ShortcutAction) => {
    const list = sessionsRef.current
    const current = activeIdRef.current
    // ⌘↑/↓ cycle through the Terminals row plus every session, in sidebar order
    const navIds = [TERMINALS_ID, ...list.map((s) => s.id)]
    const navIdx = Math.max(0, navIds.indexOf(current ?? ''))
    switch (action.type) {
      case 'jump':
        if (list[action.index]) switchTo(list[action.index].id)
        break
      case 'next':
        switchTo(navIds[(navIdx + 1) % navIds.length])
        break
      case 'prev':
        switchTo(navIds[(navIdx - 1 + navIds.length) % navIds.length])
        break
      case 'new':
        setDialogOpen(true)
        break
      case 'rename':
        if (current) setRenamingId(current)
        break
      case 'close':
        if (current === TERMINALS_ID) {
          // ⌘W in the Terminals view closes the tab you're looking at
          const tabs = shellTabsRef.current[TERMINALS_ID] ?? []
          const cur = activeTabRef.current[TERMINALS_ID]
          const target = tabs.includes(cur) ? cur : tabs[tabs.length - 1]
          if (target) window.api.shellKill(target)
        } else if (current) {
          window.api.close(current)
        }
        break
      case 'toggle-inbox':
        setRightPane((p) => (p === 'inbox' ? null : 'inbox'))
        break
      case 'toggle-sidebar':
        setCollapsed((c) => !c)
        break
      case 'new-shell':
        if (current) newShell(current)
        break
      case 'tab-next':
        if (current) cycleTab(current, 1)
        break
      case 'tab-prev':
        if (current) cycleTab(current, -1)
        break
    }
  }, [switchTo, newShell, cycleTab])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null
  const needsYouCount = sessions.filter((s) => s.status === 'needs-you').length
  const isTerminals = activeId === TERMINALS_ID
  const termTabs = shellTabs[TERMINALS_ID] ?? []
  const termActive = termTabs.includes(activeTab[TERMINALS_ID])
    ? activeTab[TERMINALS_ID]
    : termTabs[termTabs.length - 1] ?? null

  if (!claudeFound) {
    return (
      <div className="app fullscreen-message">
        <h1>claude not found</h1>
        <p>
          Yardmaster could not find the <code>claude</code> binary on your PATH.
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
          terminalsActive={isTerminals}
          terminalCount={termTabs.length}
          onSelectTerminals={() => switchTo(TERMINALS_ID)}
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
            Yardmaster last quit
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
        {(activeSession || isTerminals) && (
          <div className="view-tabs">
            {activeSession && !isTerminals && (
              <button
                className={`view-tab${(activeTab[activeSession.id] ?? 'claude') === 'claude' ? ' active' : ''}`}
                onClick={() => selectTab(activeSession.id, 'claude')}
              >
                Claude
              </button>
            )}
            {(isTerminals ? termTabs : shellTabs[activeSession!.id] ?? []).map((shellId, i, arr) => {
              const label = arr.length === 1 ? 'Terminal' : `Terminal ${i + 1}`
              const isActive = isTerminals
                ? termActive === shellId
                : activeTab[activeSession!.id] === shellId
              return (
                <button
                  key={shellId}
                  className={`view-tab${isActive ? ' active' : ''}`}
                  title={isTerminals ? 'Terminal in your home directory (⌘⌥←/→ to switch tabs)' : "Terminal in this session's directory (⌘⌥←/→ to switch tabs)"}
                  onClick={() => selectTab(isTerminals ? TERMINALS_ID : activeSession!.id, shellId)}
                >
                  {label}
                  <span
                    className="view-tab-close"
                    title="Close terminal"
                    onClick={(e) => { e.stopPropagation(); window.api.shellKill(shellId) }}
                  >
                    ×
                  </span>
                </button>
              )
            })}
            <button
              className="view-tab view-tab-add"
              title="New terminal (⌘T)"
              onClick={() => newShell(isTerminals ? TERMINALS_ID : activeSession!.id)}
            >
              +
            </button>
          </div>
        )}
        <div className="claude-pane-region">
          {sessions.map((s) => (
            <TerminalPane
              key={s.id}
              sessionId={s.id}
              visible={s.id === activeId && (activeTab[s.id] ?? 'claude') === 'claude'}
            />
          ))}
          {sessions.flatMap((s) =>
            (shellTabs[s.id] ?? []).map((shellId) => (
              <ShellPane
                key={shellId}
                shellId={shellId}
                visible={s.id === activeId && activeTab[s.id] === shellId}
              />
            ))
          )}
          {termTabs.map((shellId) => (
            <ShellPane
              key={shellId}
              shellId={shellId}
              visible={isTerminals && termActive === shellId}
            />
          ))}
          {isTerminals && termTabs.length === 0 && (
            <div className="empty-state">No terminals — press ⌘T to open one.</div>
          )}
          {activeId &&
            (activeTab[activeId] ?? 'claude') === 'claude' &&
            sessions.find((s) => s.id === activeId)?.status === 'exited' && (
            <div className="exited-overlay">
              <p>Session exited.</p>
              <button onClick={() => window.api.activate(activeId)}>Relaunch</button>
            </div>
          )}
          {sessions.length === 0 && !isTerminals && (
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
          {rightPane === 'changes' && activeSession && (
            <ReviewPane
              key={activeSession.id}
              sessionId={activeSession.id}
              onClose={closeRightPane}
            />
          )}
          {rightPane === 'changes' && !activeSession && (
            <div className="right-pane-empty">No active session.</div>
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
          className={`strip-btn${activeSession && (activeTab[activeSession.id] ?? 'claude') !== 'claude' ? ' active' : ''}`}
          title="Terminal in this session's directory (⌘T for a new one)"
          disabled={!activeSession}
          onClick={() => {
            if (!activeSession) return
            const id = activeSession.id
            const tabs = shellTabs[id] ?? []
            const cur = activeTab[id] ?? 'claude'
            if (cur !== 'claude') selectTab(id, 'claude')
            else if (tabs.length) selectTab(id, tabs[tabs.length - 1])
            else newShell(id)
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m7 9 3 3-3 3" />
            <path d="M13 15h4" />
          </svg>
        </button>
        <button
          className={`strip-btn${rightPane === 'changes' ? ' active' : ''}`}
          title="Changes — diffs & session commits"
          disabled={!activeSession}
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
