import type { ScaffoldFileEntry, WriterOptions } from './utils'
import { coreImportLine, docComment, escapeSingleQuoted, kebabCase, scaffoldFileEntry, writeScaffoldFile } from './utils'
import { ROUTES_DIR } from './discovery'
import { singularize } from './inflect'

/** The one middleware alias the scaffolds know the handler of. */
export const AUTH_ALIAS = 'auth'

/**
 * The {@link AUTH_ALIAS} registration the scaffolds write: bound to a new name, since capturing
 * the return is what puts the alias into the router's type, and the receiver stays usable.
 */
export function authAliasLine(target: string, receiver: string): string {
  return `const ${target} = ${receiver}.aliasMiddleware('${AUTH_ALIAS}', requireAuthenticated({ redirectTo: '/login' }))`
}

/** One route registration: `receiver.method('path', [options, ]handler)` and whatever chains after it. */
export function routeCall(receiver: string, method: string, path: string, handler: string, options?: { contract?: string; chain?: string }): string {
  const contract = options?.contract ? `${options.contract}, ` : ''
  return `${receiver}.${method}('${escapeSingleQuoted(path)}', ${contract}${handler})${options?.chain ?? ''}`
}

export interface RoutesSourceOptions {
  /** Named imports from `@guren/core` beside `Router`, as written. */
  coreImports?: string[]
  /** Whole import lines after the `@guren/core` one. */
  imports: string[]
  registrar: string
  /** A doc comment's lines above the registrar, without the ` * ` prefix. */
  comment?: string[]
  /** The registrar body's lines, unindented. */
  body: string[]
}

/** A routes file exporting one registrar: `make:route`'s, and the one `plan:scaffold` writes per entity. */
export function buildRoutesSource(options: RoutesSourceOptions): string {
  const comment = options.comment ? docComment(options.comment) : ''
  const body = options.body.map((line) => (line ? `  ${line}` : '')).join('\n')
  return `${coreImportLine(['Router', ...(options.coreImports ?? [])])}
${options.imports.join('\n')}

${comment}export function ${options.registrar}(router: Router): void {
${body}
}
`
}

function routeTemplate(prefix: string, controller: string): string {
  return buildRoutesSource({
    imports: [`import ${controller} from '../app/Http/Controllers/${controller}.js'`],
    registrar: 'registerRoutes',
    body: [`router.group('${prefix}', (group) => {`, `  ${routeCall('group', 'get', '/', `[${controller}, 'index']`)}`, '})'],
  })
}

export async function makeRoute(name: string, options: WriterOptions = {}): Promise<string> {
  const { path, contents } = routeFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

/** What `make:route` writes, for the plan check that compares it with the routes file `plan:scaffold` writes. */
export function routeFile(name: string, options: WriterOptions = {}): ScaffoldFileEntry {
  return scaffoldFileEntry(name, {
    dir: ROUTES_DIR,
    fileName: ({ fileName }) => fileName,
    template: ({ className, rawName }) => routeTemplate(`/${kebabCase(rawName)}`, routeGroupController(className)),
  }, options)
}

/** The controller a `make:route` group imports. */
export function routeGroupController(className: string): string {
  const baseName = singularize(className)
  return baseName.endsWith('Controller') ? baseName : `${baseName}Controller`
}
