import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorktree } from './worktree'
import { changedFiles, fileDiff, mergeBranch } from './git-review'

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
