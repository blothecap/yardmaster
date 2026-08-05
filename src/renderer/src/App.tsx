/// <reference path="../../preload/index.d.ts" />
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionView, ShortcutAction } from '../../shared/types'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import NewSessionDialog from './components/NewSessionDialog'
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
    return () => { offChanged(); offFocus(); offShortcut(); offData() }
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
      </main>
      {dialogOpen && (
        <NewSessionDialog
          recentDirs={[...new Set(
            [...sessions]
              .sort((a, b) => (b.lastActivityAt ?? b.statusChangedAt) - (a.lastActivityAt ?? a.statusChangedAt))
              .map((s) => s.cwd)
          )]}
          home={home}
          onCreate={async (name, cwd) => {
            const view = await window.api.create(name, cwd)
            setDialogOpen(false)
            switchTo(view.id)
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
