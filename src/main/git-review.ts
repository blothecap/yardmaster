import { execFile, type ExecFileException } from 'node:child_process'
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

export async function pushBranch(
  worktreePath: string,
  branch: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await git(worktreePath, 'push', '-u', 'origin', branch)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

function runGh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err as ExecFileException, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

export async function pushAndCreatePr(
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const pushed = await pushBranch(worktreePath, branch)
  if (!pushed.ok) return pushed

  try {
    const { stdout } = await runGh(
      ['pr', 'create', '--head', branch, '--base', baseBranch, '--fill'],
      worktreePath
    )
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    const urlLine = [...lines].reverse().find((l) => /^https:/.test(l))
    return { ok: true, url: urlLine ?? stdout.trim() }
  } catch (err) {
    const e = err as ExecFileException & { stdout?: string; stderr?: string }
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'GitHub CLI (gh) not found — install it or use Merge instead.' }
    }
    const message = (e.stderr ?? '').trim() || e.message
    return { ok: false, error: message }
  }
}
