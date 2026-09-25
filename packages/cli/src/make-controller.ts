import { isConfirmedApiOnlyApp } from './app-surface'
import { CONTROLLERS_DIR } from './discovery'
import type { WriterOptions } from './utils'
import { coreImportLine, docComment, kebabCase, pagesAccessor, safeModuleName, scaffoldFile, writeRoot } from './utils'

export interface ControllerActionSource {
  name: string
  /** Comment lines above the method, without the `//`. */
  comment?: string[]
  /** The statements inside the method, each line indented four spaces. */
  body: string
}

export interface ControllerSourceOptions {
  className: string
  /** Named imports from `@guren/core` after `Controller`, as written (`type X` included). */
  coreImports?: string[]
  /** Whole import lines after the `@guren/core` one. */
  imports?: string[]
  /** Top-level declarations between the imports and the class, each followed by a blank line. */
  declarations?: string[]
  /** A doc comment's lines above the class, without the ` * ` prefix. */
  classComment?: string[]
  actions: ControllerActionSource[]
}

/** The controller `make:controller` and `make:feature` write, and `plan:scaffold` with the plan's actions as stubs. */
export function buildControllerSource(options: ControllerSourceOptions): string {
  const imports = [coreImportLine(['Controller', ...(options.coreImports ?? [])]), ...(options.imports ?? [])].join('\n')
  const declarations = (options.declarations ?? []).map((declaration) => `${declaration}\n\n`).join('')
  const classComment = options.classComment ? docComment(options.classComment) : ''
  const actions = options.actions.map((action) => {
    const comment = (action.comment ?? []).map((line) => `  // ${line}\n`).join('')
    return `${comment}  async ${action.name}(): Promise<Response> {\n${action.body}\n  }`
  })
  return `${imports}

${declarations}${classComment}export default class ${options.className} extends Controller {
${actions.join('\n\n')}
}
`
}

function inertiaControllerTemplate(className: string, resourcePath: string, moduleName: string | undefined): string {
  const pageVar = resourcePath.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return buildControllerSource({
    className,
    imports: [`import { pages } from '@/.guren/pages.gen'`],
    actions: [
      {
        name: 'index',
        body: `    return this.inertia(${pagesAccessor(moduleName, pageVar)}.Index, {}, {
      title: '${className.replace(/Controller$/u, '')}',
    })`,
      },
    ],
  })
}

/** The dialect for an app `isConfirmedApiOnlyApp` recognizes. */
function jsonControllerTemplate(className: string): string {
  return buildControllerSource({
    className,
    actions: [
      {
        name: 'index',
        body: `    return this.json({
      data: [],
    })`,
      },
    ],
  })
}

/**
 * Adapts rather than refuses on an API-only app, unlike the multi-file
 * scaffolds: the Inertia template imports a `@/.guren/pages.gen` codegen never
 * writes there, so JSON is what such an app asked for.
 */
export async function makeController(name: string, options: WriterOptions = {}): Promise<string> {
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  // Resolved once and handed to the write too: a relative `cwd` re-resolved
  // after the probe's awaits could name a different app than the one judged.
  const appRoot = writeRoot(options)
  const apiOnly = await isConfirmedApiOnlyApp(appRoot)
  return scaffoldFile(name, {
    dir: CONTROLLERS_DIR,
    suffix: 'Controller',
    template: ({ normalizedName }) => {
      if (apiOnly) {
        return jsonControllerTemplate(normalizedName)
      }
      const resourcePath = kebabCase(normalizedName.replace(/Controller$/u, ''))
      return inertiaControllerTemplate(normalizedName, resourcePath, moduleName)
    },
  }, { ...options, cwd: appRoot })
}
