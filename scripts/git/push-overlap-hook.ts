#!/usr/bin/env bun
// Claude Code PreToolUse hook: before `git push`, refuse a branch whose files
// main has since rewritten. Six PRs (#409 #445 #598 #604 #622 #662) duplicated
// work already merged; the recorded rule ("re-fetch before pushing") did not
// fire, so this runs the fetch itself rather than trusting a stale
// origin/main — a ref nobody refreshed reports "0 behind" and fails open.
import { spawnSync } from 'node:child_process'

const run = (...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

let command: string | undefined
try {
  command = (JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: string } }).tool_input?.command
} catch {
  process.exit(0)
}
// `git push` anywhere in the command line, including inside a && chain.
if (!command || !/\bgit\s+(-[^\s]+\s+)*push\b/.test(command)) process.exit(0)

if (!run('rev-parse', '--is-inside-work-tree').ok) process.exit(0)
const branch = run('rev-parse', '--abbrev-ref', 'HEAD')
if (!branch.ok || branch.out === 'HEAD' || branch.out === 'main') process.exit(0)
if (!run('remote', 'get-url', 'origin').ok) process.exit(0)

if (!run('fetch', '-q', 'origin', 'main').ok) {
  console.error('Could not fetch origin/main, so this push is unchecked for work main already carries. Re-run after fetching, or push knowing it was not checked.')
  process.exit(2)
}

const base = run('merge-base', 'HEAD', 'origin/main')
if (!base.ok || base.out === '') process.exit(0)

const behind = run('rev-list', '--count', `${base.out}..origin/main`)
if (behind.out === '0') process.exit(0)

const filesOn = (range: string): string[] => {
  const r = run('diff', '--name-only', range)
  return r.ok && r.out !== '' ? r.out.split('\n') : []
}
const mine = new Set(filesOn(`${base.out}..HEAD`))
const overlap = filesOn(`${base.out}..origin/main`).filter((f) => mine.has(f))

// A concurrent PR almost always collides here and it means nothing.
const noise = (f: string): boolean => f.startsWith('.changeset/') || f.endsWith('CHANGELOG.md')
const signal = overlap.filter((f) => !noise(f))

if (signal.length === 0) {
  console.error(`Note: origin/main is ${behind.out} commits ahead; none of them touch this branch's files.`)
  process.exit(0)
}

const commits = run('log', '--oneline', `${base.out}..origin/main`, '--', ...signal)
console.error(
  `origin/main has rewritten ${signal.length} file(s) this branch also changes:\n`
  + signal.map((f) => `  ${f}`).join('\n')
  + `\n\nThose files were touched by:\n${commits.out.split('\n').map((l) => `  ${l}`).join('\n')}\n\n`
  + 'Read those commits before pushing. If they already did this work, do not rebase past it — '
  + 'reduce the branch to what they did not do, or close it. Push again once you have.',
)
process.exit(2)
