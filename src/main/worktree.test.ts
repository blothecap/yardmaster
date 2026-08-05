import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectRepoRoot, slugify, createWorktree, removeWorktree } from './worktree'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let dir: string
let repo: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wt-'))
  repo = path.join(dir, 'proj')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t.t')
  git(repo, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('detectRepoRoot', () => {
  it('returns the repo root for a repo subdirectory', async () => {
    const sub = path.join(repo, 'src')
    fs.mkdirSync(sub)
    expect(await detectRepoRoot(sub)).toBe(fs.realpathSync(repo))
  })

  it('returns null outside a repo', async () => {
    expect(await detectRepoRoot(os.tmpdir())).toBeNull()
  })
})

describe('slugify', () => {
  it('kebab-cases session names into branch-safe slugs', () => {
    expect(slugify('Fix Auth Bug!')).toBe('fix-auth-bug')
    expect(slugify('  weird__name  ')).toBe('weird-name')
    expect(slugify('---')).toBe('session')
  })
})

describe('createWorktree', () => {
  it('creates a worktree under .worktrees on a branch named after the session', async () => {
    const wt = await createWorktree(fs.realpathSync(repo), 'Fix Auth')
    expect(wt.branch).toBe('fix-auth')
    expect(wt.path).toBe(path.join(fs.realpathSync(repo), '.worktrees', 'fix-auth'))
    expect(fs.existsSync(path.join(wt.path, 'a.txt'))).toBe(true)
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/fix-auth')).toBeTruthy()
  })

  it('records the branch checked out in repoRoot as baseBranch', async () => {
    const wt = await createWorktree(fs.realpathSync(repo), 'Fix Auth')
    expect(wt.baseBranch).toBe('main')
  })

  it('falls back to "main" for baseBranch when repoRoot is in detached HEAD', async () => {
    git(repo, 'checkout', '-q', '--detach', 'main')
    const wt = await createWorktree(fs.realpathSync(repo), 'Fix Auth')
    expect(wt.baseBranch).toBe('main')
  })

  it('registers .worktrees/ in .git/info/exclude so git status stays clean', async () => {
    await createWorktree(fs.realpathSync(repo), 'x')
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.worktrees/')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('uniquifies the branch when the name is taken', async () => {
    const a = await createWorktree(fs.realpathSync(repo), 'task')
    const b = await createWorktree(fs.realpathSync(repo), 'task')
    expect(a.branch).toBe('task')
    expect(b.branch).toBe('task-2')
    expect(fs.existsSync(b.path)).toBe(true)
  })
})

describe('removeWorktree', () => {
  it('removes the worktree and can delete the branch', async () => {
    const root = fs.realpathSync(repo)
    const wt = await createWorktree(root, 'gone')
    await removeWorktree(root, wt.path, wt.branch, true)
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/gone')).toThrow()
  })

  it('can keep the branch while removing the worktree', async () => {
    const root = fs.realpathSync(repo)
    const wt = await createWorktree(root, 'kept')
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'wip') // dirty worktree must still remove
    await removeWorktree(root, wt.path, wt.branch, false)
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/kept')).toBeTruthy()
  })
})
