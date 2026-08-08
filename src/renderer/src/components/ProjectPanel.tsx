import { useEffect, useState } from 'react'
import type { SessionView } from '../../../shared/types'
import type { ProjectInfo } from '../../../main/project-info'
import { projectName, shortCwd, keyOf } from '../session-utils'

interface ProjectPanelProps {
  session: SessionView
  home: string
}

/**
 * Complements the session rows instead of repeating them: rows already carry
 * branch, activity, and usage, so this panel shows working-tree state (dirty /
 * ahead), the last commit, and session-specific flags.
 */
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

  const key = keyOf(session)

  return (
    <div className="project-panel">
      <div className="project-panel-header">Project</div>
      <div className="project-panel-name" title={key}>
        {projectName(key, [key])}
        <span className="project-panel-path">{shortCwd(key, home)}</span>
      </div>
      {info && (
        info.repoRoot ? (
          <>
            <div className="project-panel-row">
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
                <span className="git-clean">working tree clean</span>
              )}
            </div>
            {info.lastCommit && (
              <div className="project-panel-commit" title={`${info.lastCommit.sha} ${info.lastCommit.subject}`}>
                <span className="commit-sha">{info.lastCommit.sha}</span> {info.lastCommit.subject}
              </div>
            )}
          </>
        ) : (
          <div className="project-panel-row dim">not a git repository</div>
        )
      )}
      {session.extraArgs && (
        <div className="project-panel-args" title={`claude flags: ${session.extraArgs}`}>
          {session.extraArgs}
        </div>
      )}
    </div>
  )
}
