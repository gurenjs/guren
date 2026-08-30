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
  /**
   * Controller files that could not be read at all. Their actions are absent
   * from `methods`, so a route naming one takes whichever could-not-verify
   * path its caller documents rather than a confident verdict.
   */
  unreadableFiles: string[]
}

/**
 * The scan an app contributes when there is nothing to scan — no agent route
 * names a controller, so no body exists for any rule to read. A shared
 * constant rather than a literal at each call site, so "we skipped the scan"
 * and "the scan found nothing" stay the same shape to every consumer.
 */
export const EMPTY_CONTROLLER_SCAN: ControllerMethodScan = {
  methods: new Map(),
  collisions: [],
  unreadableFiles: [],
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
 * A call to one of `names` on a model, in the two shapes a model call takes:
 * a static on the class itself (`Post.delete(...)`), which requires a
 * PascalCase receiver, and a terminated query chain
 * (`Post.where(...).delete()`), which requires the call to follow a closing
 * paren — the same discipline `MODEL_ATTACH_PATTERN` in audit.ts applies.
 *
 * Without it, every `map.delete(key)` and `cache.update(...)` in an action
 * would read as a database write. Kept as a factory because the alternative
 * is the same skeleton retyped per verb, which is how two of them drift.
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

/**
 * A record update. `.update(` is a common enough method name that without the
 * receiver discipline a `state.update(...)` or `progress.update(...)` in an
 * action would read as a database write.
 */
const UPDATE_CALL_PATTERN = modelCallPattern('update')

/**
 * A write that bypasses mass-assignment protection. Read by the audit's
 * force-write heuristic and by the agent-route annotation rules, which count
 * it as state change alongside a deletion.
 *
 * Deliberately looser than {@link modelCallPattern}: any receiver will do, so
 * `repository.forceCreate(...)` and `this.posts.forceUpdate(...)` match as
 * well as `Post.forceCreate(...)`. `forceCreate`/`forceUpdate` are Guren ORM
 * names distinctive enough that a call to something else by those names is
 * not a realistic false positive, where `update` and `delete` plainly are —
 * and narrowing this would silently drop coverage the audit's force-write
 * rule has always had.
 *
 * A receiver *is* required, though: matching the bare name also matched a
 * **declaration**, so an action defining its own `function forceUpdate() {}`
 * helper triggered the warning about calling one.
 */
export const FORCE_WRITE_PATTERN = /\.\s*force(?:Create|Update)\s*\(/

/**
 * Whether an action body shows it changes stored records: a deletion, an
 * update, or a mass-assignment-bypassing write.
 *
 * The one rule behind both annotation-honesty checks — `guren audit`'s
 * `destructiveHint: false` and `guren check`'s `readOnlyHint: true` — because
 * the two contradict the same evidence and must not disagree about what
 * counts as a mutation. Deliberately narrow: an honesty rule accuses an
 * author of a false declaration, so it fires only on unambiguous shapes.
 */
export function mutatesRecords(body: string): boolean {
  return (
    DELETE_CALL_PATTERN.test(body)
    || UPDATE_CALL_PATTERN.test(body)
    || FORCE_WRITE_PATTERN.test(body)
  )
}

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
export async function parseControllerMethods(
  cwd: string,
  cache?: ParseCache,
): Promise<ControllerMethodScan> {
  const methods = new Map<string, ControllerMethodInfo>()
  const collisions: ControllerNameCollision[] = []
  const unreadableFiles: string[] = []
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  // Every read goes through a cache, given one or not. It is what makes an
  // unreadable file a *reported outcome* rather than a rejected promise — a
  // permission error, or a file deleted between discovery and read, used to
  // take the whole `guren check` / `guren audit` run down instead of
  // producing the could-not-verify finding those commands document.
  const parseCache = cache ?? new ParseCache()

  for (const filePath of controllerFiles) {
    const relPath = relative(cwd, filePath)
    const outcome = await parseCache.read(filePath)

    if (outcome.status === 'unreadable') {
      unreadableFiles.push(relPath)
      continue
    }
    // Read but unparseable: nothing to walk, and the source alone tells this
    // scan nothing, since every caller judges an action *body*.
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
 * Every member of a controller class that holds a function body, in whichever
 * of the two forms it is written.
 *
 * Both forms are legal to `Router`'s types and to its runtime dispatch, so
 * collecting only `ClassMethod` silently downgraded every class-field action:
 * an unauthorized one reported as "could not verify" instead of failing, and
 * an authorized one drew a false warning about source that was right there.
 *
 * ```ts
 * class PostController extends Controller {
 *   async destroy() {}          // ClassMethod
 *   store = async () => {}      // ClassProperty holding a function
 * }
 * ```
 *
 * Shared from this module for the same reason the member vocabulary above is:
 * five scanners across three commands ask which members of a controller are
 * actions, and a second copy of the answer is how the class-field blind spot
 * survived in four of them after the fifth was fixed. `guren check`'s
 * empty-body rule, `guren doctor`'s next steps, `guren context <Entity>`, and
 * the `spec:generate` screens view all read this list.
 *
 * Member names come from `memberKeyName`, so a quoted key (`'store'() {}`)
 * counts — it dispatches as `controller['store']` like any other — and a
 * computed key (`[store]() {}`) does not: it names whatever the expression
 * holds at runtime, which this scan cannot know, and guessing the literal
 * text would attribute a body to an action that may not exist.
 *
 * One declaration is yielded per member, not one per *name*: a name declared
 * twice yields twice. TypeScript rejects that outright (TS2300), so it needs a
 * hand-written `.js`/`.mjs` controller — which `discoverControllerFiles` does
 * collect. Collapsing to the name would be wrong for the shape that actually
 * occurs, a `get x()`/`set x()` pair, which is two members legitimately
 * sharing one name. Callers that report per name may therefore report a
 * duplicated name twice, as they did when they walked members themselves.
 * Worth knowing if you key on the name: an instance field shadows a prototype
 * method whatever the source order, so the last declaration is not always the
 * one that dispatches.
 *
 * The question it answers is structural — *is this member function-shaped* —
 * and nothing more. Which of those members a given scanner cares about is
 * policy each one owns: `constructor` is yielded (three of the five skip it,
 * this scan deliberately does not), as are `static` and `private` members,
 * because a filter hoisted in here would apply to callers that never asked
 * for it. `TSDeclareMethod` (a bare overload signature) and
 * `ClassAccessorProperty` are excluded by the type tests below: neither
 * carries a body a scanner could read.
 */
export interface ClassActionMember {
  /** The member node itself, for its source span, `accessibility`, and `static`. */
  member: ClassMethod | ClassProperty
  name: string
  /**
   * The function body. A `BlockStatement` for a method or a block-bodied
   * arrow; for an expression-bodied arrow (`store = () => this.json({})`)
   * the expression itself, since there is no block and the expression *is*
   * the body. A caller asking whether a body is empty must therefore test
   * for the block first — an expression body is never empty.
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
 * Controller actions declared with an empty body, per class in one file.
 *
 * The rule behind two findings that are the same observation rendered twice:
 * `guren check`'s `empty-method:` warning and `guren doctor --next`'s
 * "Implement X()" step. They read the same AST the same way and differ only in
 * the record they emit, so the walk lives here and each command keeps its own
 * file I/O and result shape. Written out twice, the block-before-length test
 * below is a trap one copy can lose.
 *
 * `constructor` is filtered here rather than by the callers because this is a
 * rule, not the structural iterator: a constructor is not an action to
 * implement under either command's reading.
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
      // An expression-bodied arrow has no block; its expression is its body,
      // so it is never empty. The block test has to come first.
      if (body.type !== 'BlockStatement' || body.body.length > 0) continue
      yield { className, name }
    }
  }
}
