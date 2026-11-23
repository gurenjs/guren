/**
 * The review policy of a change (RFC 0040 §3): `guren.review.ts` at the merge base, read as data
 * from git objects and never run, then applied to the facts. A policy that does not read whole is
 * not applied at all, and the change is held at high: a raise it holds would not show otherwise.
 */
import type { Node } from '@babel/types'

import { memberKeyName, unwrapTypeAssertion } from '../ast-walk'
import { matchesAnyGlob } from '../glob-match'
import { parseSourceFile } from '../parse-cache'
import type { ReviewPolicy } from '../review/index'
import { FACT_CLASSES, LANES, laneRank, type FactCode, type Lane } from './fact-classes'
import type { ChangeFact } from './lane'
import type { ChangedPath, ChangeReader } from './resolve'

export const REVIEW_POLICY_FILE = 'guren.review.ts'
const POLICY_MODULE = '@guren/cli/review'
const POLICY_CALLEE = 'defineReviewPolicy'

export type LoadedReviewPolicy = { state: 'absent' } | { state: 'read'; policy: ReviewPolicy } | { state: 'unreadable'; reason: string }

class PolicyError extends Error {}

const fail = (message: string): never => {
  throw new PolicyError(message)
}

const lineOf = (node: Node): string => (node.loc ? `line ${node.loc.start.line}` : 'the file')

/** The value a literal node spells, or a {@link PolicyError} naming what is not one. */
function literalValue(node: Node, at: string): unknown {
  const value = unwrapTypeAssertion(node)
  const label = at === '' ? 'the policy' : at
  switch (value.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return value.value
    case 'TemplateLiteral':
      if (value.expressions.length === 0) return value.quasis[0]?.value.cooked ?? ''
      break
    case 'ArrayExpression':
      return value.elements.map((element, index) => (element && element.type !== 'SpreadElement' ? literalValue(element, `${at}[${index}]`) : fail(`${label}[${index}] (${lineOf(value)}) is a spread or a hole`)))
    case 'ObjectExpression': {
      const object: Record<string, unknown> = {}
      for (const property of value.properties) {
        const key = property.type === 'ObjectProperty' ? memberKeyName({ computed: property.computed, key: property.key }) : undefined
        if (property.type !== 'ObjectProperty' || key === undefined) fail(`${label} (${lineOf(property)}) has a spread, a method or a computed key`)
        // Assigning `__proto__` sets the prototype, a key no own-property check would see.
        if (key === '__proto__') fail(`${label} (${lineOf(property)}) has a \`__proto__\` key`)
        const entry = property as Extract<typeof property, { type: 'ObjectProperty' }>
        object[key!] = literalValue(entry.value as Node, at === '' ? key! : `${at}.${key}`)
      }
      return object
    }
  }
  return fail(`${label} (${lineOf(value)}) is ${value.type === 'Identifier' ? `the name ${value.name}` : `a ${value.type}`}, not a value written in place`)
}

function policyLiteral(source: string): unknown {
  const ast = parseSourceFile(source, REVIEW_POLICY_FILE)
  if (!ast) return fail('it does not parse')
  const callees = new Set([POLICY_CALLEE])
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== POLICY_MODULE) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && memberKeyName({ key: specifier.imported }) === POLICY_CALLEE) callees.add(specifier.local.name)
    }
  }
  const declaration = ast.program.body.find((statement) => statement.type === 'ExportDefaultDeclaration')
  if (!declaration) return fail(`it has no default export; write \`export default ${POLICY_CALLEE}({ … })\``)
  const exported = unwrapTypeAssertion(declaration.declaration as Node)
  if (exported.type === 'ObjectExpression') return literalValue(exported, '')
  if (exported.type === 'CallExpression' && exported.callee.type === 'Identifier' && callees.has(exported.callee.name) && exported.arguments.length === 1 && exported.arguments[0]!.type !== 'SpreadElement') {
    return literalValue(exported.arguments[0] as Node, '')
  }
  return fail(`its default export (${lineOf(exported)}) is not \`${POLICY_CALLEE}({ … })\` around an object written in place`)
}

const isLane = (value: unknown): value is Lane => LANES.includes(value as Lane)

function record(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${at} is not an object`)
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  const known = keys.length > 6 ? 'a key it knows' : `one of ${keys.map((key) => `\`${key}\``).join(', ')}`
  if (unknown.length > 0) fail(`${at} has ${unknown.map((key) => `\`${key}\``).join(', ')}, which is not ${known}`)
  return value as Record<string, unknown>
}

// `*` and `**` are the whole vocabulary: a glob it would read as literal text matches nothing, and the raise it holds never shows.
const FOREIGN_GLOB = /[{}[\]?!\\]|[@+*]\(|^\.?\/|\/$|^\s|\s$/

function globs(value: unknown, at: string): string | string[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0 || !list.every((glob) => typeof glob === 'string' && glob !== '')) fail(`${at} is not a glob or a list of globs`)
  for (const glob of list as string[]) {
    if (FOREIGN_GLOB.test(glob) || glob.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail(`${at} has ${JSON.stringify(glob)}: a glob is relative to the application root, with no empty, . or .. segment, and only * and ** as wildcards (no braces, brackets, ?, ! or extglob)`)
  }
  return value as string | string[]
}

/** A glob with no wildcard names a file or a directory, as CODEOWNERS does. */
const matchesPolicyGlob = (path: string, glob: string): boolean => matchesAnyGlob(path, glob.includes('*') ? glob : [glob, `${glob}/**`])

/** Validates a policy read as data; every message names the key it refuses. */
export function validateReviewPolicy(value: unknown): ReviewPolicy {
  const top = record(value, 'the policy', ['approvals', 'paths', 'facts', 'review', 'identities', 'merge'])
  if (top.approvals !== undefined) {
    for (const [lane, count] of Object.entries(record(top.approvals, 'approvals', LANES))) {
      if (!Number.isInteger(count) || (count as number) < 0) fail(`approvals.${lane} is not a whole number of approvals`)
    }
  }
  if (top.paths !== undefined) {
    for (const [lane, list] of Object.entries(record(top.paths, 'paths', ['high', 'medium']))) globs(list, `paths.${lane}`)
  }
  if (top.facts !== undefined) {
    for (const [code, lane] of Object.entries(record(top.facts, 'facts', Object.keys(FACT_CLASSES).filter((key) => FACT_CLASSES[key as FactCode].kind !== 'policy')))) {
      if (!isLane(lane)) fail(`facts.${code} is not \`low\`, \`medium\` or \`high\``)
      const { kind, lowest } = FACT_CLASSES[code as FactCode]
      if (laneRank(lane as Lane) < laneRank(lowest)) {
        fail(`facts.${code} lowers ${kind === 'always-high' ? 'an always-high fact, the floor the rest stands on' : kind === 'fixed' ? 'a fact that stays medium whatever a plan or the policy says' : `a fact no lower than ${lowest}, the lane a plan's declaration gives it`}`)
      }
    }
  }
  if (top.review !== undefined) {
    const review = record(top.review, 'review', ['reviewer', 'timeoutMinutes'])
    const reviewer = review.reviewer
    if (reviewer !== 'claude-code-review' && reviewer !== 'bugbot') {
      const named = record(reviewer, 'review.reviewer', ['check', 'app', 'conclusion'])
      if (!['check', 'app', 'conclusion'].every((key) => typeof named[key] === 'string' && named[key] !== '')) {
        fail("review.reviewer is not 'claude-code-review', 'bugbot' or { check, app, conclusion }")
      }
    }
    if (review.timeoutMinutes !== undefined && !(Number.isFinite(review.timeoutMinutes) && (review.timeoutMinutes as number) > 0)) fail('review.timeoutMinutes is not a positive number')
  }
  if (top.identities !== undefined && !['auto', 'several', 'one-owner'].includes(top.identities as string)) fail("identities is not 'auto', 'several' or 'one-owner'")
  if (top.merge !== undefined) {
    const merge = record(top.merge, 'merge', ['low'])
    if (merge.low !== undefined && merge.low !== 'lane-job' && merge.low !== 'person') fail("merge.low is not 'lane-job' or 'person'")
  }
  return top as ReviewPolicy
}

export function readReviewPolicySource(source: string): LoadedReviewPolicy {
  try {
    return { state: 'read', policy: validateReviewPolicy(policyLiteral(source)) }
  } catch (error) {
    if (error instanceof PolicyError) return { state: 'unreadable', reason: error.message }
    throw error
  }
}

/** The merge base's policy: the change's own edit to the file takes effect once merged, never in its own lane. */
export async function loadBaseReviewPolicy(reader: ChangeReader): Promise<LoadedReviewPolicy> {
  const source = await reader.read('base', REVIEW_POLICY_FILE)
  return source === null ? { state: 'absent' } : readReviewPolicySource(source)
}

/**
 * The facts with the policy applied: each named fact set to its lane, marked with the lane it had,
 * and one `review-path` fact per glob a changed path matches. A path outside the application is
 * never matched, since the globs are relative to its root.
 */
export function applyReviewPolicy(facts: readonly ChangeFact[], paths: readonly ChangedPath[], policy: ReviewPolicy): ChangeFact[] {
  const set = (code: Exclude<FactCode, 'review-path'>): Lane | undefined => (policy.facts && Object.hasOwn(policy.facts, code) ? policy.facts[code] : undefined)
  const applied = facts.map((fact) => {
    let lane = set(fact.code as Exclude<FactCode, 'review-path'>)
    // A declared edit or deletion is still one: a raise the policy sets for `source-edited` or `source-removed` holds for it too.
    const edit = fact.planAddition ? set('source-edited') : fact.code === 'file-removed' ? set('source-removed') : undefined
    if (edit !== undefined && laneRank(edit) > laneRank(lane ?? fact.lane)) lane = edit
    return lane === undefined || lane === fact.lane ? fact : { ...fact, lane, policyFrom: fact.lane }
  })
  const claimed = new Set<ChangedPath>()
  for (const lane of ['high', 'medium'] as const) {
    const list = policy.paths && Object.hasOwn(policy.paths, lane) ? policy.paths[lane] : undefined
    for (const glob of list === undefined ? [] : Array.isArray(list) ? list : [list]) {
      const matched = paths.filter((entry) => !entry.outsideApp && !claimed.has(entry) && [entry.path, entry.oldPath].some((path) => path !== undefined && matchesPolicyGlob(path, glob)))
      if (matched.length === 0) continue
      for (const entry of matched) claimed.add(entry)
      applied.push({ code: 'review-path', lane, target: glob, files: matched.map((entry) => entry.path), evidence: 'path', message: `matches ${glob}, which ${REVIEW_POLICY_FILE} puts at ${lane}` })
    }
  }
  return applied
}

/** What a report prints beside a fact the policy set, and nothing beside any other. */
export function policyNote(fact: Pick<ChangeFact, 'lane' | 'policyFrom'>): string {
  if (fact.policyFrom === undefined) return ''
  return ` (${laneRank(fact.lane) < laneRank(fact.policyFrom) ? 'lowered' : 'raised'} by ${REVIEW_POLICY_FILE} from ${fact.policyFrom})`
}
