import { useEffect, useState } from 'react'

interface NewSessionDialogProps {
  recentDirs: string[]
  home: string
  initialDir?: string
  initialWorktree?: boolean
  onCreate(name: string, cwd: string, worktree: boolean): void
  onCancel(): void
}

function branchPreview(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'session'
}

function shortPath(p: string, home: string): string {
  if (!home) return p
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

export default function NewSessionDialog(props: NewSessionDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(props.initialDir ?? props.recentDirs[0] ?? props.home)
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [worktree, setWorktree] = useState(props.initialWorktree ?? false)

  useEffect(() => {
    let stale = false
    if (!cwd) { setRepoRoot(null); return }
    window.api.checkGitRepo(cwd).then((root) => {
      if (stale) return
      setRepoRoot(root)
      if (!root) setWorktree(false)
    })
    return () => { stale = true }
  }, [cwd])

  const submit = (): void => {
    const trimmedCwd = cwd.trim()
    if (name.trim() && trimmedCwd) props.onCreate(name.trim(), trimmedCwd, worktree && repoRoot !== null)
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
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') props.onCancel()
              }}
            />
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
                {shortPath(d, props.home)}
              </button>
            ))}
          </div>
        )}
        {repoRoot && (
          <label className="worktree-check">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            <span>
              Give this session its own isolated copy (worktree
              {name.trim() ? `, branch: ${branchPreview(name)}` : ''})
            </span>
          </label>
        )}
        <div className="dialog-actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" disabled={!name.trim() || !cwd.trim()} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
