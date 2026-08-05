import { Fragment, useEffect, useRef, useState } from 'react'
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
  onNewInProject(dir: string, worktree: boolean): void
}

function shortCwd(cwd: string, home: string): string {
  if (!home) return cwd
  if (cwd === home) return '~'
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length)
  return cwd
}

function keyOf(s: SessionView): string {
  return s.worktree?.repoRoot ?? s.cwd
}

/** Last path segment; falls back to parent/name when another group shares the basename. */
function projectName(key: string, allKeys: string[]): string {
  const parts = key.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? key
  const clash = allKeys.some((k) => {
    if (k === key) return false
    const p = k.split('/').filter(Boolean)
    return p[p.length - 1] === base
  })
  return clash && parts.length >= 2 ? `${parts[parts.length - 2]}/${base}` : base
}

function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function costChip(cost: SessionView['cost']): { text: string; title: string } | null {
  if (!cost) return null
  const { costUsd, inputTokens, outputTokens } = cost
  const exact =
    costUsd !== null
      ? `$${costUsd.toFixed(4)} · ${inputTokens} in / ${outputTokens} out tokens`
      : `${inputTokens} in / ${outputTokens} out tokens`
  if (costUsd !== null && costUsd >= 0.005) return { text: `$${costUsd.toFixed(2)}`, title: exact }
  if (costUsd !== null && costUsd > 0) return { text: '<1¢', title: exact }
  if (costUsd === null && inputTokens + outputTokens > 0) {
    return { text: `${Math.round((inputTokens + outputTokens) / 1000)}k tok`, title: exact }
  }
  return null
}

export default function Sidebar(props: SidebarProps): React.JSX.Element {
  const dragId = useRef<string | null>(null)
  const [editText, setEditText] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Never leave the active session hidden inside a collapsed group
  useEffect(() => {
    if (!props.activeId) return
    const active = props.sessions.find((s) => s.id === props.activeId)
    if (!active) return
    const k = keyOf(active)
    setCollapsedGroups((prev) => {
      if (!prev.has(k)) return prev
      const n = new Set(prev)
      n.delete(k)
      return n
    })
  }, [props.activeId, props.sessions])

  const toggleGroup = (k: string): void => {
    setCollapsedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }
  const [, setTick] = useState(0)

  // Relative timestamps ("3m", "1h") go stale if we only recompute on props changes;
  // tick every 30s so they keep advancing while a session sits idle.
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])

  const handleDrop = (targetId: string): void => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const ids = props.sessions.map((s) => s.id)
    const fromIdx = ids.indexOf(from)
    const targetIdx = ids.indexOf(targetId)
    if (fromIdx === -1 || targetIdx === -1) return
    ids.splice(fromIdx, 1)
    // Dropping always inserts BEFORE the target row. Removing `from` first shifts
    // everything after it left by one, so when it was before the target the target's
    // own index moves down by one too — adjust for that.
    const insertAt = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
    ids.splice(insertAt, 0, from)
    props.onReorder(ids)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Sessions</span>
        <button className="new-btn" title="New session (⌘N)" onClick={props.onNew}>+</button>
      </div>
      <ul>
        {props.sessions.map((s, i) => {
          const prev = props.sessions[i - 1]
          const groupKey = keyOf(s)
          const startsGroup = !prev || keyOf(prev) !== groupKey
          const isCollapsed = collapsedGroups.has(groupKey)
          const members = props.sessions.filter((t) => keyOf(t) === groupKey)
          const chip = costChip(s.cost)
          return (
          <Fragment key={s.id}>
          {startsGroup && (
            <li
              className="repo-group-header"
              title={groupKey}
              onClick={() => toggleGroup(groupKey)}
            >
              <span className={`chevron${isCollapsed ? '' : ' open'}`}>▸</span>
              <span className="group-name">
                {projectName(groupKey, [...new Set(props.sessions.map(keyOf))])}
              </span>
              {isCollapsed && members.some((t) => t.status === 'needs-you') && (
                <span className="dot dot-needs-you" />
              )}
              {isCollapsed && <span className="group-count">{members.length}</span>}
              <span className="group-actions">
                <button
                  className="group-action-btn"
                  title="New session in this project"
                  onClick={(e) => { e.stopPropagation(); props.onNewInProject(groupKey, false) }}
                >
                  +
                </button>
                <button
                  className="group-action-btn"
                  title="New worktree session in this project (isolated copy)"
                  onClick={(e) => { e.stopPropagation(); props.onNewInProject(groupKey, true) }}
                >
                  ⎇
                </button>
              </span>
            </li>
          )}
          {!isCollapsed && (
          <li
            draggable
            onDragStart={() => { dragId.current = s.id }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(s.id)}
            className={[
              'session-row',
              s.id === props.activeId ? 'active' : '',
              s.status === 'needs-you' ? 'needs-you' : '',
              s.worktree ? 'worktree' : '',
              'grouped'
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
                {s.status === 'needs-you' && s.needsYouMessage ? (
                  <div className="session-cwd needs-line" title={s.needsYouMessage}>
                    {s.needsYouMessage}
                  </div>
                ) : s.activity ? (
                  <div className="session-cwd" title={s.worktree ? `⎇ ${s.worktree.branch} · ${s.activity}` : s.activity}>
                    {s.worktree ? `⎇ ${s.worktree.branch} · ${s.activity}` : s.activity}
                  </div>
                ) : s.worktree ? (
                  <div className="session-cwd" title={s.cwd}>
                    {`⎇ ${s.worktree.branch}`}
                  </div>
                ) : null}
              </div>
            )}
            <span className="session-time">{relativeTime(s.lastActivityAt)}</span>
            {chip && (
              <span className="session-cost" title={chip.title}>
                {chip.text}
              </span>
            )}
            <button
              className="remove-btn"
              title="Remove session"
              onClick={(e) => {
                e.stopPropagation()
                if (s.worktree) {
                  props.onRemove(s.id) // main process shows the worktree removal dialog
                  return
                }
                if (confirm(`Remove session "${s.name}"? This deletes it from the sidebar.`)) {
                  props.onRemove(s.id)
                }
              }}
            >
              ×
            </button>
          </li>
          )}
          </Fragment>
          )
        })}
      </ul>
    </aside>
  )
}
