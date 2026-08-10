import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ArrowFunctionExpression, File, FunctionDeclaration, FunctionExpression, Statement } from '@babel/types'
import { walk } from './ast-walk'
import { readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import { insertImport, type PatchResult } from './patch-helpers'

/**
 * The export names `@guren/core`'s route loader looks for, in the order it
 * tries them, and the pattern it falls back to.
 *
 * The one rule for "what counts as this app's route registrar", shared with
 * `load-routes.ts`, which resolves the same names at runtime. A scaffolder that
 * decided for itself which function to patch would eventually patch one the
 * framework never calls — the routes would be written, mounted nowhere, and
 * look wired in the file.
 */
export const REGISTRAR_EXPORT_NAMES = [
  'registerRoutes',
  'registerWebRoutes',
  'registerApiRoutes',
  'registerAuthRoutes',
  'default',
] as const

export const REGISTRAR_PATTERN = /^register\w*Routes$/u

/** Conventional routes entry file, shared by every command that loads routes. */
export const DEFAULT_ROUTES_FILE = 'routes/web.ts'

export interface RouteRegistrar {
  /**
   * The name the registrar gave its router parameter. The default app template
   * calls it `router`; the blog template calls it `baseRouter`, because it goes
   * on to declare `const router = baseRouter.aliasMiddleware(...)`.
   */
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
 * Every function this file *exports* that the route loader would accept as the
 * registrar, in source order.
 *
 * Two things decide it, and both come from the loader rather than from shape.
 * The function has to be exported — a local `registerAdminRoutes` helper is
 * never what the framework calls, so patching it writes routes nothing mounts.
 * And the export name has to match, rather than the parameter being
 * `Router`-annotated: the annotation can be an alias (`import { Router as
 * AppRouter }`), and a helper that merely takes a router —
 * `buildPrefix(prefix: string, router: Router)` — is not the entry point, so
 * choosing by shape picks the wrong function and then hands the call that
 * function's first parameter.
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
      // A default export needs no matching name — the loader takes it as-is,
      // including the anonymous `export default function (router) {}` and the
      // `export default registerWebRoutes` indirection.
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
      const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
      if (exported === 'default' || REGISTRAR_PATTERN.test(exported)) {
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
 * Where the app's route registrar keeps its body, and what it named its router.
 *
 * Callers splice text at the returned offsets rather than printing the AST
 * back out, so the rest of the file — formatting, comments, the lot — is
 * untouched. Both values are needed because neither is fixed: patches used to
 * hardcode `router` for both, so a registrar named anything else (the blog
 * template's `baseRouter`) matched nothing and the whole wiring step no-oped.
 * The parameter name is also the only argument a caller may safely pass — a
 * registrar that rebinds its parameter does so with a `const` partway down the
 * body, and a call inserted above that reads it before initialization.
 *
 * Parsed rather than pattern-matched, per the rule in `packages/cli/CLAUDE.md`:
 * reading a signature means reading a grammar, and the regex this replaced got
 * three shapes wrong that Babel gets right for free — a registrar quoted inside
 * a regex literal (which the string mask cannot see into) was patched as if it
 * were real, an overload signature contributed its parameter name to the
 * implementation's body, and only `function` declarations were recognized even
 * though the loader accepts an arrow registrar too. Source Babel cannot parse
 * yields `null`, and callers report that instead of guessing.
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
 * Imports a scaffolded routes file into `routes/web.ts` and calls its registrar
 * from the app's own, in a single write.
 *
 * The call and the import land together on purpose: an import of a registrar
 * nothing calls is an unused binding, which under `noUnusedLocals` stops the
 * scaffolded app compiling, and a call without its import does not resolve. A
 * routes file this cannot patch is left exactly as it was.
 *
 * "Already wired" is decided by looking for a *call* to that name anywhere in
 * the file, not for the rendered `name(router)` text: the argument depends on
 * what the registrar named its parameter, and a text match would append a
 * second call to a file that already had one under a different name.
 */
export async function addRouteRegistrarCall(
  filePath: string,
  functionName: string,
  importStatement: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
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
 * `addRouteRegistrarCall` against the app's `routes/web.ts`, reporting every
 * outcome.
 *
 * Nothing here may be silent. This replaced a `try {} catch {}` around a regex
 * that only matched a registrar whose parameter was literally named `router`:
 * in an app scaffolded from the blog template (`baseRouter`) the scaffolder
 * wrote its routes file, wired nothing, and said nothing — and a routes file
 * that is never mounted looks exactly like a working one until someone requests
 * the route.
 */
export async function wireRouteRegistrar(functionName: string, importStatement: string): Promise<void> {
  const result = await addRouteRegistrarCall(DEFAULT_ROUTES_FILE, functionName, importStatement)

  if (result.modified) {
    consola.success(`Registered ${functionName}() inside ${DEFAULT_ROUTES_FILE}`)
    return
  }

  if (result.reason === 'Already registered') {
    return
  }

  if (result.reason === 'File not found') {
    consola.warn(`Could not find ${DEFAULT_ROUTES_FILE} — import ${functionName} and call it from your route registrar once you add one.`)
    return
  }

  consola.warn(`Could not wire ${functionName}() into ${DEFAULT_ROUTES_FILE}: ${result.reason}.`)
  consola.info(`Import ${functionName} there and call it from your route registrar, passing that registrar's router.`)
}
