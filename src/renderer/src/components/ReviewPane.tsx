import { useCallback, useEffect, useState } from 'react'
import type { ChangedFile } from '../../../shared/types'

interface ReviewPaneProps {
  sessionId: string
  onClose(): void
}

type ReviewMode = 'worktree' | 'plain'

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-del'
  return ''
}

export default function ReviewPane({ sessionId, onClose }: ReviewPaneProps): React.JSX.Element {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [mode, setMode] = useState<ReviewMode | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [commits, setCommits] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [pushing, setPushing] = useState(false)

  const loadFiles = useCallback(() => {
    setFiles(null)
    setFilesError(null)
    setSelected(null)
    setDiff(null)
    setDiffError(null)
    window.api.reviewFiles(sessionId).then((res) => {
      if (res.ok) {
        setFiles(res.files)
        setMode(res.mode)
        setBranch(res.branch)
        setBaseBranch(res.baseBranch ?? null)
        setCommits(res.commits)
      } else {
        setFilesError(res.error)
      }
    })
  }, [sessionId])

  useEffect(() => { loadFiles() }, [loadFiles])

  useEffect(() => {
    if (!selected) return
    let stale = false
    setDiff(null)
    setDiffError(null)
    window.api.reviewDiff(sessionId, selected).then((res) => {
      if (stale) return
      if (res.ok) setDiff(res.diff)
      else setDiffError(res.error)
    })
    return () => { stale = true }
  }, [sessionId, selected])

  const handleMerge = async (): Promise<void> => {
    setMerging(true)
    const result = await window.api.reviewMerge(sessionId)
    setMerging(false)
    if (!result.ok) alert(`Merge failed: ${result.error}`)
    loadFiles()
  }

  const handlePushPr = async (): Promise<void> => {
    setPushing(true)
    const result = await window.api.reviewPr(sessionId)
    setPushing(false)
    if (!result.ok) alert(`Push + PR failed: ${result.error}`)
  }

  if (filesError) {
    return (
      <div className="review-pane">
        <div className="review-pane-header">
          <span className="review-pane-title">Changes</span>
          <div className="review-pane-header-actions">
            <button title="Refresh" onClick={loadFiles}>⟳</button>
            <button title="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="review-pane-body">
          <div className="right-pane-empty">{filesError}</div>
        </div>
        <div className="review-pane-footer">
          <button className="footer-danger" onClick={() => window.api.remove(sessionId)}>
            Remove…
          </button>
          <div className="footer-spacer" />
        </div>
      </div>
    )
  }

  const header =
    mode === 'worktree'
      ? `⎇ ${branch} → ${baseBranch}`
      : mode === 'plain'
        ? `⎇ ${branch ?? '?'} · uncommitted changes`
        : ''

  return (
    <div className="review-pane">
      <div className="review-pane-header">
        <span className="review-pane-title">{header}</span>
        <div className="review-pane-header-actions">
          <button title="Refresh" onClick={loadFiles}>⟳</button>
          <button title="Close" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="review-pane-body">
        <div className="review-pane-files">
          {commits.length > 0 && (
            <div className="review-pane-commits">
              <div className="review-pane-commits-title">Commits this session</div>
              {commits.map((c) => (
                <div key={c} className="review-commit-row">{c}</div>
              ))}
            </div>
          )}
          {files === null && <div className="review-pane-empty">Loading…</div>}
          {files !== null && files.length === 0 && (
            <div className="review-pane-empty">No changes</div>
          )}
          {files?.map((f) => (
            <div
              key={f.path}
              className={['review-file-row', f.path === selected ? 'active' : ''].join(' ')}
              onClick={() => setSelected(f.path)}
            >
              <span className="review-status">{f.status}</span>
              <span className="review-file-path">{f.path}</span>
            </div>
          ))}
        </div>
        <div className="review-pane-diff">
          {diffError && <div className="review-pane-error">{diffError}</div>}
          {!diffError && !selected && (
            <div className="review-pane-empty">Select a file to view its diff</div>
          )}
          {!diffError && selected && diff === null && <div className="review-pane-empty">Loading…</div>}
          {!diffError && selected && diff !== null && (
            diff === '' ? (
              <div className="review-pane-empty">No diff to show</div>
            ) : (
              <pre className="diff-view">
                {diff.split('\n').map((line, i) => (
                  <div key={i} className={diffLineClass(line)}>{line}</div>
                ))}
              </pre>
            )
          )}
        </div>
      </div>
      <div className="review-pane-footer">
        <button className="footer-danger" onClick={() => window.api.remove(sessionId)}>
          Remove…
        </button>
        <div className="footer-spacer" />
        {mode === 'worktree' && (
          <>
            <button
              className="footer-secondary"
              onClick={handlePushPr}
              disabled={pushing || merging || files?.length === 0}
            >
              {pushing ? 'Pushing…' : 'Push + PR'}
            </button>
            <button
              className="footer-primary"
              onClick={handleMerge}
              disabled={merging || pushing || files?.length === 0}
            >
              {merging ? 'Merging…' : `Merge into ${baseBranch}`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
