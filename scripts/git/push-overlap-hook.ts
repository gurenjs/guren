#!/usr/bin/env bun
// Claude Code PreToolUse hook: before `git push`, refuse a branch whose files
// main has since rewritten (.claude/rules/common-pitfalls.md, "Duplicate Work").
// It runs the fetch itself: a stale origin/main reports "0 behind" and fails
// open, and skipping the fetch is what the recorded rule never prevented.
// `checkOverlap` is split out so a `.githooks/pre-push` can wrap the decision.

const run = (...args: string[]): { ok: boolean; out: string; err: string } => {
  const r = Bun.spawnSync(['git', ...args])
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

/**
 * A `.changeset` or CHANGELOG collision is what every concurrent PR has.
 * `packages/*` manifests stay signal even though a release rewrites every one:
 * a block costs one read, a miss costs a duplicated PR.
 */
const noise = (f: string): boolean => f.startsWith('.changeset/') || f.endsWith('CHANGELOG.md')

const indent = (text: string): string => text.split('\n').map((line) => `  ${line}`).join('\n')

/** The message to block a push with, or undefined when there is nothing to say. */
export function checkOverlap(): string | undefined {
  const branch = run('rev-parse', '--abbrev-ref', 'HEAD')
  if (!branch.ok || branch.out === 'HEAD' || branch.out === 'main') return undefined
  // Without this, a repo with no origin would fail the fetch and block wrongly.
  if (!run('remote', 'get-url', 'origin').ok) return undefined

  const fetched = run('fetch', '-q', 'origin', 'main')
  if (!fetched.ok) {
    const why = fetched.err === '' ? 'no output' : fetched.err
    return [
      `Could not fetch origin/main (${why}), so this push is unchecked for work main`,
      'already carries. Re-run after fetching, or push knowing it was not checked.',
    ].join(' ')
  }

  const base = run('merge-base', 'HEAD', 'origin/main')
  if (!base.ok || base.out === '') return undefined

  const filesOn = (range: string): string[] => {
    const r = run('diff', '--name-only', range)
    return r.ok && r.out !== '' ? r.out.split('\n') : []
  }
  const mine = new Set(filesOn(`${base.out}..HEAD`))
  const signal = filesOn(`${base.out}..origin/main`).filter((f) => mine.has(f) && !noise(f))
  if (signal.length === 0) return undefined

  const commits = run('log', '--oneline', `${base.out}..origin/main`, '--', ...signal)
  return [
    `origin/main has rewritten ${signal.length} file(s) this branch also changes:`,
    indent(signal.join('\n')),
    '',
    'Those files were touched by:',
    indent(commits.out),
    '',
    'Read those commits before pushing. If they already did this work, do not rebase past',
    'it: reduce the branch to what they did not do, or close it. Push again once you have.',
  ].join('\n')
}

// `import.meta.main` so a test can import `checkOverlap` without this firing.
// The match is permissive on purpose: a missed `git push` silently disables the
// hook, while a false match costs one fetch and exits 0. `[^&|;]*` keeps it
// inside a single command of a chain.
if (import.meta.main) {
  let command: string | undefined
  try {
    command = (JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: string } }).tool_input?.command
  } catch {
    process.exit(0)
  }
  if (command === undefined || !/\bgit\b[^&|;]*\bpush\b/.test(command)) process.exit(0)

  const message = checkOverlap()
  if (message === undefined) process.exit(0)
  console.error(message)
  process.exit(2)
}
