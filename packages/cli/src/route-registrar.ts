import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ArrowFunctionExpression, File, FunctionDeclaration, FunctionExpression, Statement } from '@babel/types'
import { walk } from './ast-walk'
import { findFirstExisting, findFirstLoadable, readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import { insertImport, PATCH_REASONS, type PatchResult } from './patch-helpers'

/**
 * The export names `@guren/core`'s route loader looks for, in try order, plus its
 * fallback pattern. The one rule for "what counts as this app's route registrar", shared
 * with `load-routes.ts`, which resolves the same names at runtime: a scaffolder picking
 * its own target patches a function the framework never calls, and the routes look wired
 * while mounting nothing.
 */
export const REGISTRAR_EXPORT_NAMES = [
  'registerRoutes',
  'registerWebRoutes',
  'registerApiRoutes',
  'registerAuthRoutes',
  'default',
] as const

export const REGISTRAR_PATTERN = /^register\w*Routes$/u

/** `export { x as "y" }` is legal, so the exported name is not always an identifier. */
export function specifierName(node: { type: string; name?: string; value?: string }): string {
  return node.type === 'Identifier' ? (node.name ?? '') : (node.value ?? '')
}

/**
 * Whether the route loader would accept an export named `name` as a registrar — what
 * `resolveRegistrar()` asks, minus its preference order. Every entry in
 * {@link REGISTRAR_EXPORT_NAMES} but `default` matches {@link REGISTRAR_PATTERN}; a name
 * added there that does not would have to be added here too.
 */
export function isRegistrarExportName(name: string): boolean {
  return name === 'default' || REGISTRAR_PATTERN.test(name)
}

/** Conventional routes entry file, shared by every command that loads routes. */
export const DEFAULT_ROUTES_FILE = 'routes/web.ts'

/**
 * Entry files to look for, in order, when a caller was given no `--routes`. The API-only
 * template ships `routes/api.ts` and no `routes/web.ts`, so a command that assumes
 * {@link DEFAULT_ROUTES_FILE} without probing reports a freshly scaffolded API app as
 * having no routes at all.
 */
export const ROUTES_ENTRY_CANDIDATES = [DEFAULT_ROUTES_FILE, 'routes/web.js', 'routes/api.ts', 'routes/api.js']

/**
 * The app's routes entry, or `null` when it has none — the one rule for "which file is
 * this app's routes entry". `null` rather than a fallback, because callers act on the
 * answer differently (the check rules read it as positive evidence that nothing can be
 * mounted); defaulting would hand them the name of a file that does not exist.
 */
export async function resolveRoutesEntry(cwd: string): Promise<string | null> {
  return findFirstExisting(cwd, ROUTES_ENTRY_CANDIDATES)
}

/**
 * The routes file a loading command uses: the caller's `--routes`, else the app's
 * entry, else {@link DEFAULT_ROUTES_FILE} so the load error names a file. Probed
 * with loader semantics: a `routes` that is a regular file, or an unreadable one,
 * reaches the import and is diagnosed there rather than escaping as ENOTDIR here.
 */
export async function routesEntryOrDefault(cwd: string, override?: string): Promise<string> {
  return override ?? (await findFirstLoadable(cwd, ROUTES_ENTRY_CANDIDATES)) ?? DEFAULT_ROUTES_FILE
}

export interface RouteRegistrar {
  /** The registrar's router parameter name — `router`, or `baseRouter` in the blog template. */
  parameterName: string
  /** Index just past the registrar body's opening `{`. */
  bodyStart: number
  /** Index of the registrar body's closing `}`. */
  bodyEnd: number
}

type RegistrarFunction = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression

/** Top-level `function f() {}` / `const f = () => {}` declarations, by name. */
function declaredFunctions(body: Statement[]): Map<string, RegistrarFunction> {
  const declarations = new Map<string, RegistrarFunction>()

  for (const statement of body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      declarations.set(declaration.id.name, declaration)
      continue
    }

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        const init = declarator.init
        if (declarator.id.type !== 'Identifier') continue
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          declarations.set(declarator.id.name, init)
        }
      }
    }
  }

  return declarations
}

/**
 * Every function this file *exports* that the route loader would accept as the registrar,
 * in source order. Both criteria come from the loader, not from shape: it must be
 * exported (a local helper is never what the framework calls), and matched by export name
 * rather than a `Router`-annotated parameter, since the annotation can be aliased and a
 * helper that merely takes a router is not the entry point.
 */
function registrarCandidates(body: Statement[]): RegistrarFunction[] {
  const declarations = declaredFunctions(body)
  const candidates: RegistrarFunction[] = []

  const add = (candidate: RegistrarFunction | undefined): void => {
    if (candidate) candidates.push(candidate)
  }

  for (const statement of body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration
      // A default export needs no matching name; the loader takes it as-is, anonymous or
      // via the `export default registerWebRoutes` indirection.
      if (
        declaration.type === 'FunctionDeclaration'
        || declaration.type === 'FunctionExpression'
        || declaration.type === 'ArrowFunctionExpression'
      ) {
        add(declaration)
      } else if (declaration.type === 'Identifier') {
        add(declarations.get(declaration.name))
      }
      continue
    }

    if (statement.type !== 'ExportNamedDeclaration') continue

    const declaration = statement.declaration

    if (declaration?.type === 'FunctionDeclaration' && declaration.id && REGISTRAR_PATTERN.test(declaration.id.name)) {
      add(declaration)
      continue
    }

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && REGISTRAR_PATTERN.test(declarator.id.name)) {
          add(declarations.get(declarator.id.name))
        }
      }
      continue
    }

    // `export { registerWebRoutes }` / `export { register as registerRoutes }`
    // — the exported name is what the loader sees.
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ExportSpecifier') continue
      if (isRegistrarExportName(specifierName(specifier.exported))) {
        add(declarations.get(specifier.local.name))
      }
    }
  }

  return candidates
}

function registrarIn(ast: File): RouteRegistrar | null {
  for (const fn of registrarCandidates(ast.program.body)) {
    const [parameter] = fn.params
    // A concise arrow body (`=> router.get(...)`) has nowhere to insert a
    // statement, and a rest/destructured first parameter has no name to pass.
    if (parameter?.type !== 'Identifier' || fn.body.type !== 'BlockStatement') continue
    if (typeof fn.body.start !== 'number' || typeof fn.body.end !== 'number') continue

    return { parameterName: parameter.name, bodyStart: fn.body.start + 1, bodyEnd: fn.body.end - 1 }
  }

  return null
}

/**
 * Where the app's route registrar keeps its body, and what it named its router. Callers
 * splice text at these offsets rather than printing the AST back out, so formatting and
 * comments survive; the parameter name is the only argument they may safely pass, since a
 * registrar that rebinds it does so with a `const` partway down the body. Parsed rather
 * than pattern-matched (`packages/cli/CLAUDE.md`); source Babel cannot parse yields `null`.
 */
export function findRouteRegistrar(content: string): RouteRegistrar | null {
  const ast = parseSourceFile(content, DEFAULT_ROUTES_FILE)
  return ast === null ? null : registrarIn(ast)
}

/** Whether `functionName` is already called somewhere in the file. */
function callsFunction(ast: File, functionName: string): boolean {
  let found = false

  walk(ast.program, (node) => {
    if (found) return false
    if (node.type !== 'CallExpression') return
    const callee = node.callee as { type?: string; name?: string } | undefined
    if (callee?.type === 'Identifier' && callee.name === functionName) {
      found = true
      return false
    }
  })

  return found
}

/**
 * Imports a scaffolded routes file into `routes/web.ts` and calls its registrar from the
 * app's own, in a single write: a lone import breaks `noUnusedLocals`, a lone call does
 * not resolve. "Already wired" is decided by looking for a *call* to that name rather
 * than the rendered `name(router)` text, whose argument depends on the parameter name.
 */
export async function addRouteRegistrarCall(
  filePath: string,
  functionName: string,
  importStatement: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const ast = parseSourceFile(content, filePath)

  if (ast === null) {
    return { modified: false, reason: 'Could not parse the file' }
  }

  if (callsFunction(ast, functionName)) {
    // The call is there; the import may still be missing if someone removed it.
    const withImport = insertImport(content, importStatement)
    if (withImport === null) {
      return { modified: false, reason: 'Already registered' }
    }

    await writeFile(absolutePath, withImport, 'utf8')
    return { modified: true }
  }

  const registrar = registrarIn(ast)

  if (registrar === null) {
    return { modified: false, reason: 'Could not find a route registrar' }
  }

  // The trailing newline keeps the call from absorbing whatever comment the
  // registrar's first statement carries.
  const called
    = content.slice(0, registrar.bodyStart)
    + `\n  ${functionName}(${registrar.parameterName})\n`
    + content.slice(registrar.bodyStart)

  await writeFile(absolutePath, insertImport(called, importStatement) ?? called, 'utf8')
  return { modified: true }
}

/**
 * `addRouteRegistrarCall` against the app's routes entry, reporting every outcome —
 * nothing here may be silent, since a routes file that is never mounted looks exactly like
 * a working one until someone requests the route. `routesFile` defaults to
 * {@link DEFAULT_ROUTES_FILE} because most callers scaffold a page-rendering feature; one
 * whose feature works on an API-only app passes an entry from {@link ROUTES_ENTRY_CANDIDATES}.
 */
export async function wireRouteRegistrar(
  functionName: string,
  importStatement: string,
  routesFile: string = DEFAULT_ROUTES_FILE,
): Promise<void> {
  const result = await addRouteRegistrarCall(routesFile, functionName, importStatement)

  if (result.modified) {
    consola.success(`Registered ${functionName}() inside ${routesFile}`)
    return
  }

  if (result.reason === 'Already registered') {
    return
  }

  if (result.reason === PATCH_REASONS.fileNotFound) {
    consola.warn(`Could not find ${routesFile} — import ${functionName} and call it from your route registrar once you add one.`)
    return
  }

  consola.warn(`Could not wire ${functionName}() into ${routesFile}: ${result.reason}.`)
  consola.info(`Import ${functionName} there and call it from your route registrar, passing that registrar's router.`)
}
