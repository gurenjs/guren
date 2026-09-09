#!/usr/bin/env bun
// Claude Code PreToolUse hook: before `git push`, refuse a branch whose files
// main has since rewritten (.claude/rules/common-pitfalls.md, "Duplicate Work").
// It runs the fetch itself: a stale origin/main reports "0 behind" and fails
// open, and skipping the fetch is what the recorded rule never prevented.
// Every git call runs where the push will (`cd <dir> &&`, `git -C <dir>`) and on
// the ref the command names, not the hook's cwd and HEAD: those describe the
// session's worktree, which a push from a sibling worktree never touches (#349).

import { homedir } from 'node:os'
import { resolve } from 'node:path'

type Result = { ok: boolean; out: string; err: string }

const run = (cwd: string, ...args: string[]): Result => {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd })
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
  } catch (e) {
    // The shell's own `cd` fails on a missing directory, so no push follows.
    return { ok: false, out: '', err: String(e) }
  }
}

/**
 * A `.changeset` or CHANGELOG collision is what every concurrent PR has.
 * `packages/*` manifests stay signal even though a release rewrites every one:
 * a block costs one read, a miss costs a duplicated PR.
 */
const noise = (f: string): boolean => f.startsWith('.changeset/') || f.endsWith('CHANGELOG.md')

const indent = (text: string): string => text.split('\n').map((line) => `  ${line}`).join('\n')

/** Where a push runs and which local ref it sends; `HEAD` when the command names none. */
export type PushTarget = { cwd: string; ref: string }

/**
 * Shell words per simple command: `&&`, `||`, `|`, `;`, `&`, newlines and bare
 * parentheses end a command. Quotes, backslashes and `$(...)` keep their span
 * inside one word, so `echo 'git push'` yields no `git` word.
 */
export function splitCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let started = false
  const endWord = (): void => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  const take = (text: string): void => {
    word += text
    started = true
  }
  const s = command
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === "'" || c === '`') {
      const close = s.indexOf(c, i + 1)
      const end = close === -1 ? s.length : close
      take(c === '`' ? s.slice(i, end + 1) : s.slice(i + 1, end))
      i = end + 1
    } else if (c === '"') {
      let j = i + 1
      let inner = ''
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) j++
        inner += s[j]
        j++
      }
      take(inner)
      i = j + 1
    } else if (c === '\\' && i + 1 < s.length) {
      take(s[i + 1]!)
      i += 2
    } else if (c === '$' && s[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')' && --depth === 0) break
      }
      take(s.slice(i, j + 1))
      i = j + 1
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      endCommand()
      i++
    } else if (c === '|') {
      endCommand()
      i += s[i + 1] === '|' ? 2 : 1
    } else if (c === '&') {
      if (s[i + 1] === '&') {
        endCommand()
        i += 2
      } else if (s[i + 1] === '>' || word.endsWith('>') || word.endsWith('<')) {
        // `2>&1`, `>&2` and `&>log` are redirections, not the background operator.
        take(c)
        i++
      } else {
        endCommand()
        i++
      }
    } else {
      take(c)
      i++
    }
  }
  endCommand()
  return commands
}

/** Drops `>log`, `2>&1`, and a bare `>` together with the file word after it. */
function withoutRedirections(words: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (/^\d*[<>]{1,2}$/.test(w)) i++
    else if (!/^(\d*[<>]|&>)/.test(w)) kept.push(w)
  }
  return kept
}

/** `~` and `$VAR` expanded; undefined when the path cannot be known statically. */
function resolvePath(base: string, raw: string): string | undefined {
  const expanded = raw
    .replace(/^~(?=\/|$)/, homedir())
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => process.env[name] ?? m)
  if (/[$`(]/.test(expanded)) return undefined
  return resolve(base, expanded)
}

/** The directory a `cd` command lands in; null when it is not a cd, undefined when unknowable. */
function cdTarget(words: string[], cwd: string): string | null | undefined {
  if (words[0] !== 'cd') return null
  const arg = words.slice(1).find((w) => !/^-[LPe@]+$/.test(w))
  if (arg === undefined) return homedir()
  if (arg === '-') return undefined
  return resolvePath(cwd, arg)
}

// Global git options that take a separate value; `--opt=value` carries its own.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option'])

/** The local side of a refspec, or undefined for a deletion (`:remote`). */
function localRef(refspec: string | undefined): string | undefined {
  if (refspec === undefined) return 'HEAD'
  // A refspec the shell computes at run time cannot be read here.
  if (/[$`(]/.test(refspec)) return 'HEAD'
  const src = refspec.replace(/^\+/, '').split(':')[0]!
  return src === '' ? undefined : src
}

/** The push a simple command performs from `cwd`, if it is a `git push`. */
function pushIn(rawWords: string[], cwd: string): PushTarget | undefined {
  const words = withoutRedirections(rawWords)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
  if (words[i] !== 'git') return undefined
  let dir = cwd
  for (i++; i < words.length && words[i]!.startsWith('-'); i++) {
    const w = words[i]!
    if (!GIT_VALUE_OPTIONS.has(w)) continue
    const value = words[++i]
    if (w === '-C' && value !== undefined) dir = resolvePath(dir, value) ?? dir
  }
  if (words[i] !== 'push') return undefined
  const positional: string[] = []
  for (i++; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') {
      positional.push(...words.slice(i + 1))
      break
    }
    if (w === '-d' || w === '--delete') return undefined
    if (w.startsWith('-')) {
      if (PUSH_VALUE_OPTIONS.has(w)) i++
      continue
    }
    positional.push(w)
  }
  const ref = localRef(positional[1])
  return ref === undefined ? undefined : { cwd: dir, ref }
}

/**
 * Every push a command line performs, each with the directory it runs in.
 * A `cd` that cannot be followed statically (`cd -`, an unset variable) falls
 * back to `hookCwd`: a wrong check is visible, a skipped one is not.
 */
export function pushTargets(command: string, hookCwd: string): PushTarget[] {
  const targets: PushTarget[] = []
  let cwd = hookCwd
  for (const words of splitCommands(command)) {
    const moved = cdTarget(words, cwd)
    if (moved !== null) {
      cwd = moved ?? hookCwd
      continue
    }
    const push = pushIn(words, cwd)
    if (push !== undefined) targets.push(push)
  }
  return targets
}

/** The message to block a push with, or undefined when there is nothing to say. */
export function checkOverlap({ cwd, ref }: PushTarget = { cwd: process.cwd(), ref: 'HEAD' }): string | undefined {
  const branch = run(cwd, 'rev-parse', '--abbrev-ref', ref)
  if (!branch.ok || branch.out === 'HEAD' || branch.out === 'main') return undefined
  // Without this, a repo with no origin would fail the fetch and block wrongly.
  if (!run(cwd, 'remote', 'get-url', 'origin').ok) return undefined

  const fetched = run(cwd, 'fetch', '-q', 'origin', 'main')
  if (!fetched.ok) {
    const why = fetched.err === '' ? 'no output' : fetched.err
    return [
      `Could not fetch origin/main (${why}), so this push is unchecked for work main`,
      'already carries. Re-run after fetching, or push knowing it was not checked.',
    ].join(' ')
  }

  const base = run(cwd, 'merge-base', ref, 'origin/main')
  if (!base.ok || base.out === '') return undefined

  const filesOn = (range: string): string[] => {
    const r = run(cwd, 'diff', '--name-only', range)
    return r.ok && r.out !== '' ? r.out.split('\n') : []
  }
  const mine = new Set(filesOn(`${base.out}..${ref}`))
  const signal = filesOn(`${base.out}..origin/main`).filter((f) => mine.has(f) && !noise(f))
  if (signal.length === 0) return undefined

  const commits = run(cwd, 'log', '--oneline', `${base.out}..origin/main`, '--', ...signal)
  return [
    `origin/main has rewritten ${signal.length} file(s) this branch (${branch.out}) also changes:`,
    indent(signal.join('\n')),
    '',
    'Those files were touched by:',
    indent(commits.out),
    '',
    'Read those commits before pushing. If they already did this work, do not rebase past',
    'it: reduce the branch to what they did not do, or close it. Push again once you have.',
  ].join('\n')
}

// `import.meta.main` so a test can import the parser and `checkOverlap` without this firing.
if (import.meta.main) {
  let command: string | undefined
  try {
    command = (JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: string } }).tool_input?.command
  } catch {
    process.exit(0)
  }
  if (command === undefined) process.exit(0)

  for (const target of pushTargets(command, process.cwd())) {
    const message = checkOverlap(target)
    if (message === undefined) continue
    console.error(message)
    process.exit(2)
  }
  process.exit(0)
}
