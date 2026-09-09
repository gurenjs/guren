import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { pushTargets } from './push-overlap-hook'

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

describe('pushTargets', () => {
  const cwd = '/work/session'

  test('a plain `git push` runs in the hook cwd on HEAD', () => {
    expect(pushTargets('git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('git push -u origin HEAD', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })

  test('a leading cd moves the push, with `;` and `&&` alike', () => {
    expect(pushTargets('cd /other && git push origin b', cwd)).toEqual([{ cwd: '/other', ref: 'b' }])
    expect(pushTargets('cd /other; git push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
    expect(pushTargets('cd "/with space" && git push', cwd)).toEqual([{ cwd: '/with space', ref: 'HEAD' }])
    expect(pushTargets('cd sub && cd deeper && git push', cwd)).toEqual([{ cwd: '/work/session/sub/deeper', ref: 'HEAD' }])
  })

  test('`git -C <dir>` and `-c key=value` before the subcommand are read', () => {
    expect(pushTargets('git -C /other push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
    expect(pushTargets('git -C ../sibling -c url.https://x/.insteadOf=git@x: push origin b', cwd)).toEqual([
      { cwd: '/work/sibling', ref: 'b' },
    ])
  })

  test('the refspec names the local ref; a deletion pushes nothing', () => {
    expect(pushTargets('git push origin feature:main', cwd)).toEqual([{ cwd, ref: 'feature' }])
    expect(pushTargets('git push --force-with-lease origin +feature', cwd)).toEqual([{ cwd, ref: 'feature' }])
    expect(pushTargets('git push origin :gone', cwd)).toEqual([])
    expect(pushTargets('git push --delete origin gone', cwd)).toEqual([])
    expect(pushTargets('git push origin $(git branch --show-current)', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })

  test('a word merely containing git and push is not a push', () => {
    expect(pushTargets("sed -n '1,60p' scripts/git/push-overlap-hook.ts", cwd)).toEqual([])
    expect(pushTargets('bun test scripts/git/push-overlap-hook.test.ts', cwd)).toEqual([])
    expect(pushTargets('git log --oneline -- scripts/git/push-overlap-hook.ts', cwd)).toEqual([])
    expect(pushTargets('git grep -n push', cwd)).toEqual([])
    expect(pushTargets("echo 'git push'", cwd)).toEqual([])
    expect(pushTargets('git status', cwd)).toEqual([])
  })

  test('redirections and env prefixes do not hide or shift the push', () => {
    expect(pushTargets('GIT_SSH_COMMAND="ssh -o ConnectTimeout=5" git push origin b 2>&1', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('git push > /tmp/log 2>&1 && echo ok', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('(cd /other && git push origin b) | tail -1', cwd)).toEqual([{ cwd: '/other', ref: 'b' }])
  })

  test('a cd it cannot follow falls back to the hook cwd', () => {
    expect(pushTargets('cd $NOT_SET_ANYWHERE && git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('cd - && git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })
})

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

  /** A branch on `clone` whose one file main then rewrites. */
  function overlap(): void {
    git(clone, 'checkout', '-q', '-b', 'feature')
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')
  }

  test('blocks when main rewrote a file the branch also changes, naming the commit', () => {
    overlap()

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
    overlap()
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

  test('judges the worktree a `cd <dir> &&` push runs in, not the hook cwd', () => {
    overlap()
    // The session worktree: a merged branch whose file main has since rewritten.
    const session = join(dir, 'session')
    git(clone, 'worktree', 'add', '-q', '-b', 'merged', session, 'origin/main')
    commit(session, 'docs/rfc.md', 'rfc\n', 'rfc')
    commit(origin, 'docs/rfc.md', 'rfc squash-merged\n', 'merge rfc')
    // From `session`, pushing `session` itself blocks; pushing `clone` is judged on clone's branch.
    expect(runHook(session).code).toBe(2)
    git(clone, 'checkout', '-q', '-b', 'clean', 'origin/main')
    commit(clone, 'src/other.ts', 'export const b = 1\n', 'clean')
    expect(runHook(session, `cd ${clone} && git push origin clean`).code).toBe(0)
    expect(runHook(session, `cd ${clone} && git push origin feature`).err).toContain('src/app.ts')
  })

  test('honours `git -C <dir>` from a directory that is not a repository', () => {
    overlap()

    expect(runHook(dir, `git -C ${clone} push --force-with-lease`).code).toBe(2)
    expect(runHook(dir, `git -C ${join(dir, 'missing')} push`).code).toBe(0)
  })

  test('checks the branch the command pushes, not the one checked out', () => {
    overlap()
    git(clone, 'checkout', '-q', '-b', 'clean', 'origin/main')
    commit(clone, 'src/other.ts', 'export const b = 1\n', 'clean')

    expect(runHook(clone).code).toBe(0)
    expect(runHook(clone, 'git push origin clean').code).toBe(0)
    const { code, err } = runHook(clone, 'git push origin feature')
    expect(code).toBe(2)
    expect(err).toContain('(feature)')
    expect(runHook(clone, 'git push origin no-such-branch').code).toBe(0)
  })

  test('skips a command that only names the hook by path', () => {
    overlap()

    expect(runHook(clone, "sed -n '1,60p' scripts/git/push-overlap-hook.ts").code).toBe(0)
    expect(runHook(clone, 'git status').code).toBe(0)
  })

  test('leaves main itself alone', () => {
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    expect(runHook(clone).code).toBe(0)
  })
})
