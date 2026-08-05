import { useCallback, useEffect, useState } from 'react'
import type { ChangedFile } from '../../../shared/types'

interface ReviewPaneProps {
  sessionId: string
  branch: string
  baseBranch: string
  onClose(): void
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-del'
  return ''
}

export default function ReviewPane({ sessionId, branch, baseBranch, onClose }: ReviewPaneProps): React.JSX.Element {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  const loadFiles = useCallback(() => {
    setFiles(null)
    setFilesError(null)
    setSelected(null)
    setDiff(null)
    setDiffError(null)
    window.api.reviewFiles(sessionId).then((res) => {
      if (res.ok) setFiles(res.files)
      else setFilesError(res.error)
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

  return (
    <div className="review-pane">
      <div className="review-pane-header">
        <span className="review-pane-title">{`⎇ ${branch} → ${baseBranch}`}</span>
        <div className="review-pane-header-actions">
          <button title="Refresh" onClick={loadFiles}>⟳</button>
          <button title="Close" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="review-pane-body">
        <div className="review-pane-files">
          {filesError && <div className="review-pane-error">{filesError}</div>}
          {!filesError && files === null && <div className="review-pane-empty">Loading…</div>}
          {!filesError && files !== null && files.length === 0 && (
            <div className="review-pane-empty">No changes</div>
          )}
          {!filesError && files?.map((f) => (
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
        <button onClick={handleMerge} disabled={merging}>
          {merging ? 'Merging…' : `Merge into ${baseBranch}`}
        </button>
        <button onClick={() => window.api.remove(sessionId)}>Remove session…</button>
      </div>
    </div>
  )
}
