import { useEffect, useMemo } from 'react'
import type { SessionView } from '../../../shared/types'

interface InboxProps {
  sessions: SessionView[]
  onJump(id: string): void
  onClose(): void
}

export default function Inbox(props: InboxProps): React.JSX.Element {
  const { sessions, onJump, onClose } = props

  const needy = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'needs-you')
        .sort((a, b) => a.statusChangedAt - b.statusChangedAt),
    [sessions]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter') {
        if (needy[0]) onJump(needy[0].id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [needy, onJump, onClose])

  return (
    <div className="inbox-panel">
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
              <div className="inbox-name">{s.name}</div>
              <div className="inbox-message">{s.needsYouMessage ?? 'waiting for input'}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
