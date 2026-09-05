import { relative } from 'node:path'
import type {
  BlockStatement,
  ClassDeclaration,
  ClassMethod,
  ClassProperty,
  Expression,
  File,
} from '@babel/types'
import { classNameFromPath, discoverControllerFiles } from './discovery'
import { extractClassDeclaration } from './model-parser'
import { ParseCache } from './parse-cache'
import { memberKeyName, walk } from './ast-walk'

/**
 * Controller action bodies, extracted once and judged by regex afterwards. Lives
 * here rather than in `audit.ts` because `guren audit` and `guren check`'s agent-route
 * rules ask the same question of the same bodies, and importing `./audit` would drag
 * its dependency and ignore-config machinery into every `guren check` run. Only patterns
 * spelling a `Controller` member name from this module are pinned by `controller-surface.test.ts`.
 */
export interface ControllerMethodInfo {
  /** Method body source with comments and string contents blanked, offsets preserved. */
  body: string
  /** Controller file, relative to the project root. */
  filePath: string
}

/**
 * Two controller classes sharing one name. Reported rather than resolved:
 * routes carry `route.controller.name` alone — see {@link parseControllerMethods}.
 */
export interface ControllerNameCollision {
  className: string
  previousFile: string
  currentFile: string
}

export interface ControllerMethodScan {
  /** `ClassName.method` → body. Last file scanned wins on a collision. */
  methods: Map<string, ControllerMethodInfo>
  collisions: ControllerNameCollision[]
  /**
   * Controller files that could not be read at all. Their actions are absent
   * from `methods`, so a route naming one must take a could-not-verify path
   * rather than a confident verdict.
   */
  unreadableFiles: string[]
}

/**
 * The scan an app contributes when there is nothing to scan, shared so that
 * "we skipped the scan" and "the scan found nothing" stay the same shape.
 */
export const EMPTY_CONTROLLER_SCAN: ControllerMethodScan = {
  methods: new Map(),
  collisions: [],
  unreadableFiles: [],
}

/**
 * What request data each member of `Controller` hands an action. The keys must be
 * the full public/protected surface of `packages/server/src/mvc/Controller.ts`;
 * `controller-surface.test.ts` fails when the two diverge, so a new accessor cannot
 * quietly default to "harmless" here. The patterns below assume call syntax, so a
 * body-reading *getter* needs the pattern touched too, not just an entry here.
 */
export type ControllerMemberKind =
  /**
   * Hands back request-body content nothing has validated. `file()`/`files()`
   * belong here because they are `req.parseBody()` under the hood: a helper
   * cannot be a clean pass while the call it delegates to is a failure.
   */
  | 'body-payload'
  /**
   * Reads the body but yields nothing a schema would have caught (`has()`).
   * Not flagged, but not "does not consume the request body" either.
   */
  | 'body-incidental'
  /** Reads the body in order to validate it — the remedy, not the problem. */
  | 'body-validation'
  | 'non-body'

export const CONTROLLER_MEMBER_KINDS = {
  input: 'body-payload',
  only: 'body-payload',
  except: 'body-payload',
  file: 'body-payload',
  files: 'body-payload',

  has: 'body-incidental',

  validateBody: 'body-validation',
  validateBodySafe: 'body-validation',

  setContext: 'non-body',
  setContainer: 'non-body',
  setResolvedModel: 'non-body',
  model: 'non-body',
  ctx: 'non-body',
  /** Reached by name through RAW_BODY_READ_PATTERN, not as `this.request(`. */
  request: 'non-body',
  auth: 'non-body',
  make: 'non-body',
  apiToken: 'non-body',
  apiTokenUserId: 'non-body',
  authorize: 'non-body',
  can: 'non-body',
  inertia: 'non-body',
  view: 'non-body',
  locale: 'non-body',
  t: 'non-body',
  tc: 'non-body',
  json: 'non-body',
  text: 'non-body',
  redirect: 'non-body',
  noContent: 'non-body',
  created: 'non-body',
  accepted: 'non-body',
  query: 'non-body',
  validateQuery: 'non-body',
  validateParams: 'non-body',
  validateQuerySafe: 'non-body',
  validateParamsSafe: 'non-body',
} as const satisfies Readonly<Record<string, ControllerMemberKind>>

/**
 * A member name the classification above knows. Spelling a pattern through this
 * type is what makes the surface test protect it: a rename in `Controller.ts`
 * then fails to compile instead of silently matching nothing.
 */
export type ControllerMemberName = keyof typeof CONTROLLER_MEMBER_KINDS

export function controllerMembers(kind: ControllerMemberKind): string[] {
  return Object.entries(CONTROLLER_MEMBER_KINDS)
    .filter(([, memberKind]) => memberKind === kind)
    .map(([name]) => name)
}

/**
 * `name(`, plus the generic forms these helpers are declared with. `[^()]*`
 * rather than `[^>]*`, so a nested type argument still reaches the closing `(`.
 * Longest name first so `validateBody` cannot shadow `validateBodySafe`.
 */
export function accessorCallPattern(names: readonly string[]): string {
  const alternation = [...names].sort((a, b) => b.length - a.length).join('|')
  return `\\b(?:${alternation})\\s*(?:<[^()]*>)?\\s*\\(`
}

/**
 * `this.<member>(`. `this.` is required because the members are `protected`:
 * a call through anything else is a different API.
 */
function controllerMemberCall(...names: ControllerMemberName[]): RegExp {
  return new RegExp(`\\bthis\\s*\\.\\s*${accessorCallPattern(names)}`)
}

/**
 * Calls that actually reject unauthenticated requests. Optional reads
 * (`auth.user()`, `auth.id()`, `auth.check()`) enforce nothing, so they do not
 * count as protection. The `apiToken` half is required for agent-facing rules:
 * a bearer token is the auth path an agent uses.
 */
export const AUTH_CALL_PATTERN = new RegExp(
  `\\bauth\\s*\\.\\s*userOrFail\\s*(?:<[^>]*>)?\\s*\\(|${
    controllerMemberCall('apiToken', 'apiTokenUserId').source}`,
)

/**
 * `this.authorize(...)` — the call that throws a 403. `this.can(...)` is
 * excluded: it returns a boolean and enforces nothing.
 */
export const AUTHORIZE_CALL_PATTERN = controllerMemberCall('authorize')

/** An Inertia page response, which carries no JSON schema an agent could read. */
export const INERTIA_CALL_PATTERN = controllerMemberCall('inertia')

/**
 * A call to one of `names` on a model, in its two shapes: a static on the class
 * (PascalCase receiver) and a terminated query chain (call follows a closing
 * paren) — the discipline `MODEL_ATTACH_PATTERN` in audit.ts also applies.
 * Without it every `map.delete(key)` would read as a database write.
 */
function modelCallPattern(...names: string[]): RegExp {
  const alternation = names.join('|')
  return new RegExp(
    `\\b[A-Z][A-Za-z0-9_]*\\s*\\.\\s*(?:${alternation})\\s*\\(`
    + `|\\)\\s*\\.\\s*(?:${alternation})\\s*\\(`,
  )
}

/** A record deletion, for the annotation-honesty rules (RFC 0016 §5.5). */
export const DELETE_CALL_PATTERN = modelCallPattern('delete', 'forceDelete')

const UPDATE_CALL_PATTERN = modelCallPattern('update')

/**
 * A write that bypasses mass-assignment protection, counted as state change by
 * the audit's force-write heuristic and the agent-route annotation rules. Looser
 * than {@link modelCallPattern} — any receiver will do — because `forceCreate`/`forceUpdate`
 * are ORM names distinctive enough not to collide, where `update` and `delete` plainly
 * are. A receiver is still required: the bare name also matches a *declaration*.
 */
export const FORCE_WRITE_PATTERN = /\.\s*force(?:Create|Update)\s*\(/

/**
 * Whether an action body shows it changes stored records. The one rule behind
 * both annotation-honesty checks (`guren audit`'s `destructiveHint: false` and
 * `guren check`'s `readOnlyHint: true`), which must not disagree about what counts
 * as a mutation. Deliberately narrow: an honesty rule accuses an author of a false
 * declaration, so it fires only on unambiguous shapes.
 */
export function mutatesRecords(body: string): boolean {
  return (
    DELETE_CALL_PATTERN.test(body)
    || UPDATE_CALL_PATTERN.test(body)
    || FORCE_WRITE_PATTERN.test(body)
  )
}

/**
 * Blanks with spaces everything the body regexes must not read as live code:
 * comments, string/regex/JSX-text contents, template quasis, and whole
 * type-alias/interface declarations (TS allows them inside a function, and their
 * member signatures read exactly like a runtime call). Offsets are preserved so
 * body slices still line up with AST positions. Template *expressions* are live code, kept.
 */
export function blankCommentsAndStrings(source: string, ast: File): string {
  const ranges: [number, number][] = []
  for (const comment of ast.comments ?? []) {
    if (typeof comment.start === 'number' && typeof comment.end === 'number') {
      ranges.push([comment.start, comment.end])
    }
  }
  walk(ast.program, (node) => {
    const { type, start, end } = node
    if (typeof start !== 'number' || typeof end !== 'number') return
    if (type === 'StringLiteral' || type === 'DirectiveLiteral') {
      ranges.push([start + 1, end - 1])
    } else if (type === 'TemplateElement' || type === 'RegExpLiteral' || type === 'JSXText') {
      ranges.push([start, end])
    } else if (type === 'TSTypeAliasDeclaration' || type === 'TSInterfaceDeclaration') {
      ranges.push([start, end])
      return false
    }
  })
  if (ranges.length === 0) return source

  // split('') keeps UTF-16 code-unit indexing — Babel offsets are code units,
  // and a code-point spread would shift everything after an astral character.
  const chars = source.split('')
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * Map of `ClassName.method` → method body source, for every controller in
 * app/Http/Controllers (module-aware — see discoverControllerFiles). Keyed by
 * class name alone, because routes carry only `route.controller.name`: two modules
 * can each scaffold a `PostController`, and then verdicts for BOTH come from whichever
 * file was discovered last. Collisions are returned, not resolved; dropping them silently is fail-open.
 */
export async function parseControllerMethods(
  cwd: string,
  cache?: ParseCache,
): Promise<ControllerMethodScan> {
  const methods = new Map<string, ControllerMethodInfo>()
  const collisions: ControllerNameCollision[] = []
  const unreadableFiles: string[] = []
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  // Every read goes through a cache, given one or not: it is what turns an
  // unreadable file into a reported outcome rather than a rejected promise.
  const parseCache = cache ?? new ParseCache()

  for (const filePath of controllerFiles) {
    const relPath = relative(cwd, filePath)
    const outcome = await parseCache.read(filePath)

    if (outcome.status === 'unreadable') {
      unreadableFiles.push(relPath)
      continue
    }
    if (outcome.status !== 'parsed') continue

    const { source, ast } = outcome
    const scrubbed = blankCommentsAndStrings(source, ast)

    for (const node of ast.program.body) {
      const classDecl = extractClassDeclaration(node)
      if (!classDecl) continue
      const className = classDecl.id?.name ?? classNameFromPath(filePath)

      const previousFile = classFiles.get(className)
      if (previousFile && previousFile !== relPath) {
        collisions.push({ className, previousFile, currentFile: relPath })
      }
      classFiles.set(className, relPath)

      for (const { name, body } of classActionMembers(classDecl)) {
        methods.set(`${className}.${name}`, {
          body: scrubbed.slice(body.start ?? 0, body.end ?? 0),
          filePath: relPath,
        })
      }
    }
  }

  return { methods, collisions, unreadableFiles }
}

/**
 * Class members holding a function body, in both forms `Router` dispatches to
 * (`async destroy() {}` and `store = async () => {}`); a scan seeing only the method form
 * reports class-field actions as absent. Names come from `memberKeyName` (quoted keys count,
 * computed do not); one yield per member, so a `get`/`set` pair yields twice, and an instance
 * field shadows a prototype method whatever the order. `constructor`/`static`/`private` are yielded: filtering is the caller's policy.
 */
export interface ClassActionMember {
  /** The member node itself, for its source span, `accessibility`, and `static`. */
  member: ClassMethod | ClassProperty
  name: string
  /**
   * A `BlockStatement`, or the expression itself for an expression-bodied
   * arrow. A caller asking whether a body is empty must test for the block
   * first — an expression body is never empty.
   */
  body: BlockStatement | Expression
}

export function* classActionMembers(
  classDecl: ClassDeclaration,
): Generator<ClassActionMember> {
  for (const member of classDecl.body.body) {
    if (member.type === 'ClassMethod') {
      const name = memberKeyName(member)
      if (name !== undefined) yield { member, name, body: member.body }
      continue
    }

    if (member.type === 'ClassProperty') {
      const { value } = member
      if (
        value
        && (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
      ) {
        const name = memberKeyName(member)
        if (name !== undefined) yield { member, name, body: value.body }
      }
    }
  }
}

/**
 * Controller actions declared with an empty body, per class in one file. The one
 * rule behind `guren check`'s `empty-method:` warning and `guren doctor --next`'s
 * "Implement X()" step, which differ only in the record they emit. `constructor`
 * is filtered here rather than by the callers: this is the rule, not the
 * structural iterator above.
 */
export interface EmptyAction {
  className: string
  name: string
}

export function* emptyActions(ast: File, filePath: string): Generator<EmptyAction> {
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    const className = classDecl.id?.name ?? classNameFromPath(filePath)

    for (const { name, body } of classActionMembers(classDecl)) {
      if (name === 'constructor') continue
      // An expression-bodied arrow has no block and is never empty, so the
      // block test has to come first.
      if (body.type !== 'BlockStatement' || body.body.length > 0) continue
      yield { className, name }
    }
  }
}
