import { useState } from 'react'

interface NewSessionDialogProps {
  recentDirs: string[]
  home: string
  onCreate(name: string, cwd: string): void
  onCancel(): void
}

export default function NewSessionDialog(props: NewSessionDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(props.recentDirs[0] ?? props.home)

  const submit = (): void => {
    if (name.trim() && cwd) props.onCreate(name.trim(), cwd)
  }

  return (
    <div className="dialog-backdrop" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New Session</h2>
        <label>
          Name
          <input
            autoFocus
            placeholder="e.g. fix-auth-bug"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') props.onCancel()
            }}
          />
        </label>
        <label>
          Directory
          <div className="dir-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <button
              onClick={async () => {
                const picked = await window.api.pickDirectory()
                if (picked) setCwd(picked)
              }}
            >
              Browse…
            </button>
          </div>
        </label>
        {props.recentDirs.length > 0 && (
          <div className="recent-dirs">
            {props.recentDirs.slice(0, 5).map((d) => (
              <button key={d} className="recent-dir" onClick={() => setCwd(d)}>
                {d.startsWith(props.home) ? '~' + d.slice(props.home.length) : d}
              </button>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" disabled={!name.trim() || !cwd} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
