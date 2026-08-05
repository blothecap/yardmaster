import { execFile } from 'node:child_process'
import type { ChangedFile } from '../shared/types'
import { worktreePathFor } from './worktree'

export type { ChangedFile }

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

export async function changedFiles(
  repoRoot: string,
  branch: string,
  baseBranch: string
): Promise<ChangedFile[]> {
  const out = await git(repoRoot, 'diff', '--name-status', `${baseBranch}...${branch}`)
  const files: ChangedFile[] = out === '' ? [] : out.split('\n').map((line) => {
    const parts = line.split('\t')
    const status = parts[0]
    const filePath = parts[parts.length - 1]
    return { path: filePath, status }
  })

  const worktreePath = worktreePathFor(repoRoot, branch)
  const uncommitted = await git(worktreePath, 'status', '--porcelain')
  if (uncommitted !== '') {
    files.push({ path: '(uncommitted changes)', status: '*' })
  }
  return files
}

export async function fileDiff(
  worktreePath: string,
  repoRoot: string,
  branch: string,
  baseBranch: string,
  file: string
): Promise<string> {
  const committed = await git(repoRoot, 'diff', `${baseBranch}...${branch}`, '--', file)
  const uncommitted = await git(worktreePath, 'diff', 'HEAD', '--', file)
  if (uncommitted !== '') {
    return committed === '' ? uncommitted : `${committed}\n${uncommitted}`
  }
  return committed
}

export async function mergeBranch(
  repoRoot: string,
  branch: string,
  baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const currentBranch = await git(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (currentBranch !== baseBranch) {
    return {
      ok: false,
      error: `repo is on branch "${currentBranch}", not the base branch "${baseBranch}" — switch to "${baseBranch}" before merging`
    }
  }

  const status = await git(repoRoot, 'status', '--porcelain')
  if (status !== '') {
    return { ok: false, error: `repo has uncommitted changes — commit or stash them before merging` }
  }

  try {
    await git(repoRoot, 'merge', '--no-edit', branch)
    return { ok: true }
  } catch (err) {
    await git(repoRoot, 'merge', '--abort').catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `merge conflict — merge aborted automatically: ${message}` }
  }
}
