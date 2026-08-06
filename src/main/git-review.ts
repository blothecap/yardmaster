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

/** Like git(), but preserves leading whitespace — porcelain status lines are column-sensitive. */
function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.replace(/\n+$/, ''))
    })
  })
}

/**
 * Uncommitted (working-tree + index) changes for a plain (non-worktree) session.
 * Uses `-z` (NUL-separated, unquoted) porcelain: v1's default format quotes paths
 * containing spaces/non-ASCII and renders renames as "orig -> dest" text, both of
 * which corrupt paths that legitimately contain a space or the literal " -> ".
 * Paths are always repo-root-relative — callers must pass repoRoot as cwd, not a
 * session's (possibly nested) working directory, or diffs against those paths
 * will silently come back empty (see uncommittedDiff).
 */
export async function uncommittedFiles(cwd: string): Promise<ChangedFile[]> {
  const out = await gitRaw(cwd, 'status', '--porcelain', '-z')
  const raw = out.endsWith('\0') ? out.slice(0, -1) : out
  if (raw === '') return []
  const tokens = raw.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const xy = token.slice(0, 2)
    const filePath = token.slice(3)
    const status = xy === '??' ? '?' : xy[1] !== ' ' ? xy[1] : xy[0]
    files.push({ path: filePath, status })
    // Renames/copies emit a second NUL-terminated record holding the orig path —
    // it has no "XY " prefix of its own, so skip it rather than parse it as a file.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++
  }
  return files
}

/** Porcelain status code (`'?'` for untracked, else the raw 2-char XY) for a single path, or null if clean/absent. */
async function fileStatusCode(cwd: string, file: string): Promise<string | null> {
  const out = await gitRaw(cwd, 'status', '--porcelain', '-z', '--', file)
  const raw = out.endsWith('\0') ? out.slice(0, -1) : out
  if (raw === '') return null
  const xy = raw.split('\0')[0].slice(0, 2)
  return xy === '??' ? '?' : xy
}

/**
 * `git diff --no-index` exits 1 whenever the two sides differ — that's success, not
 * an error, and its stdout is the diff. But it also exits 1 (with nothing on stdout,
 * the message goes to stderr) when the file plain doesn't exist — that IS an error.
 * Exit 1 is therefore only tolerated when stdout is non-empty (a real diff always has
 * a header, even for a zero-byte file, so this doesn't misclassify legitimate diffs).
 */
export function diffNoIndex(cwd: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['diff', '--no-index', '--', '/dev/null', file],
      { cwd, timeout: 15000 },
      (err, stdout, stderr) => {
        if (!err) { resolve(stdout.trim()); return }
        if ((err as ExecFileException).code === 1 && stdout !== '') { resolve(stdout.trim()); return }
        reject(new Error(stderr.trim() || err.message))
      }
    )
  })
}

/**
 * Diff of a file's uncommitted state for a plain (non-worktree) session.
 * Routes by the file's own porcelain status rather than `ls-files` trackedness:
 * a staged deletion (`git rm`) is untracked by ls-files' definition (removed from
 * the index) but must still diff against HEAD, not --no-index against a now-missing
 * file. Only a genuinely untracked path ('?') uses the --no-index path.
 */
export async function uncommittedDiff(cwd: string, file: string): Promise<string> {
  const status = await fileStatusCode(cwd, file)
  if (status === '?') return diffNoIndex(cwd, file)
  return git(cwd, 'diff', 'HEAD', '--', file)
}

/** Oneline commit log since (exclusive) `startCommit`, newest 50; [] for any bad/unknown ref. */
export async function commitsSince(cwd: string, startCommit: string): Promise<string[]> {
  try {
    // '--' guards against a startCommit that happens to start with '-' being parsed as a flag.
    const out = await git(cwd, 'log', '--oneline', '--max-count=50', `${startCommit}..HEAD`, '--')
    return out === '' ? [] : out.split('\n')
  } catch {
    return []
  }
}

/** Current HEAD sha, or null when cwd isn't a git repo (or has no commits yet). */
export async function headCommit(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', 'HEAD')
  } catch {
    return null
  }
}

/** Checked-out branch name, or null when cwd isn't a git repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const b = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
    return b === 'HEAD' ? 'detached' : b
  } catch {
    return null
  }
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

export function extractPrUrl(stdout: string): string | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const urlLine = [...lines].reverse().find((l) => /^https:\/\//.test(l))
  return urlLine ?? null
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
    const url = extractPrUrl(stdout)
    return { ok: true, ...(url ? { url } : {}) }
  } catch (err) {
    const e = err as ExecFileException & { stdout?: string; stderr?: string }
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'GitHub CLI (gh) not found — install it or use Merge instead.' }
    }
    const message = (e.stderr ?? '').trim() || e.message
    return { ok: false, error: message }
  }
}
