import { Fragment, useEffect, useRef, useState } from 'react'
import type { SessionView } from '../../../shared/types'
import ProjectPanel from './ProjectPanel'
import { keyOf, projectName, relativeTime, shortCwd } from '../session-utils'

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
  onOpenInbox(): void
  activeSession: SessionView | null
}

function totalUsage(sessions: SessionView[]): string | null {
  let usd = 0
  let hasUsd = false
  let tokens = 0
  for (const s of sessions) {
    if (!s.cost) continue
    if (s.cost.costUsd !== null) { usd += s.cost.costUsd; hasUsd = true }
    tokens += s.cost.inputTokens + s.cost.outputTokens
  }
  if (hasUsd) return `$${usd.toFixed(2)}`
  if (tokens > 0) return `${Math.round(tokens / 1000)}k tok`
  return null
}

function workingDuration(statusChangedAt: number): string {
  const mins = Math.floor((Date.now() - statusChangedAt) / 60000)
  if (mins < 1) return '⚡<1m'
  if (mins < 60) return `⚡${mins}m`
  return `⚡${Math.floor(mins / 60)}h`
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
        <span className="brand">
          <svg width="14" height="14" viewBox="0 0 512 512" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="44" strokeLinecap="round" fill="none">
              <path d="M256 460 V310" />
              <path d="M256 310 V150" />
              <path d="M256 310 C256 245 148 242 148 160" />
              <path d="M256 310 C256 245 364 242 364 160" />
            </g>
            <circle cx="256" cy="96" r="40" fill="#d5a458" />
            <circle cx="148" cy="106" r="40" fill="#5cb176" />
            <circle cx="364" cy="106" r="40" fill="#eb5757" />
          </svg>
          Switchyard
        </span>
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
                ) : s.currentTool ? (
                  <div
                    className="session-cwd tool-line"
                    title={s.worktree ? `⎇ ${s.worktree.branch} · ▸ ${s.currentTool}` : `▸ ${s.currentTool}`}
                  >
                    {s.worktree ? `⎇ ${s.worktree.branch} · ▸ ${s.currentTool}` : `▸ ${s.currentTool}`}
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
            <span className={`session-time${s.status === 'working' ? ' working' : ''}`}>
              {s.status === 'working' ? workingDuration(s.statusChangedAt) : relativeTime(s.lastActivityAt)}
            </span>
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
      {props.activeSession && <ProjectPanel session={props.activeSession} home={props.home} />}
      <div className="sidebar-footer">
        {(() => {
          const working = props.sessions.filter((s) => s.status === 'working').length
          const waiting = props.sessions.filter((s) => s.status === 'needs-you').length
          const idle = props.sessions.filter((s) => s.status === 'idle').length
          const usage = totalUsage(props.sessions)
          return (
            <>
              <div className="fleet-counts">
                {working > 0 && (
                  <span className="fleet-count" title={`${working} working`}>
                    <span className="dot dot-working" />{working}
                  </span>
                )}
                {waiting > 0 && (
                  <button
                    className="fleet-count clickable"
                    title={`${waiting} waiting on you — open inbox (⌘E)`}
                    onClick={props.onOpenInbox}
                  >
                    <span className="dot dot-needs-you" />{waiting}
                  </button>
                )}
                {idle > 0 && (
                  <span className="fleet-count" title={`${idle} idle`}>
                    <span className="dot dot-idle" />{idle}
                  </span>
                )}
                {props.sessions.length === 0 && <span className="fleet-empty">no sessions</span>}
              </div>
              {usage && (
                <span className="fleet-usage" title="Total usage across all sessions">
                  Σ {usage}
                </span>
              )}
            </>
          )
        })()}
      </div>
    </aside>
  )
}
