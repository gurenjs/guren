/**
 * Acceptance-behaviour status from a `bun test --reporter=junit` report (RFC 0030 §6).
 * Pure: `plan:verify` runs the tests and hands over the report text.
 * Bun nests one `<testsuite>` per `describe`, so a full title is the chain of suite
 * names; `classname` is not read, since Bun writes it innermost-first with a
 * double-escaped separator. A file that fails to load and a test behind a failing
 * `beforeAll` are absent from the report, which reads as `pending`, never as passing.
 */

import type { Plan } from './schema'

/** UTF-16 units. A report holds a line per test and no output, so this is a wrong file, not a big suite. */
export const JUNIT_MAX_CHARS = 32 * 1024 * 1024
export const JUNIT_MAX_ATTRIBUTE_CHARS = 1024 * 1024
export const JUNIT_MAX_DEPTH = 64

/**
 * A bracketed title token no behaviour declares is reported only under this prefix:
 * `[GET]` or `[admin]` in an unrelated test title is not a mistyped behaviour id.
 */
export const ACCEPTANCE_ID_PREFIX = 'AC-'

// Longer than any id; bounds the scan for `]` so a title of `[[[[…` stays linear.
const MAX_ID_CHARS = 256

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
  | { kind: 'undeclared-id'; id: string; file: string; title: string }

/** `errors` stand beside the statuses: a caller must not read a report carrying any as verifying anything. */
export type AcceptanceReport =
  | { state: 'blocked'; reason: string }
  | { state: 'read'; behaviours: AcceptanceBehaviourStatus[]; errors: AcceptanceError[] }

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
    if (error instanceof JunitReadError) return { state: 'blocked', reason: error.message }
    throw error
  }

  const declared = new Set(declaredIds)
  const casesById = new Map<string, AcceptanceCase[]>()
  const errors: AcceptanceError[] = []

  for (const junitCase of cases) {
    const found = new Set(junitCase.segments.flatMap(bracketedTokens))
    const title = junitCase.segments.join(' > ')
    for (const token of found) {
      if (declared.has(token)) {
        const list = casesById.get(token) ?? []
        list.push({ title, file: junitCase.file, outcome: junitCase.outcome })
        casesById.set(token, list)
      } else if (token.startsWith(ACCEPTANCE_ID_PREFIX) && isPlanId(token)) {
        errors.push({ kind: 'undeclared-id', id: token, file: junitCase.file, title })
      }
    }
  }

  const behaviours = [...declared].map((id): AcceptanceBehaviourStatus => {
    const own = casesById.get(id) ?? []
    const files = [...new Set(own.map((entry) => entry.file))]
    if (files.length > 1) errors.push({ kind: 'id-in-several-files', id, files })
    return { id, status: statusOf(own), cases: own }
  })

  return { state: 'read', behaviours, errors }
}

function statusOf(cases: readonly AcceptanceCase[]): AcceptanceStatus {
  if (cases.length === 0) return 'pending'
  return cases.every((entry) => entry.outcome === 'passed') ? 'passing' : 'failing'
}

/**
 * Every `[token]` in the text, delimiters stripped. The id is compared whole and
 * literally, which is what keeps `AC-comments-1` out of `[AC-comments-10]` and a `.`
 * in an id from matching any character.
 */
function bracketedTokens(text: string): string[] {
  const tokens: string[] = []
  let open = text.indexOf('[')
  while (open !== -1) {
    let end = open + 1
    const limit = Math.min(text.length, open + 1 + MAX_ID_CHARS)
    while (end < limit && text[end] !== ']' && text[end] !== '[') end++
    if (end < limit && text[end] === ']' && end > open + 1) tokens.push(text.slice(open + 1, end))
    open = text.indexOf('[', end < limit && text[end] === ']' ? end + 1 : end)
  }
  return tokens
}

// The id grammar of `schema.ts`, walked by index.
function isPlanId(token: string): boolean {
  if (!isAsciiLetter(token.charCodeAt(0))) return false
  for (let index = 1; index < token.length; index++) {
    const code = token.charCodeAt(index)
    if (!isAsciiLetter(code) && !isDigit(code) && !'_.:-'.includes(token[index]!)) return false
  }
  return true
}

interface JunitCase {
  segments: string[]
  file: string
  outcome: AcceptanceCaseOutcome
}

const SUITE_CHILDREN = new Set(['testsuite', 'testcase', 'properties', 'system-out', 'system-err'])
const CASE_CHILDREN = new Set(['failure', 'error', 'skipped', 'properties', 'system-out', 'system-err'])

function readJunitCases(text: string): JunitCase[] {
  const root = parseXml(text)
  if (root.name !== 'testsuites') throw new JunitReadError(`the root element is <${root.name}>, not <testsuites>`)

  const cases: JunitCase[] = []
  // A direct child of <testsuites> is the test file, named by its path, and no part of a title.
  const visit = (suite: XmlElement, describes: readonly string[], insideFile: boolean): void => {
    for (const child of suite.children) {
      if (!SUITE_CHILDREN.has(child.name)) {
        throw new JunitReadError(`<${child.name}> inside <${suite.name}> is not part of the report format`)
      }
      if (child.name === 'testsuite') {
        visit(child, insideFile ? [...describes, requiredAttribute(child, 'name')] : describes, true)
      } else if (child.name === 'testcase') {
        if (!insideFile) throw new JunitReadError('a <testcase> sits outside any test file')
        cases.push(readCase(child, describes))
      }
    }
  }
  visit(root, [], false)
  return cases
}

function readCase(element: XmlElement, describes: readonly string[]): JunitCase {
  let outcome: AcceptanceCaseOutcome = 'passed'
  for (const child of element.children) {
    if (!CASE_CHILDREN.has(child.name)) {
      throw new JunitReadError(`<${child.name}> inside <testcase> is not part of the report format`)
    }
    if (child.name === 'failure' || child.name === 'error') outcome = 'failed'
    else if (child.name === 'skipped' && outcome === 'passed') outcome = 'skipped'
  }
  return {
    segments: [...describes, requiredAttribute(element, 'name')],
    file: requiredAttribute(element, 'file'),
    outcome,
  }
}

function requiredAttribute(element: XmlElement, name: string): string {
  const value = element.attributes.get(name)
  if (value === undefined) throw new JunitReadError(`a <${element.name}> has no ${name} attribute`)
  return value
}

class JunitReadError extends Error {}

interface XmlElement {
  name: string
  attributes: Map<string, string>
  children: XmlElement[]
}

/**
 * The XML subset a junit report uses: elements, attributes, the five named entities
 * and numeric references, CDATA, comments, processing instructions. A DOCTYPE is
 * refused, so no entity is ever defined by the document. Looser than XML 1.0 in one
 * place: control characters pass, raw and as `&#1;`, because Bun writes both for a
 * title that holds one.
 */
function parseXml(input: string): XmlElement {
  if (input.length > JUNIT_MAX_CHARS) throw new JunitReadError(`the report is over ${JUNIT_MAX_CHARS} characters`)
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let pos = 0

  while (pos < text.length) {
    if (text[pos] !== '<') {
      const next = text.indexOf('<', pos)
      const end = next === -1 ? text.length : next
      const content = text.slice(pos, end)
      if (stack.length === 0) {
        if (content.trim() !== '') throw new JunitReadError(`text outside the root element at offset ${pos}`)
      } else {
        decodeEntities(content, pos)
      }
      pos = end
    } else if (text.startsWith('<!--', pos)) {
      pos = skipPast(text, '-->', pos + 4, 'comment')
    } else if (text.startsWith('<?', pos)) {
      pos = skipPast(text, '?>', pos + 2, 'processing instruction')
    } else if (text.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) throw new JunitReadError(`CDATA outside the root element at offset ${pos}`)
      pos = skipPast(text, ']]>', pos + 9, 'CDATA section')
    } else if (text.startsWith('<!', pos)) {
      throw new JunitReadError(`a declaration (<!DOCTYPE and the like) at offset ${pos} is not read`)
    } else if (text[pos + 1] === '/') {
      const nameEnd = scanName(text, pos + 2)
      const name = text.slice(pos + 2, nameEnd)
      const close = skipWhitespace(text, nameEnd)
      if (name === '' || text[close] !== '>') throw new JunitReadError(`malformed closing tag at offset ${pos}`)
      const open = stack.pop()
      if (open === undefined) throw new JunitReadError(`</${name}> at offset ${pos} closes nothing`)
      if (open.name !== name) throw new JunitReadError(`</${name}> at offset ${pos} closes <${open.name}>`)
      pos = close + 1
    } else {
      const tag = readOpenTag(text, pos)
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(tag.element)
      else if (root) throw new JunitReadError(`a second root element at offset ${pos}`)
      else root = tag.element
      if (!tag.selfClosing) {
        if (stack.length >= JUNIT_MAX_DEPTH) throw new JunitReadError(`elements nest deeper than ${JUNIT_MAX_DEPTH}`)
        stack.push(tag.element)
      }
      pos = tag.end
    }
  }

  const unclosed = stack[stack.length - 1]
  if (unclosed) throw new JunitReadError(`the report ends inside <${unclosed.name}>`)
  if (!root) throw new JunitReadError('the report holds no element')
  return root
}

function readOpenTag(text: string, start: number): { element: XmlElement; selfClosing: boolean; end: number } {
  const nameEnd = scanName(text, start + 1)
  if (nameEnd === start + 1) throw new JunitReadError(`malformed tag at offset ${start}`)
  const element: XmlElement = { name: text.slice(start + 1, nameEnd), attributes: new Map(), children: [] }

  let pos = nameEnd
  for (;;) {
    const afterSpace = skipWhitespace(text, pos)
    if (afterSpace >= text.length) throw new JunitReadError(`the report ends inside a <${element.name}> tag`)
    if (text[afterSpace] === '>') return { element, selfClosing: false, end: afterSpace + 1 }
    if (text[afterSpace] === '/' && text[afterSpace + 1] === '>') {
      return { element, selfClosing: true, end: afterSpace + 2 }
    }
    if (afterSpace === pos) throw new JunitReadError(`malformed <${element.name}> tag at offset ${start}`)

    const attributeEnd = scanName(text, afterSpace)
    const name = text.slice(afterSpace, attributeEnd)
    const equals = skipWhitespace(text, attributeEnd)
    const quoteAt = skipWhitespace(text, equals + 1)
    const quote = text[quoteAt]
    if (name === '' || text[equals] !== '=' || (quote !== '"' && quote !== "'")) {
      throw new JunitReadError(`malformed attribute in <${element.name}> at offset ${afterSpace}`)
    }
    const valueEnd = text.indexOf(quote, quoteAt + 1)
    if (valueEnd === -1) throw new JunitReadError(`the report ends inside an attribute of <${element.name}>`)
    if (valueEnd - quoteAt - 1 > JUNIT_MAX_ATTRIBUTE_CHARS) {
      throw new JunitReadError(`the ${name} attribute at offset ${afterSpace} is over ${JUNIT_MAX_ATTRIBUTE_CHARS} characters`)
    }
    const raw = text.slice(quoteAt + 1, valueEnd)
    if (raw.includes('<')) throw new JunitReadError(`a raw < inside the ${name} attribute at offset ${afterSpace}`)
    if (element.attributes.has(name)) throw new JunitReadError(`<${element.name}> repeats the ${name} attribute`)
    element.attributes.set(name, decodeEntities(raw, quoteAt + 1))
    pos = valueEnd + 1
  }
}

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

// `&#x10FFFF;` is the longest reference there is.
const MAX_REFERENCE_CHARS = 10

function decodeEntities(raw: string, offset: number): string {
  let amp = raw.indexOf('&')
  if (amp === -1) return raw

  const parts: string[] = []
  let pos = 0
  while (amp !== -1) {
    const semi = raw.indexOf(';', amp)
    if (semi === -1 || semi - amp > MAX_REFERENCE_CHARS) {
      throw new JunitReadError(`an unterminated entity reference at offset ${offset + amp}`)
    }
    const body = raw.slice(amp + 1, semi)
    const decoded = body.startsWith('#') ? decodeNumericReference(body) : NAMED_ENTITIES.get(body)
    if (decoded === undefined) throw new JunitReadError(`the unknown entity &${body}; at offset ${offset + amp}`)
    parts.push(raw.slice(pos, amp), decoded)
    pos = semi + 1
    amp = raw.indexOf('&', pos)
  }
  parts.push(raw.slice(pos))
  return parts.join('')
}

function decodeNumericReference(body: string): string | undefined {
  const hex = body[1] === 'x'
  const digits = body.slice(hex ? 2 : 1)
  if (digits === '') return undefined
  let codePoint = 0
  for (let index = 0; index < digits.length; index++) {
    const digit = digitValue(digits.charCodeAt(index), hex)
    if (digit === -1) return undefined
    codePoint = codePoint * (hex ? 16 : 10) + digit
  }
  const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff
  if (codePoint === 0 || codePoint > 0x10ffff || surrogate) return undefined
  return String.fromCodePoint(codePoint)
}

function digitValue(code: number, hex: boolean): number {
  if (isDigit(code)) return code - 48
  if (!hex) return -1
  const lower = code | 0x20
  return lower >= 97 && lower <= 102 ? lower - 87 : -1
}

function skipPast(text: string, terminator: string, from: number, what: string): number {
  const at = text.indexOf(terminator, from)
  if (at === -1) throw new JunitReadError(`the report ends inside a ${what}`)
  return at + terminator.length
}

function skipWhitespace(text: string, from: number): number {
  let pos = from
  while (pos < text.length && ' \t\r\n'.includes(text[pos]!)) pos++
  return pos
}

// Names reach the blocked reason, so an oversized one is cut short here and fails as malformed.
const MAX_NAME_CHARS = 128

function scanName(text: string, from: number): number {
  let pos = from
  const limit = Math.min(text.length, from + MAX_NAME_CHARS)
  while (pos < limit) {
    const code = text.charCodeAt(pos)
    const start = isAsciiLetter(code) || text[pos] === '_' || text[pos] === ':'
    if (!start && (pos === from || (!isDigit(code) && text[pos] !== '-' && text[pos] !== '.'))) break
    pos++
  }
  return pos
}

function isAsciiLetter(code: number): boolean {
  const lower = code | 0x20
  return lower >= 97 && lower <= 122
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}
