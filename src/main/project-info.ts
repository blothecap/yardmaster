import { execFile } from 'node:child_process'
import { detectRepoRoot } from './worktree'

export interface ProjectInfo {
  repoRoot: string | null
  branch: string | null // 'detached' when HEAD is detached
  dirtyFiles: number
  ahead: number | null // commits ahead of baseBranch (only when baseBranch given)
  lastCommit: { sha: string; subject: string } | null
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

/** Snapshot of a directory's git state. Never throws — failures degrade to nulls/zeros. */
export async function projectInfo(cwd: string, baseBranch?: string): Promise<ProjectInfo> {
  const repoRoot = await detectRepoRoot(cwd)
  if (!repoRoot) return { repoRoot: null, branch: null, dirtyFiles: 0, ahead: null, lastCommit: null }

  let branch: string | null = null
  try {
    const b = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
    branch = b === 'HEAD' ? 'detached' : b
  } catch {
    branch = null
  }

  let dirtyFiles = 0
  try {
    const status = await git(cwd, 'status', '--porcelain')
    dirtyFiles = status.split('\n').filter((l) => l.trim()).length
  } catch {
    dirtyFiles = 0
  }

  let ahead: number | null = null
  if (baseBranch) {
    try {
      ahead = Number(await git(cwd, 'rev-list', '--count', `${baseBranch}..HEAD`))
      if (!Number.isFinite(ahead)) ahead = null
    } catch {
      ahead = null
    }
  }

  let lastCommit: ProjectInfo['lastCommit'] = null
  try {
    const line = await git(cwd, 'log', '-1', '--format=%h %s')
    const sp = line.indexOf(' ')
    if (sp > 0) lastCommit = { sha: line.slice(0, sp), subject: line.slice(sp + 1) }
  } catch {
    lastCommit = null // e.g. empty repo with no commits
  }

  return { repoRoot, branch, dirtyFiles, ahead, lastCommit }
}
