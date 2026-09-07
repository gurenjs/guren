import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Driven as the hook actually runs — a real `git push` command through stdin,
// against real repositories — because every verdict here is a git range answer.

const HOOK = resolve(import.meta.dir, 'push-overlap-hook.ts')

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

function commit(cwd: string, path: string, body: string, message: string): void {
  const full = join(cwd, path)
  mkdirSync(resolve(full, '..'), { recursive: true })
  writeFileSync(full, body)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message)
}

/** Runs the hook in `cwd` on a `git push`, returning its exit code and stderr. */
function runHook(cwd: string, command = 'git push'): { code: number; err: string } {
  const r = Bun.spawnSync(['bun', HOOK], { cwd, stdin: Buffer.from(JSON.stringify({ tool_input: { command } })) })
  return { code: r.exitCode, err: r.stderr.toString() }
}

describe('push-overlap-hook', () => {
  let dir: string
  let origin: string
  let clone: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-push-overlap-'))
    origin = join(dir, 'origin')
    clone = join(dir, 'clone')
    mkdirSync(origin)
    git(origin, 'init', '-q', '-b', 'main')
    commit(origin, 'src/app.ts', 'export const a = 1\n', 'init')
    git(origin, 'config', 'receive.denyCurrentBranch', 'ignore')
    git(dir, 'clone', '-q', origin, clone)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('blocks when main rewrote a file the branch also changes, naming the commit', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    const { code, err } = runHook(clone)

    expect(code).toBe(2)
    expect(err).toContain('src/app.ts')
    expect(err).toContain('theirs on main')
  })

  test('allows a branch whose files main has not touched', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/other.ts', 'export const b = 1\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    expect(runHook(clone).code).toBe(0)
  })

  test('defeats a stale origin/main, which is the check that fails open', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')
    // The ref on disk still predates the overlap; only the hook's own fetch sees it.
    expect(Bun.spawnSync(['git', 'rev-list', '--count', 'HEAD..origin/main'], { cwd: clone }).stdout.toString().trim()).toBe('0')

    expect(runHook(clone).code).toBe(2)
  })

  test('reports rather than passes when the fetch cannot run', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    git(clone, 'remote', 'set-url', 'origin', join(dir, 'gone'))

    const { code, err } = runHook(clone)

    expect(code).toBe(2)
    expect(err).toContain('unchecked')
  })

  test('ignores a changeset or CHANGELOG collision, which every concurrent PR has', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, '.changeset/mine.md', 'mine\n', 'mine')
    commit(origin, '.changeset/mine.md', 'theirs\n', 'theirs on main')

    expect(runHook(clone).code).toBe(0)
  })

  test('matches the `git -C <dir> push` form, and skips a non-push command', () => {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    expect(runHook(clone, 'git -C /elsewhere push --force-with-lease').code).toBe(2)
    expect(runHook(clone, 'git status').code).toBe(0)
  })

  test('leaves main itself alone', () => {
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    expect(runHook(clone).code).toBe(0)
  })
})
