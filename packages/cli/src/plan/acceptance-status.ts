/**
 * Acceptance-behaviour status from a `bun test --reporter=junit` report (RFC 0030 §6).
 * Pure: `plan:verify` runs the tests and hands over the report text.
 * Bun nests one `<testsuite>` per `describe`, so a full title is the chain of suite
 * names; `classname` is not read, since Bun writes it innermost-first with a
 * double-escaped separator. A file that fails to load and a test behind a failing
 * `beforeAll` are absent from the report, which reads as `pending`, never as passing.
 */

import { ID_PATTERN, type Plan } from './schema'
import { XmlSubsetError, parseXmlSubset, type XmlElement } from './xml-subset'

/** UTF-16 units. A report holds a line per test and no output, so this is a wrong file, not a big suite. */
export const JUNIT_MAX_CHARS = 32 * 1024 * 1024
export const JUNIT_MAX_ATTRIBUTE_CHARS = 1024 * 1024
export const JUNIT_MAX_DEPTH = 64

// A bracketed token no behaviour declares is an error only under this prefix: `[GET]` is not a mistyped id.
const ACCEPTANCE_ID_PREFIX = 'AC-'

/** A token comes from a test title, which no plan rule bounds, and an error's id is shown to a reader. */
const MAX_REPORTED_ID_CHARS = 256

/** A failure of the junit vocabulary, as against one the XML reader raises; both reach the caller as `blocked`. */
class JunitReportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JunitReportError'
  }
}

export type AcceptanceStatus = 'pending' | 'failing' | 'passing'
export type AcceptanceCaseOutcome = 'passed' | 'failed' | 'skipped'

export interface AcceptanceCase {
  /** `describe` names outermost first, then the test's own, joined by ` > `. */
  title: string
  /** As Bun wrote it: relative to the directory `bun test` ran in, or absolute if the path given was. */
  file: string
  outcome: AcceptanceCaseOutcome
}

export interface AcceptanceBehaviourStatus {
  id: string
  status: AcceptanceStatus
  cases: AcceptanceCase[]
}

export type AcceptanceError =
  | { kind: 'id-in-several-files'; id: string; files: string[] }
  /** One per id and file; `title` is the first case that carried it. `id` is cut short past 256 characters. */
  | { kind: 'undeclared-id'; id: string; file: string; title: string }

/**
 * Only `judged` carries verdicts. `invalid` keeps what was seen under another name,
 * for showing beside the errors: a status in `observed` verifies nothing.
 */
export type AcceptanceReport =
  | { state: 'blocked'; reason: string }
  | { state: 'invalid'; errors: AcceptanceError[]; observed: AcceptanceBehaviourStatus[] }
  | { state: 'judged'; behaviours: AcceptanceBehaviourStatus[] }

/** Distinct, in the order the tasks declare them: an id under two tasks is `validate`'s to report, not a second behaviour. */
export function planAcceptanceIds(plan: Pick<Plan, 'tasks'>): string[] {
  return [...new Set(plan.tasks.flatMap((task) => task.acceptance.map((behaviour) => behaviour.id)))]
}

/**
 * `junit` is the report's text, or `undefined` when no report was written. A case
 * naming two declared ids counts for both. "Executed" is "carries no `<skipped>`":
 * Bun writes `time="0"` for fast passing cases too, and marks a case filtered out
 * by `-t` as skipped, so a filtered run reads as failing.
 */
export function acceptanceStatus(junit: string | undefined, declaredIds: readonly string[]): AcceptanceReport {
  if (junit === undefined) return { state: 'blocked', reason: 'no junit report was written' }

  let cases: JunitCase[]
  try {
    cases = readJunitCases(junit)
  } catch (error) {
    if (error instanceof XmlSubsetError || error instanceof JunitReportError) {
      return { state: 'blocked', reason: error.message }
    }
    throw error
  }

  const declared = new Set(declaredIds)
  const casesById = new Map<string, AcceptanceCase[]>()
  const undeclared = new Map<string, AcceptanceError>()

  for (const junitCase of cases) {
    let title: string | undefined
    for (const token of junitCase.tokens) {
      const isDeclared = declared.has(token)
      if (!isDeclared && !(token.startsWith(ACCEPTANCE_ID_PREFIX) && ID_PATTERN.test(token))) continue

      title ??= junitCase.title()
      if (isDeclared) {
        // A behaviour's own object, since `cases` reaches a caller and every field is writable.
        const entry: AcceptanceCase = { title, file: junitCase.file, outcome: junitCase.outcome }
        const list = casesById.get(token)
        if (list) list.push(entry)
        else casesById.set(token, [entry])
      } else {
        // A NUL cannot occur in a plan id, so the key cannot collide across (id, file) pairs.
        const key = `${token}\0${junitCase.file}`
        if (!undeclared.has(key)) {
          undeclared.set(key, { kind: 'undeclared-id', id: reportedId(token), file: junitCase.file, title })
        }
      }
    }
  }

  const errors = [...undeclared.values()]
  const behaviours = [...declared].map((id): AcceptanceBehaviourStatus => {
    const own = casesById.get(id) ?? []
    const files = [...new Set(own.map((entry) => entry.file))]
    if (files.length > 1) errors.push({ kind: 'id-in-several-files', id, files })
    return { id, status: statusOf(own), cases: own }
  })

  return errors.length > 0 ? { state: 'invalid', errors, observed: behaviours } : { state: 'judged', behaviours }
}

// `…` is outside the id grammar, so a cut id can never be read back as one.
function reportedId(token: string): string {
  return token.length > MAX_REPORTED_ID_CHARS ? `${token.slice(0, MAX_REPORTED_ID_CHARS)}…` : token
}

function statusOf(cases: readonly AcceptanceCase[]): AcceptanceStatus {
  if (cases.length === 0) return 'pending'
  return cases.every((entry) => entry.outcome === 'passed') ? 'passing' : 'failing'
}

/**
 * Every `[token]` in the text, delimiters stripped, in one pass. The id is compared
 * whole and literally, which is what keeps `AC-comments-1` out of `[AC-comments-10]`
 * and a `.` in an id from matching any character.
 */
function bracketedTokens(text: string): string[] {
  const tokens: string[] = []
  let open = -1
  for (let index = text.indexOf('['); index !== -1 && index < text.length; index++) {
    const char = text[index]
    if (char === '[') {
      open = index
    } else if (char === ']') {
      if (open !== -1 && index > open + 1) tokens.push(text.slice(open + 1, index))
      open = -1
    }
  }
  return tokens
}

interface JunitCase {
  /** Distinct tokens of the describe chain and the case's own name. */
  tokens: ReadonlySet<string>
  title: () => string
  file: string
  outcome: AcceptanceCaseOutcome
}

const REPORT_EXTRAS = ['properties', 'system-out', 'system-err']

/**
 * What each element this reader walks may hold; an element with no entry is not walked.
 * The page's `idMap()` is the one null-prototype map keyed by a plan id; this is a second
 * one, keyed by an element name the report chose, where `<constructor>` would otherwise
 * read back as an inherited function and pass for a vocabulary this never declared.
 */
const CHILDREN_OF: Record<string, ReadonlySet<string>> = Object.assign(
  Object.create(null) as Record<string, ReadonlySet<string>>,
  {
    testsuites: new Set(['testsuite', ...REPORT_EXTRAS]),
    testsuite: new Set(['testsuite', 'testcase', ...REPORT_EXTRAS]),
    testcase: new Set(['failure', 'error', 'skipped', ...REPORT_EXTRAS]),
  },
)

function allowedChildren(parent: XmlElement): XmlElement[] {
  const allowed = CHILDREN_OF[parent.name]
  for (const child of parent.children) {
    if (!allowed?.has(child.name)) {
      throw new JunitReportError(`<${child.name}> inside <${parent.name}> is not part of the report format`)
    }
  }
  return parent.children
}

function readJunitCases(text: string): JunitCase[] {
  const root = parseXmlSubset(text, {
    maxChars: JUNIT_MAX_CHARS,
    maxAttributeChars: JUNIT_MAX_ATTRIBUTE_CHARS,
    maxDepth: JUNIT_MAX_DEPTH,
  })
  if (root.name !== 'testsuites') throw new JunitReportError(`the root element is <${root.name}>, not <testsuites>`)

  const cases: JunitCase[] = []
  const visit = (suite: XmlElement, describes: readonly string[], inherited: ReadonlySet<string>): void => {
    for (const child of allowedChildren(suite)) {
      if (child.name === 'testsuite') {
        const name = requiredAttribute(child, 'name')
        visit(child, [...describes, name], new Set([...inherited, ...bracketedTokens(name)]))
      } else if (child.name === 'testcase') {
        cases.push(readCase(child, describes, inherited))
      }
    }
  }
  // A direct child of <testsuites> is the test file, named by its path, and no part of a title.
  for (const file of allowedChildren(root)) {
    if (file.name === 'testsuite') visit(file, [], new Set())
  }
  return cases
}

function readCase(element: XmlElement, describes: readonly string[], inherited: ReadonlySet<string>): JunitCase {
  let outcome: AcceptanceCaseOutcome = 'passed'
  for (const child of allowedChildren(element)) {
    if (child.name === 'failure' || child.name === 'error') outcome = 'failed'
    else if (child.name === 'skipped' && outcome === 'passed') outcome = 'skipped'
  }
  const name = requiredAttribute(element, 'name')
  const own = bracketedTokens(name)
  return {
    tokens: own.length === 0 ? inherited : new Set([...inherited, ...own]),
    title: () => [...describes, name].join(' > '),
    file: requiredAttribute(element, 'file'),
    outcome,
  }
}

function requiredAttribute(element: XmlElement, name: string): string {
  const value = element.attributes.get(name)
  if (value === undefined) throw new JunitReportError(`a <${element.name}> has no ${name} attribute`)
  return value
}
