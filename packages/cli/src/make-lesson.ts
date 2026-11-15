/**
 * `guren make:lesson` (RFC 0040 §11): a numbered lesson under `docs/lessons/`, one rule line in
 * its frontmatter. It starts `draft`, which reaches nobody; a person merging it as `stable` is
 * the acceptance, and only then does `guren context` print its rule.
 */
import { safeModuleName, assertCwdUnsupported, slugifyProse, writeScaffoldFile, type WriterOptions } from './utils'
import { runGit } from './changed-files'
import { LESSON_RULE_LIMIT } from './docs-index'
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
  by?: string
}

// Written into double-quoted YAML scalars, so only what breaks one is refused.
const QUOTABLE = /^[^"\\\r\n]+$/u

function quoted(value: string, what: string): string {
  if (!QUOTABLE.test(value)) throw new Error(`Invalid ${what} "${value}": it is written into a quoted YAML scalar, so it cannot contain quotes, backslashes or newlines.`)
  return `"${value}"`
}

async function sourceOf(from: string, kind: LessonSourceKind | undefined): Promise<string> {
  const pr = /^#?(\d+)$/u.exec(from.trim())
  if (pr) return `{ pr: ${pr[1]}, kind: ${kind ?? 'review-finding'} }`
  const [sha] = (await runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', `${from.trim()}^{commit}`])) ?? []
  if (!sha) throw new Error(`--from ${from} is neither a pull request number nor a commit in this repository.`)
  const [subject] = (await runGit(process.cwd(), ['log', '-1', '--format=%s', sha])) ?? []
  return `{ commit: ${sha.slice(0, 12)}, kind: ${kind ?? (subject?.startsWith('Revert ') ? 'revert' : 'escaped-defect')} }`
}

function reviewDate(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + REVIEW_AFTER_MONTHS, now.getUTCDate()))
  return date.toISOString().slice(0, 10)
}

function lessonTemplate(title: string, rule: string, prefill: AdrPrefill, paths: string[], source: string | undefined, actor: string | null, now: Date): string {
  const lines = [
    '---',
    'type: lesson',
    'status: draft',
    `rule: ${quoted(rule, 'rule')}`,
    `entities: [${prefill.entities.join(', ')}]`,
    `paths: [${paths.map((path) => quoted(path, 'path')).join(', ')}]`,
    ...(prefill.related.length > 0 ? [`related:`, ...prefill.related.map((path) => `  - ${path}`)] : []),
    ...(source ? [`source: ${source}`] : []),
    `review: ${reviewDate(now)}`,
    ...(actor === null ? [] : [`generated: { by: "${actor}", at: ${now.toISOString()} }`]),
    '---',
    '',
    `# ${title}`,
    '',
    '<!-- What went wrong, where, and why the rule above keeps it from happening again. -->',
    '',
    '<!-- If a check can catch it (a guren.arch.ts rule, a lint rule, a test), name it in enforcedBy: as <file>#<name>. -->',
    '',
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
  const [prefill, actor, source] = await Promise.all([
    options.entity ? resolveAdrPrefill(options.entity, moduleName) : { entities: [], related: [] },
    resolveActor(options.by),
    options.from ? sourceOf(options.from, options.kind) : undefined,
  ])
  const sequence = await nextSequenceNumber(dir)
  return writeScaffoldFile(`${dir}/${sequence}-${slugifyProse(title, '-', 'lesson')}.md`, lessonTemplate(title.trim(), rule, prefill, paths, source, actor, new Date()), options)
}
