#!/usr/bin/env bun
// Claude Code PreToolUse hook: before `git push`, refuse a branch whose files
// main has since rewritten (.claude/rules/common-pitfalls.md, "Duplicate Work").
// It runs the fetch itself: a stale origin/main reports "0 behind" and fails
// open, and skipping the fetch is what the recorded rule never prevented.
// Every git call runs where the push will (the payload `cwd`, then `cd <dir>`
// and `git -C <dir>` in the command) and on the refs the command names, not in
// the hook process's cwd on HEAD: those describe the session's worktree, which
// a push from a sibling worktree never touches (the same defect class as #349).

import { homedir } from 'node:os'
import { resolve } from 'node:path'

type Result = { ok: boolean; out: string; err: string }

// spawnSync throws ENOENT (blaming `git`) on a missing cwd instead of failing the child.
const run = (cwd: string, ...args: string[]): Result => {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd })
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
  } catch (e) {
    return { ok: false, out: '', err: `cannot run git in ${cwd}: ${e instanceof Error ? e.message : String(e)}` }
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

/** A simple command's words, or a subshell boundary. */
type Item = string[] | '(' | ')'

/**
 * Shell words per simple command: `&&`, `||`, `|`, `;`, `&` and newlines end a
 * command; `(`/`)` are emitted so a `cd` inside a subshell can be scoped.
 * Quotes, backslashes, `$(...)` and backticks keep their span inside one word,
 * so `echo 'git push'` yields no `git` word. A heredoc body is skipped whole.
 */
function splitCommands(command: string): Item[] {
  const items: Item[] = []
  let words: string[] = []
  let word = ''
  let heredocs: string[] = []
  let tagPending = false
  const endWord = (): void => {
    if (word === '') return
    if (tagPending) {
      heredocs.push(word)
      tagPending = false
    } else if (/^<<-?$/.test(word)) tagPending = true
    else {
      const m = /^<<-?(.+)$/.exec(word)
      if (m && !word.startsWith('<<<')) heredocs.push(m[1]!)
    }
    words.push(word)
    word = ''
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) items.push(words)
    words = []
  }
  const s = command
  // Index just past the `)` matching the `(` at `open`.
  const substitutionEnd = (open: number): number => {
    let depth = 0
    for (let j = open; j < s.length; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')' && --depth === 0) return j + 1
    }
    return s.length
  }
  const skipHeredocBodies = (from: number): number => {
    let i = from
    for (const tag of heredocs) {
      while (i < s.length) {
        const nl = s.indexOf('\n', i)
        const end = nl === -1 ? s.length : nl
        const line = s.slice(i, end).replace(/^\t+/, '')
        i = end + 1
        if (line === tag) break
      }
    }
    heredocs = []
    return Math.min(i, s.length)
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === "'" || c === '`') {
      const close = s.indexOf(c, i + 1)
      const end = close === -1 ? s.length : close
      word += c === '`' ? s.slice(i, end + 1) : s.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '$' && s[j + 1] === '(') {
          const end = substitutionEnd(j + 1)
          word += s.slice(j, end)
          j = end
          continue
        }
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) j++
        word += s[j]
        j++
      }
      i = j + 1
    } else if (c === '\\' && s[i + 1] === '\n') {
      i += 2
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[i + 1]
      i += 2
    } else if (c === '$' && s[i + 1] === '(') {
      const end = substitutionEnd(i + 1)
      word += s.slice(i, end)
      i = end
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '\n') {
      endCommand()
      i = heredocs.length > 0 ? skipHeredocBodies(i + 1) : i + 1
    } else if (c === ';') {
      endCommand()
      i++
    } else if (c === '(' || c === ')') {
      endCommand()
      items.push(c)
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
        word += c
        i++
      } else {
        endCommand()
        i++
      }
    } else {
      word += c
      i++
    }
  }
  endCommand()
  return items
}

/** Drops `>log`, `2>&1`, `<<EOF`, and a bare `>` / `&>` together with the file word after it. */
function withoutRedirections(words: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (/^(\d*[<>]{1,2}|&>>?)$/.test(w)) i++
    else if (!/^(\d*[<>]|&>)/.test(w)) kept.push(w)
  }
  return kept
}

// A word the shell computes at run time; the hook cannot know its value.
const DYNAMIC = /[$`(]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Words that precede the command they run without changing its directory.
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '{', '!', 'command', 'exec'])
// Wrappers whose own arguments sit between them and the command.
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'timeout', 'env', 'sudo', 'xargs'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
// Global git options that take a separate value; `--opt=value` carries its own.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option'])

/** `~`, `~<me>` and `$VAR` expanded; undefined when the path cannot be known statically. */
function resolvePath(base: string, raw: string): string | undefined {
  const expanded = raw
    .replace(/^~([^/]*)(?=\/|$)/, (m, user: string) => (user === '' || user === process.env.USER ? homedir() : m))
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => process.env[name] ?? m)
  if (expanded.startsWith('~') || DYNAMIC.test(expanded)) return undefined
  return resolve(base, expanded)
}

/** The directory `cd <args>` lands in; undefined when it cannot be known statically. */
function cdTarget(args: string[], cwd: string): string | undefined {
  const arg = args.find((w) => w !== '--' && !/^-[LPe@]+$/.test(w))
  if (arg === undefined) return homedir()
  if (arg === '-') return undefined
  return resolvePath(cwd, arg)
}

const isGit = (w: string): boolean => w === 'git' || w.endsWith('/git')

/** The local side of a refspec, or undefined for a deletion (`:remote`). */
function localRef(refspec: string): string | undefined {
  if (DYNAMIC.test(refspec)) return 'HEAD'
  const src = refspec.replace(/^\+/, '').split(':')[0]!
  return src === '' ? undefined : src
}

/** The pushes a `git push` command performs from `cwd`; empty for any other command. */
function pushesIn(words: string[], cwd: string): PushTarget[] {
  let i = 0
  if (!isGit(words[0]!)) {
    if (!WRAPPERS.has(words[0]!) && !ASSIGNMENT.test(words[0]!)) return []
    i = words.findIndex(isGit)
    if (i === -1) return []
  }
  let dir = cwd
  for (i++; i < words.length && words[i]!.startsWith('-'); i++) {
    const w = words[i]!
    if (/^-C.+/.test(w)) dir = resolvePath(dir, w.slice(2)) ?? dir
    else if (GIT_VALUE_OPTIONS.has(w)) {
      const value = words[++i]
      if (w === '-C' && value !== undefined) dir = resolvePath(dir, value) ?? dir
    }
  }
  if (words[i] !== 'push') return []
  const positional: string[] = []
  for (i++; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') {
      positional.push(...words.slice(i + 1))
      break
    }
    if (w === '-d' || w === '--delete') return []
    if (w.startsWith('-')) {
      if (PUSH_VALUE_OPTIONS.has(w)) i++
      continue
    }
    positional.push(w)
  }
  const refs = positional.length > 1 ? positional.slice(1).map(localRef) : ['HEAD']
  return refs.flatMap((ref) => (ref === undefined ? [] : [{ cwd: dir, ref }]))
}

/**
 * Every push a command line performs, each with the directory it runs in.
 * A `cd` that cannot be followed statically (`cd -`, an unset variable) falls
 * back to `baseCwd`: a wrong check is visible, a skipped one is not.
 */
export function pushTargets(command: string, baseCwd: string): PushTarget[] {
  const targets: PushTarget[] = []
  const scopes: string[] = []
  let cwd = baseCwd
  for (const item of splitCommands(command)) {
    if (item === '(') {
      scopes.push(cwd)
      continue
    }
    if (item === ')') {
      cwd = scopes.pop() ?? cwd
      continue
    }
    const words = withoutRedirections(item)
    while (words.length > 0 && CONTROL.has(words[0]!)) words.shift()
    if (words.length === 0) continue
    if (words[0] === 'cd') {
      cwd = cdTarget(words.slice(1), cwd) ?? baseCwd
      continue
    }
    if (SHELLS.has(words[0]!)) {
      const script = words[words.indexOf('-c') + 1]
      if (words.includes('-c') && script !== undefined) targets.push(...pushTargets(script, cwd))
      continue
    }
    targets.push(...pushesIn(words, cwd))
  }
  return targets.filter((t, i) => targets.findIndex((u) => u.cwd === t.cwd && u.ref === t.ref) === i)
}

/**
 * The message to block a push with, or undefined when there is nothing to say.
 * `fetched` memoises the origin/main fetch per directory across one command's pushes.
 */
export function checkOverlap({ cwd, ref }: PushTarget, fetched = new Set<string>()): string | undefined {
  const branch = run(cwd, 'rev-parse', '--abbrev-ref', ref)
  if (!branch.ok && branch.err.startsWith('cannot run git')) {
    return `${branch.err}, so this push is unchecked for work main already carries.`
  }
  if (!branch.ok || branch.out === 'HEAD' || branch.out === 'main') return undefined
  // Without this, a repo with no origin would fail the fetch and block wrongly.
  if (!run(cwd, 'remote', 'get-url', 'origin').ok) return undefined

  if (!fetched.has(cwd)) {
    const fetch = run(cwd, 'fetch', '-q', 'origin', 'main')
    if (!fetch.ok) {
      const why = fetch.err === '' ? 'no output' : fetch.err
      return [
        `Could not fetch origin/main (${why}), so this push is unchecked for work main`,
        'already carries. Re-run after fetching, or push knowing it was not checked.',
      ].join(' ')
    }
    fetched.add(cwd)
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

// `import.meta.main` so a test can import `pushTargets` without this firing.
if (import.meta.main) {
  let payload: { cwd?: string; tool_input?: { command?: string } }
  try {
    payload = JSON.parse(await Bun.stdin.text()) as typeof payload
  } catch {
    process.exit(0)
  }
  const command = payload.tool_input?.command
  if (command === undefined) process.exit(0)

  // The payload `cwd` follows the Bash tool's `cd` across calls; the hook process's does not.
  const fetched = new Set<string>()
  for (const target of pushTargets(command, payload.cwd ?? process.cwd())) {
    const message = checkOverlap(target, fetched)
    if (message === undefined) continue
    console.error(message)
    process.exit(2)
  }
  process.exit(0)
}
