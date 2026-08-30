import { relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { File } from '@babel/types'
import { classNameFromPath, discoverControllerFiles } from './discovery'
import { extractClassDeclaration } from './model-parser'
import { parseSourceFile } from './parse-cache'
import { walk } from './ast-walk'

/**
 * Controller action bodies, extracted once and judged by regex afterwards.
 *
 * Lives here rather than in `audit.ts` because two commands ask the same
 * question of the same bodies: `guren audit` (validation, authentication,
 * force writes) and `guren check`'s agent-route rules (authorization
 * evidence, Inertia responses, delete calls). Importing `./audit` from a
 * core-suite check would drag the dependency and ignore-config machinery
 * into every `guren check` run for one map.
 *
 * The member vocabulary lives here too, for the same reason: every pattern
 * that spells a `Controller` member name is protected by
 * `controller-surface.test.ts`, which pins `CONTROLLER_MEMBER_KINDS` against
 * `Controller.ts`. A pattern defined outside that reach — as the agent-route
 * checks' `this.authorize(` and `this.inertia(` briefly were — goes stale on
 * a rename with nothing failing.
 */
export interface ControllerMethodInfo {
  /** Method body source with comments and string contents blanked, offsets preserved. */
  body: string
  /** Controller file, relative to the project root. */
  filePath: string
}

/**
 * Two controller classes sharing one name. Reported rather than resolved:
 * routes carry `route.controller.name` alone, so nothing here can tell the
 * two apart — see {@link parseControllerMethods}.
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
}

/**
 * What request data each member of `Controller` hands an action.
 *
 * The keys are the full public/protected method-and-getter surface of
 * `packages/server/src/mvc/Controller.ts` — the only members app code can
 * reach — and `controller-surface.test.ts` re-parses that file and fails when
 * the two lists diverge. That test is the point of enumerating members this
 * rule doesn't care about: a new accessor cannot be added over there and
 * quietly default to "harmless" here, which is exactly how `input()` came to
 * be missed. Which bucket a member belongs in is a semantic judgement about
 * its body, so it stays a deliberate classification rather than something
 * inferred from the name.
 *
 * Classifying a member is not the same as wiring it up: the patterns below are
 * derived from these names but still assume call syntax, so a body-reading
 * *getter* would need the pattern touched too, not just an entry here.
 */
export type ControllerMemberKind =
  /**
   * Hands back request-body content nothing has validated. `file()`/`files()`
   * belong here because they are `req.parseBody()` under the hood
   * (Controller.ts) — the raw call this rule has always flagged — and a helper
   * cannot be a clean pass while the call it delegates to is a failure.
   */
  | 'body-payload'
  /**
   * Reads the body but yields nothing a schema would have caught: `has()`
   * answers only whether a key is present. Not flagged, but not "does not
   * consume the request body" either — see the finding in audit.ts.
   */
  | 'body-incidental'
  /** Reads the body in order to validate it — the remedy, not the problem. */
  | 'body-validation'
  /** Never touches the request body. */
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
 * A member name the classification above knows. Spelling a pattern through
 * this type is what makes the surface test protect it: a member renamed in
 * `Controller.ts` fails that test, and every pattern naming the old member
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
 * rather than `[^>]*` so a nested type argument (`this.input<Array<string>>()`)
 * still reaches the closing `(` — stopping at the first `>` silently skipped
 * those calls. Longest name first so `validateBody` cannot shadow
 * `validateBodySafe`.
 */
export function accessorCallPattern(names: readonly string[]): string {
  const alternation = [...names].sort((a, b) => b.length - a.length).join('|')
  return `\\b(?:${alternation})\\s*(?:<[^()]*>)?\\s*\\(`
}

/**
 * `this.<member>(` for named members. `this.` is required because the members
 * are `protected`: a call through anything else is a different API.
 */
function controllerMemberCall(...names: ControllerMemberName[]): RegExp {
  return new RegExp(`\\bthis\\s*\\.\\s*${accessorCallPattern(names)}`)
}

/**
 * Calls that actually reject unauthenticated requests. Optional reads like
 * `auth.user()`, `auth.id()`, or `auth.check()` do not enforce anything on
 * their own, so they intentionally do not count as protection.
 *
 * The `apiToken` half is not optional for agent-facing rules: a bearer token
 * is the auth path an agent actually uses, so a narrower copy of this pattern
 * would report a token-authenticated action as having no authentication at
 * all.
 */
export const AUTH_CALL_PATTERN = new RegExp(
  `\\bauth\\s*\\.\\s*userOrFail\\s*(?:<[^>]*>)?\\s*\\(|${
    controllerMemberCall('apiToken', 'apiTokenUserId').source}`,
)

/**
 * `this.authorize(...)` — the call that throws a 403. `this.can(...)` is
 * deliberately excluded: it returns a boolean and enforces nothing, the same
 * distinction drawn above between `userOrFail()` and `check()`.
 */
export const AUTHORIZE_CALL_PATTERN = controllerMemberCall('authorize')

/** An Inertia page response, which carries no JSON schema an agent could read. */
export const INERTIA_CALL_PATTERN = controllerMemberCall('inertia')

/**
 * A record deletion, for the annotation-honesty rules (RFC 0016 §5.5).
 *
 * Two shapes, both constrained the way `MODEL_ATTACH_PATTERN` in audit.ts is:
 * a model static (`Post.delete(...)`, `Post.forceDelete(...)`), which requires
 * a PascalCase receiver, and a terminated query chain
 * (`Post.where(...).delete()`), which requires the call to follow a closing
 * paren. Without those constraints every `map.delete(key)` and
 * `cache.delete(...)` in an action would read as a record deletion.
 */
export const DELETE_CALL_PATTERN =
  /\b[A-Z][A-Za-z0-9_]*\s*\.\s*(?:delete|forceDelete)\s*\(|\)\s*\.\s*(?:delete|forceDelete)\s*\(/

/**
 * A write that bypasses mass-assignment protection. Read by the audit's
 * force-write heuristic and by the agent-route annotation rules, which count
 * it as state change alongside a deletion.
 */
export const FORCE_WRITE_PATTERN = /\bforce(Create|Update)\s*\(/

/**
 * Method bodies below are judged with regexes (VALIDATE_BODY_PATTERN,
 * AUTH_CALL_PATTERN, BODY_ACCESS_PATTERN, FORCE_WRITE_PATTERN), which cannot
 * tell live code from a commented-out line, a string that merely mentions an
 * API, JSX text, or a type-only declaration. A commented
 * `// await this.validateBody(...)` must not count as validation, a
 * `forceCreate` inside an error message must not warn, and neither must a
 * local `type Decoy = { validateBody(): void }` nested in the method body —
 * TS allows local type/interface declarations inside a function, and their
 * member signatures read exactly like the runtime call the regexes look for.
 * Blank comments, string/regex/JSX-text contents, template quasis, and whole
 * type-alias/interface declarations (never executable, so blanking the full
 * range is always safe) with spaces — offsets are preserved, so method-body
 * slices taken from the result line up with the original AST positions.
 * Template *expressions* are kept: they are live code.
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
      // Blank the whole declaration and stop descending — it contributes no
      // runtime code, so there is nothing further inside worth walking.
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
 * app/Http/Controllers (module-aware — see discoverControllerFiles).
 *
 * The map is keyed by class name alone, with no file/module namespacing —
 * routes only carry `route.controller.name` (the class's runtime `.name`),
 * not an import path, so route-level checks have no way to disambiguate two
 * same-named controllers in different modules. A flat
 * app/Http/Controllers/ directory can't produce this collision (the
 * filesystem itself enforces unique file names), but two modules each
 * scaffolding their own e.g. `PostController` legitimately can. When that
 * happens, verdicts for BOTH controllers' routes are drawn from whichever
 * file was discovered last — a validated action in one module can make an
 * unsafe, same-named one in another module read as "pass".
 *
 * Collisions are returned rather than resolved, and every caller must say
 * something about them: dropping them silently is fail-open, because the
 * body a rule just judged may belong to a different file than the route it
 * judged it for.
 */
export async function parseControllerMethods(cwd: string): Promise<ControllerMethodScan> {
  const methods = new Map<string, ControllerMethodInfo>()
  const collisions: ControllerNameCollision[] = []
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  for (const filePath of controllerFiles) {
    const source = await readFile(filePath, 'utf-8')
    const relPath = relative(cwd, filePath)

    const ast = parseSourceFile(source, filePath)
    if (!ast) continue
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

      for (const member of classDecl.body.body) {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const start = member.body.start ?? 0
          const end = member.body.end ?? 0
          methods.set(`${className}.${member.key.name}`, {
            body: scrubbed.slice(start, end),
            filePath: relPath,
          })
        }
      }
    }
  }

  return { methods, collisions }
}
