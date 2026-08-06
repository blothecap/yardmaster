import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorktree } from './worktree'
import {
  changedFiles,
  fileDiff,
  mergeBranch,
  pushBranch,
  extractPrUrl,
  uncommittedFiles,
  uncommittedDiff,
  commitsSince,
  headCommit,
  currentBranch
} from './git-review'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let dir: string
let repo: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-gr-'))
  repo = path.join(dir, 'proj')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t.t')
  git(repo, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  repo = fs.realpathSync(repo)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('changedFiles', () => {
  it('lists committed changes on the branch relative to base', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new file\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'add b')
    const files = await changedFiles(repo, wt.branch, wt.baseBranch)
    expect(files).toEqual([{ path: 'b.txt', status: 'A' }])
  })

  it('marks uncommitted worktree changes with a pseudo entry', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'changed\n')
    const files = await changedFiles(repo, wt.branch, wt.baseBranch)
    expect(files).toContainEqual({ path: '(uncommitted changes)', status: '*' })
  })

  it('omits the uncommitted marker when the worktree is clean', async () => {
    const wt = await createWorktree(repo, 'feature')
    const files = await changedFiles(repo, wt.branch, wt.baseBranch)
    expect(files.find((f) => f.status === '*')).toBeUndefined()
    expect(files).toEqual([])
  })
})

describe('fileDiff', () => {
  it('returns the committed diff for a file', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'hello\nworld\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'edit a')
    const diff = await fileDiff(wt.path, repo, wt.branch, wt.baseBranch, 'a.txt')
    expect(diff).toContain('+world')
  })

  it('appends uncommitted diff content when the file has worktree-local changes', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'hello\nuncommitted\n')
    const diff = await fileDiff(wt.path, repo, wt.branch, wt.baseBranch, 'a.txt')
    expect(diff).toContain('+uncommitted')
  })
})

describe('mergeBranch', () => {
  it('merges the branch into base on the happy path', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'add b')
    const result = await mergeBranch(repo, wt.branch, wt.baseBranch)
    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true)
  })

  it('refuses to merge when repoRoot is dirty', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'add b')
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'oops\n')
    const result = await mergeBranch(repo, wt.branch, wt.baseBranch)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false)
  })

  it('refuses to merge when repoRoot is not on the base branch', async () => {
    const wt = await createWorktree(repo, 'feature')
    git(repo, 'checkout', '-q', '-b', 'other')
    const result = await mergeBranch(repo, wt.branch, wt.baseBranch)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('aborts cleanly on merge conflict, leaving no MERGE_HEAD and a clean repo', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'feature change\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'conflict from feature')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base change\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'conflict from base')
    const result = await mergeBranch(repo, wt.branch, wt.baseBranch)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/conflict/i)
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })
})

describe('pushBranch', () => {
  it('pushes the branch to origin on the happy path', async () => {
    const bare = path.join(dir, 'origin.git')
    git(dir, 'init', '--bare', '-b', 'main', bare)
    git(repo, 'remote', 'add', 'origin', bare)

    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'add b')

    const result = await pushBranch(wt.path, wt.branch)
    expect(result).toEqual({ ok: true })
    expect(git(bare, 'rev-parse', `refs/heads/${wt.branch}`)).toBeTruthy()
  })

  it('fails when the repo has no remote', async () => {
    const wt = await createWorktree(repo, 'feature')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
    git(wt.path, 'add', '.')
    git(wt.path, 'commit', '-m', 'add b')

    const result = await pushBranch(wt.path, wt.branch)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/origin|remote/i)
  })
})

describe('uncommittedFiles', () => {
  it('returns empty array on a clean repo', async () => {
    expect(await uncommittedFiles(repo)).toEqual([])
  })

  it('reports a modified tracked file using the worktree status column', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    const files = await uncommittedFiles(repo)
    expect(files).toEqual([{ path: 'a.txt', status: 'M' }])
  })

  it('reports an untracked file as ?', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hi\n')
    const files = await uncommittedFiles(repo)
    expect(files).toEqual([{ path: 'new.txt', status: '?' }])
  })

  it('reports a staged-add file using the index status column', async () => {
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'hi\n')
    git(repo, 'add', 'staged.txt')
    const files = await uncommittedFiles(repo)
    expect(files).toEqual([{ path: 'staged.txt', status: 'A' }])
  })

  it('takes the destination path for a rename', async () => {
    git(repo, 'mv', 'a.txt', 'renamed.txt')
    const files = await uncommittedFiles(repo)
    expect(files).toEqual([{ path: 'renamed.txt', status: 'R' }])
  })
})

describe('uncommittedDiff', () => {
  it('returns the diff for a modified tracked file', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nworld\n')
    const diff = await uncommittedDiff(repo, 'a.txt')
    expect(diff).toContain('+world')
  })

  it('returns empty string for an unmodified tracked file', async () => {
    const diff = await uncommittedDiff(repo, 'a.txt')
    expect(diff).toBe('')
  })

  it('returns the diff for an untracked file via --no-index (exit code 1 tolerated)', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n')
    const diff = await uncommittedDiff(repo, 'new.txt')
    expect(diff).toContain('+brand new')
  })
})

describe('commitsSince', () => {
  it('lists oneline commits after the given start commit', async () => {
    const start = git(repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second commit')
    const commits = await commitsSince(repo, start)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toContain('second commit')
  })

  it('returns an empty array when there are no new commits', async () => {
    const start = git(repo, 'rev-parse', 'HEAD')
    expect(await commitsSince(repo, start)).toEqual([])
  })

  it('returns an empty array for a bad/unknown start commit', async () => {
    expect(await commitsSince(repo, 'not-a-real-commit-sha')).toEqual([])
  })
})

describe('headCommit', () => {
  it('returns the current HEAD sha', async () => {
    const expected = git(repo, 'rev-parse', 'HEAD')
    expect(await headCommit(repo)).toBe(expected)
  })

  it('returns null when cwd is not a git repository', async () => {
    const nonRepo = path.join(dir, 'not-a-repo')
    fs.mkdirSync(nonRepo)
    expect(await headCommit(nonRepo)).toBeNull()
  })
})

describe('currentBranch', () => {
  it('returns the checked-out branch name', async () => {
    expect(await currentBranch(repo)).toBe('main')
  })

  it('returns null when cwd is not a git repository', async () => {
    const nonRepo = path.join(dir, 'not-a-repo-2')
    fs.mkdirSync(nonRepo)
    expect(await currentBranch(nonRepo)).toBeNull()
  })
})

describe('extractPrUrl', () => {
  it('picks the last https line when gh prints several', () => {
    const stdout = [
      'Creating pull request for feature into main in some/repo',
      '',
      'https://example.com/not-the-pr',
      'https://github.com/some/repo/pull/42'
    ].join('\n')
    expect(extractPrUrl(stdout)).toBe('https://github.com/some/repo/pull/42')
  })

  it('returns null when stdout has no https line', () => {
    expect(extractPrUrl('no url here\njust some text\n')).toBeNull()
  })
})
