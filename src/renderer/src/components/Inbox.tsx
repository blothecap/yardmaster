import { useEffect, useMemo, useRef } from 'react'
import type { SessionView } from '../../../shared/types'

interface InboxProps {
  sessions: SessionView[]
  onJump(id: string): void
  onClose(): void
}

export default function Inbox(props: InboxProps): React.JSX.Element {
  const { sessions, onJump, onClose } = props
  const panelRef = useRef<HTMLDivElement>(null)

  const needy = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'needs-you')
        .sort((a, b) => a.statusChangedAt - b.statusChangedAt),
    [sessions]
  )

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Claude Code's permission prompt defaults to "Yes" — Enter accepts the
  // default (approve), Escape rejects it (deny). After answering, the
  // session's own hooks flip it out of needs-you and the row disappears via
  // the normal `sessions` prop update — no local state needed here.
  const approve = (id: string): void => window.api.input(id, '\r')
  const deny = (id: string): void => window.api.input(id, '\x1b')

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter') {
      if (needy[0]) onJump(needy[0].id)
    } else if (e.key === 'a') {
      if (needy[0]) approve(needy[0].id)
    } else if (e.key === 'd') {
      if (needy[0]) deny(needy[0].id)
    }
  }

  return (
    <div className="inbox-panel" ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="inbox-header">
        <span>Waiting on You</span>
        <button className="inbox-close" title="Close" onClick={onClose}>×</button>
      </div>
      {needy.length === 0 ? (
        <div className="inbox-empty">Nothing is waiting on you 🎉</div>
      ) : (
        <ul className="inbox-list">
          {needy.map((s) => (
            <li key={s.id} className="inbox-row" onClick={() => onJump(s.id)}>
              <div className="inbox-row-main">
                <div className="inbox-name">{s.name}</div>
                <div className="inbox-message">{s.needsYouMessage ?? 'waiting for input'}</div>
              </div>
              <div className="inbox-row-actions">
                <button
                  className="inbox-action-btn approve"
                  title="Approve — sends Enter"
                  onClick={(e) => {
                    e.stopPropagation()
                    approve(s.id)
                  }}
                >
                  ✓
                </button>
                <button
                  className="inbox-action-btn deny"
                  title="Deny — sends Escape"
                  onClick={(e) => {
                    e.stopPropagation()
                    deny(s.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {needy.length > 0 && (
        <div className="inbox-footer">
          <span>a approve</span>
          <span>d deny</span>
          <span>↵ jump</span>
          <span>esc close</span>
        </div>
      )}
    </div>
  )
}
