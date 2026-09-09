import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { pushTargets } from './push-overlap-hook'

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

/** Runs the hook process in `cwd` on `command`, with the payload `cwd` the Bash tool would report. */
function runHook(cwd: string, command = 'git push', payloadCwd = cwd): { code: number; err: string } {
  const stdin = Buffer.from(JSON.stringify({ cwd: payloadCwd, tool_input: { command } }))
  const r = Bun.spawnSync(['bun', HOOK], { cwd, stdin })
  return { code: r.exitCode, err: r.stderr.toString() }
}

// Parser verdicts need no repository: they are string answers about where a push runs.
describe('pushTargets', () => {
  const cwd = '/work/session'

  test('a plain `git push` runs in the base cwd on HEAD', () => {
    expect(pushTargets('git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('git push -u origin HEAD', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('/usr/bin/git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })

  test('a leading cd moves the push, with `;` and `&&` alike', () => {
    expect(pushTargets('cd /other && git push origin b', cwd)).toEqual([{ cwd: '/other', ref: 'b' }])
    expect(pushTargets('cd /other; git push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
    expect(pushTargets('cd "/with space" && git push', cwd)).toEqual([{ cwd: '/with space', ref: 'HEAD' }])
    expect(pushTargets('cd sub && cd deeper && git push', cwd)).toEqual([{ cwd: '/work/session/sub/deeper', ref: 'HEAD' }])
    expect(pushTargets('cd -- /other && git push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
  })

  test('a cd inside a subshell ends with the subshell', () => {
    expect(pushTargets('(cd /other && git push origin b) | tail -1', cwd)).toEqual([{ cwd: '/other', ref: 'b' }])
    expect(pushTargets('(cd /tmp && bun run x) && git push origin b', cwd)).toEqual([{ cwd, ref: 'b' }])
  })

  test('`git -C <dir>` and `-c key=value` before the subcommand are read', () => {
    expect(pushTargets('git -C /other push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
    expect(pushTargets('git -C/other push', cwd)).toEqual([{ cwd: '/other', ref: 'HEAD' }])
    expect(pushTargets('git -C ../sibling -c url.https://x/.insteadOf=git@x: push origin b', cwd)).toEqual([
      { cwd: '/work/sibling', ref: 'b' },
    ])
  })

  test('every refspec names a local ref; a deletion pushes nothing', () => {
    expect(pushTargets('git push origin feature:main', cwd)).toEqual([{ cwd, ref: 'feature' }])
    expect(pushTargets('git push --force-with-lease origin +feature', cwd)).toEqual([{ cwd, ref: 'feature' }])
    expect(pushTargets('git push origin main feature', cwd)).toEqual([{ cwd, ref: 'main' }, { cwd, ref: 'feature' }])
    expect(pushTargets('git push origin :gone', cwd)).toEqual([])
    expect(pushTargets('git push --delete origin gone', cwd)).toEqual([])
    expect(pushTargets('git push origin $(git branch --show-current)', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('git push && git push --tags', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })

  test('a word merely containing git and push is not a push', () => {
    expect(pushTargets("sed -n '1,60p' scripts/git/push-overlap-hook.ts", cwd)).toEqual([])
    expect(pushTargets('bun test scripts/git/push-overlap-hook.test.ts', cwd)).toEqual([])
    expect(pushTargets('git log --oneline -- scripts/git/push-overlap-hook.ts', cwd)).toEqual([])
    expect(pushTargets('git grep -n push', cwd)).toEqual([])
    expect(pushTargets("echo 'git push'", cwd)).toEqual([])
    expect(pushTargets('git status', cwd)).toEqual([])
  })

  test('wrappers, control words and `bash -c` still reach the push', () => {
    expect(pushTargets('timeout 60 git push origin b', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('env GIT_SSH_COMMAND=ssh git push origin b', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('GIT_SSH_COMMAND="ssh -o ConnectTimeout=5" git push origin b 2>&1', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('if git push origin b; then echo ok; fi', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('for b in x y; do git push origin $b; done', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('bash -c "cd /other && git push origin b"', cwd)).toEqual([{ cwd: '/other', ref: 'b' }])
  })

  test('line continuations, heredocs and redirections do not shift the arguments', () => {
    expect(pushTargets('git push --force-with-lease \\\n  origin b', cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets("cat > n.md <<'EOF'\nDon't\nEOF\ngit push origin b", cwd)).toEqual([{ cwd, ref: 'b' }])
    expect(pushTargets('git commit -m "$(cat <<\'EOF\'\nfix: 5" display\nEOF\n)" && git push origin b', cwd)).toEqual([
      { cwd, ref: 'b' },
    ])
    expect(pushTargets('git push > /tmp/log 2>&1 && echo ok', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('git push &> /tmp/log origin b', cwd)).toEqual([{ cwd, ref: 'b' }])
  })

  test('a cd it cannot follow falls back to the base cwd', () => {
    expect(pushTargets('cd $NOT_SET_ANYWHERE && git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('cd - && git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
    expect(pushTargets('cd ~someone-else/repo && git push', cwd)).toEqual([{ cwd, ref: 'HEAD' }])
  })
})

// Driven as the hook actually runs, against real repositories: every verdict here is a git range answer.
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

  test('judges the worktree a `cd <dir> &&` push runs in, not the one the hook process runs in', () => {
    overlap()
    // The session worktree: a merged branch whose file main has since rewritten.
    const session = join(dir, 'session')
    git(clone, 'worktree', 'add', '-q', '-b', 'merged', session, 'origin/main')
    commit(session, 'docs/rfc.md', 'rfc\n', 'rfc')
    commit(origin, 'docs/rfc.md', 'rfc squash-merged\n', 'merge rfc')
    git(clone, 'checkout', '-q', '-b', 'clean', 'origin/main')
    commit(clone, 'src/other.ts', 'export const b = 1\n', 'clean')

    expect(runHook(session).code).toBe(2)
    expect(runHook(session, `cd ${clone} && git push origin clean`).code).toBe(0)
  })

  test('starts from the payload cwd, which follows the Bash tool across calls', () => {
    overlap()

    expect(runHook(dir, 'git push', clone).code).toBe(2)
    expect(runHook(clone, 'git push', dir).code).toBe(0)
  })

  test('honours `git -C <dir>`, and reports a directory git cannot run in', () => {
    overlap()

    expect(runHook(dir, `git -C ${clone} push --force-with-lease`).code).toBe(2)
    const missing = runHook(dir, `git -C ${join(dir, 'missing')} push`)
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('cannot run git')
  })

  test('checks the branches the command pushes, not the one checked out', () => {
    overlap()
    git(clone, 'checkout', '-q', '-b', 'clean', 'origin/main')
    commit(clone, 'src/other.ts', 'export const b = 1\n', 'clean')

    expect(runHook(clone).code).toBe(0)
    const { code, err } = runHook(clone, 'git push origin clean feature')
    expect(code).toBe(2)
    expect(err).toContain('(feature)')
    expect(runHook(clone, 'git push origin no-such-branch').code).toBe(0)
  })

  test('leaves main itself alone', () => {
    commit(clone, 'src/app.ts', 'export const a = 2\n', 'mine')
    commit(origin, 'src/app.ts', 'export const a = 3\n', 'theirs on main')

    expect(runHook(clone).code).toBe(0)
  })
})
