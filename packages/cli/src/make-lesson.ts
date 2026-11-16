/**
 * `guren make:lesson` (RFC 0040 §11): a numbered lesson under `docs/lessons/`, one rule line in
 * its frontmatter. It starts `draft`, which reaches nobody; a person merging it as `stable` is
 * the acceptance, and only then does `guren context` print its rule.
 */
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'

import { safeModuleName, assertCwdUnsupported, slugifyProse, writeScaffoldFile, type WriterOptions } from './utils'
import { runGit } from './changed-files'
import { LESSON_RULE_LIMIT } from './docs-index'
import { enforcedByProblem } from './lesson-enforced'
import { reproduceLesson, type Reproduced } from './lesson-reproduce'
import { nextSequenceNumber, resolveActor, resolveAdrPrefill, type AdrPrefill } from './make-adr'

const LESSON_DIR = 'docs/lessons'

/** Where a lesson came from (§11's triggers). */
export const LESSON_SOURCE_KINDS = ['review-finding', 'escaped-defect', 'revert', 'stall', 'waiver', 'declined-finding'] as const
export type LessonSourceKind = (typeof LESSON_SOURCE_KINDS)[number]

/** How long a lesson stands before `check --docs` asks whether it still applies. */
const REVIEW_AFTER_MONTHS = 6

export interface MakeLessonOptions extends WriterOptions {
  entity?: string
  /** The rule line; the title when absent. */
  rule?: string
  /** Globs a cross-cutting lesson governs. */
  paths?: string[]
  /** A commit SHA or a pull request number (`412`, `#412`). */
  from?: string
  kind?: LessonSourceKind
  /** `<file>#<name>`: the check that catches the failure. */
  enforcedBy?: string
  /** `false` records `reproduced: not-run` without running the check. */
  reproduce?: boolean
  /** Told before the check runs, since it runs the application's tests twice. */
  onReproduce?: (enforcedBy: string, commit: string) => void
  by?: string
}

// Written into double-quoted YAML scalars, so only what breaks one is refused.
const QUOTABLE = /^[^"\\\r\n]+$/u

function quoted(value: string, what: string): string {
  if (!QUOTABLE.test(value)) throw new Error(`Invalid ${what} "${value}": it is written into a quoted YAML scalar, so it cannot contain quotes, backslashes or newlines.`)
  return `"${value}"`
}

type Source = { line: string; commit?: string }

async function sourceOf(from: string, kind: LessonSourceKind | undefined): Promise<Source> {
  const value = from.trim()
  const pr = (number: string): Source => ({ line: `{ pr: ${number}, kind: ${kind ?? 'review-finding'} }` })
  if (/^#\d+$/u.test(value)) return pr(value.slice(1))
  const [sha] = (await runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', `${value}^{commit}`])) ?? []
  // Bare digits can name a pull request or a commit abbreviation; git decides, and `#412` says which.
  if (/^\d+$/u.test(value)) {
    if (!sha) return pr(value)
    if (value.length < 7) throw new Error(`--from ${value} is both a pull request number and a commit abbreviation here: write #${value} for the pull request, or the commit's full SHA.`)
  }
  if (!sha) throw new Error(`--from ${from} is neither a pull request number nor a commit in this repository.`)
  const [subject] = (await runGit(process.cwd(), ['log', '-1', '--format=%s', sha])) ?? []
  return { line: `{ commit: ${sha.slice(0, 12)}, kind: ${kind ?? (subject?.startsWith('Revert ') ? 'revert' : 'escaped-defect')} }`, commit: sha }
}

/** A reason goes into a quoted scalar, so what would break one is replaced rather than refused. */
const scalar = (text: string): string => text.replace(/["\\]/gu, "'").replace(/[\r\n]+/gu, ' ')

/** Six months on, clamped to the last day of that month: Aug 31 gives Feb 28, not Mar 3. */
function reviewDate(now: Date): string {
  const month = now.getUTCMonth() + REVIEW_AFTER_MONTHS
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(now.getUTCFullYear(), month, Math.min(now.getUTCDate(), lastDay))).toISOString().slice(0, 10)
}

interface Enforcement {
  enforcedBy: string
  reproduced: Reproduced
}

function lessonTemplate(title: string, rule: string, prefill: AdrPrefill, paths: string[], source: string | undefined, enforcement: Enforcement | undefined, actor: string | null, now: Date): string {
  const lines = [
    '---',
    'type: lesson',
    'status: draft',
    `rule: ${quoted(rule, 'rule')}`,
    `entities: [${prefill.entities.join(', ')}]`,
    `paths: [${paths.map((path) => quoted(path, 'path')).join(', ')}]`,
    ...(prefill.related.length > 0 ? [`related:`, ...prefill.related.map((path) => `  - ${path}`)] : []),
    ...(source ? [`source: ${source}`] : []),
    ...(enforcement ? [
      `enforcedBy: ${quoted(enforcement.enforcedBy, 'enforcedBy')}`,
      `reproduced: ${enforcement.reproduced.value}`,
      `reproducedBecause: "${scalar(enforcement.reproduced.because)}"`,
    ] : []),
    `review: ${reviewDate(now)}`,
    ...(actor === null ? [] : [`generated: { by: "${actor}", at: ${now.toISOString()} }`]),
    '---',
    '',
    `# ${title}`,
    '',
    '<!-- What went wrong, where, and why the rule above keeps it from happening again. -->',
    '',
    ...(enforcement ? [] : ['<!-- If a check can catch it (a guren.arch.ts rule, a lint rule, a test), name it in enforcedBy: as <file>#<name>. -->', '']),
  ]
  return lines.join('\n')
}

export async function makeLesson(title: string, options: MakeLessonOptions = {}): Promise<string> {
  assertCwdUnsupported(options, 'make:lesson')
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const dir = moduleName ? `modules/${moduleName}/${LESSON_DIR}` : LESSON_DIR
  const rule = (options.rule ?? title).trim()
  if (rule.length === 0 || rule.length > LESSON_RULE_LIMIT) throw new Error(`The rule is ${rule.length} characters; a lesson's rule is one line of 1 to ${LESSON_RULE_LIMIT}.`)
  quoted(rule, 'rule')
  const paths = (options.paths ?? []).map((path) => path.trim()).filter((path) => path.length > 0)
  for (const path of paths) quoted(path, 'path')
  if (options.kind && !LESSON_SOURCE_KINDS.includes(options.kind)) throw new Error(`--kind is one of ${LESSON_SOURCE_KINDS.join(', ')}.`)
  if (options.kind && !options.from) throw new Error('--kind says what --from came from, and needs it.')
  const enforcedBy = options.enforcedBy?.trim()
  if (enforcedBy !== undefined) {
    quoted(enforcedBy, 'enforcedBy')
    const problem = await enforcedByProblem(enforcedBy, (file) =>
      posix.isAbsolute(file) || file.split('/').includes('..') ? Promise.resolve(undefined) : readFile(file, 'utf8').catch(() => undefined))
    if (problem) throw new Error(problem)
  }
  const [prefill, actor, source] = await Promise.all([
    options.entity ? resolveAdrPrefill(options.entity, moduleName, LESSON_DIR) : { entities: [], related: [] },
    resolveActor(options.by),
    options.from ? sourceOf(options.from, options.kind) : undefined,
  ])
  let enforcement: Enforcement | undefined
  if (enforcedBy !== undefined) {
    const commit = source?.commit
    let reproduced: Reproduced
    if (options.reproduce === false) reproduced = { value: 'not-run', because: 'make:lesson ran with --no-reproduce' }
    else if (!commit) reproduced = { value: 'not-run', because: options.from ? `--from ${options.from} names a pull request, whose commits this does not read` : 'no --from names the commit that removed the defect' }
    else {
      options.onReproduce?.(enforcedBy, commit)
      reproduced = await reproduceLesson(process.cwd(), commit, enforcedBy)
    }
    enforcement = { enforcedBy, reproduced }
  }
  const sequence = await nextSequenceNumber(dir)
  return writeScaffoldFile(`${dir}/${sequence}-${slugifyProse(title, '-', 'lesson')}.md`, lessonTemplate(title.trim(), rule, prefill, paths, source?.line, enforcement, actor, new Date()), options)
}
