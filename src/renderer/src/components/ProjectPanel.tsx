import { useEffect, useState } from 'react'
import type { SessionView } from '../../../shared/types'
import type { ProjectInfo } from '../../../main/project-info'
import { projectName, relativeTime, shortCwd, keyOf } from '../session-utils'

interface ProjectPanelProps {
  session: SessionView
  home: string
}

function usageText(cost: SessionView['cost']): string | null {
  if (!cost) return null
  if (cost.costUsd !== null) return `$${cost.costUsd.toFixed(2)}`
  const total = cost.inputTokens + cost.outputTokens
  return total > 0 ? `${Math.round(total / 1000)}k tok` : null
}

export default function ProjectPanel({ session, home }: ProjectPanelProps): React.JSX.Element {
  const [info, setInfo] = useState<ProjectInfo | null>(null)

  useEffect(() => {
    let stale = false
    const fetchInfo = (): void => {
      window.api.projectInfo(session.id).then((i) => {
        if (!stale) setInfo(i)
      })
    }
    fetchInfo()
    const interval = setInterval(fetchInfo, 20000)
    return () => {
      stale = true
      clearInterval(interval)
    }
    // status changes (work finished) usually mean git state changed too — refetch
  }, [session.id, session.status])

  const usage = usageText(session.cost)
  const key = keyOf(session)

  return (
    <div className="project-panel">
      <div className="project-panel-header">Project</div>
      <div className="project-panel-name" title={shortCwd(key, home)}>
        {projectName(key, [key])}
      </div>
      {info && (
        info.repoRoot ? (
          <div className="project-panel-row">
            <span className="git-branch" title={`branch: ${info.branch ?? '?'}`}>
              ⎇ {info.branch ?? '?'}
            </span>
            {info.dirtyFiles > 0 && (
              <span className="git-dirty" title={`${info.dirtyFiles} uncommitted file(s)`}>
                {info.dirtyFiles} changed
              </span>
            )}
            {info.ahead !== null && info.ahead > 0 && session.worktree && (
              <span className="git-ahead" title={`${info.ahead} commit(s) ahead of ${session.worktree.baseBranch}`}>
                {info.ahead} ahead of {session.worktree.baseBranch}
              </span>
            )}
            {info.dirtyFiles === 0 && (info.ahead === null || info.ahead === 0) && (
              <span className="git-clean">clean</span>
            )}
          </div>
        ) : (
          <div className="project-panel-row dim">not a git repository</div>
        )
      )}
      <div className="project-panel-row dim">
        {usage && <span title={session.cost ? `${session.cost.inputTokens} in / ${session.cost.outputTokens} out tokens` : ''}>{usage}</span>}
        {session.lastActivityAt && <span>active {relativeTime(session.lastActivityAt)}</span>}
      </div>
      {session.extraArgs && (
        <div className="project-panel-args" title={session.extraArgs}>
          {session.extraArgs}
        </div>
      )}
    </div>
  )
}
