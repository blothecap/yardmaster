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
            onContextMenu={(e) => { e.preventDefault(); window.api.contextMenu(s.id) }}
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
