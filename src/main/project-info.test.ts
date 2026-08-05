import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { projectInfo } from './project-info'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let dir: string
let repo: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pi-'))
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

describe('projectInfo', () => {
  it('returns the null shape outside a git repo', async () => {
    expect(await projectInfo(os.tmpdir())).toEqual({
      repoRoot: null,
      branch: null,
      dirtyFiles: 0,
      ahead: null
    })
  })

  it('reports branch and zero dirty files for a clean repo', async () => {
    const info = await projectInfo(repo)
    expect(info.repoRoot).toBe(fs.realpathSync(repo))
    expect(info.branch).toBe('main')
    expect(info.dirtyFiles).toBe(0)
    expect(info.ahead).toBeNull()
  })

  it('counts uncommitted files', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new')
    const info = await projectInfo(repo)
    expect(info.dirtyFiles).toBe(2)
  })

  it('counts commits ahead of the base branch when given', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature')
    fs.writeFileSync(path.join(repo, 'c.txt'), 'x')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'one')
    fs.writeFileSync(path.join(repo, 'd.txt'), 'y')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'two')
    const info = await projectInfo(repo, 'main')
    expect(info.branch).toBe('feature')
    expect(info.ahead).toBe(2)
  })

  it('ahead degrades to null for a bogus base branch', async () => {
    const info = await projectInfo(repo, 'no-such-branch')
    expect(info.ahead).toBeNull()
    expect(info.branch).toBe('main')
  })
})
