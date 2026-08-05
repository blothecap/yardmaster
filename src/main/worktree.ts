import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface WorktreeInfo {
  path: string
  branch: string
  baseBranch: string
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

export async function detectRepoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, 'rev-parse', '--show-toplevel')
  } catch {
    return null
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'session'
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

async function ensureExcluded(repoRoot: string): Promise<void> {
  // .git may be a file in linked worktrees — resolve the real common dir
  const commonDir = path.resolve(repoRoot, await git(repoRoot, 'rev-parse', '--git-common-dir'))
  const excludeFile = path.join(commonDir, 'info', 'exclude')
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : ''
  if (!current.split('\n').includes('.worktrees/')) {
    fs.writeFileSync(excludeFile, current + (current.endsWith('\n') || current === '' ? '' : '\n') + '.worktrees/\n')
  }
}

export async function createWorktree(repoRoot: string, sessionName: string): Promise<WorktreeInfo> {
  const base = slugify(sessionName)
  let branch = base
  for (let i = 2; await branchExists(repoRoot, branch); i++) branch = `${base}-${i}`
  await ensureExcluded(repoRoot)
  const wtPath = path.join(repoRoot, '.worktrees', branch)
  const currentBranch = await git(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
  const baseBranch = currentBranch === 'HEAD' ? 'main' : currentBranch
  await git(repoRoot, 'worktree', 'add', wtPath, '-b', branch)
  return { path: wtPath, branch, baseBranch }
}

export async function removeWorktree(
  repoRoot: string,
  wtPath: string,
  branch: string,
  deleteBranch: boolean
): Promise<void> {
  await git(repoRoot, 'worktree', 'remove', '--force', wtPath)
  if (deleteBranch) await git(repoRoot, 'branch', '-D', branch)
  await git(repoRoot, 'worktree', 'prune')
}
