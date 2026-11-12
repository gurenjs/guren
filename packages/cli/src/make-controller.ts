import { resolve } from 'node:path'
import { isConfirmedApiOnlyApp } from './app-surface'
import { CONTROLLERS_DIR } from './discovery'
import { PAGE_COMPONENT_EXTENSIONS } from './inertia-pages'
import type { WriterOptions } from './utils'
import {
  coreImportLine,
  docComment,
  ensureSuffix,
  kebabCase,
  pagesAccessor,
  pathExists,
  resourceName,
  safeModuleName,
  scaffoldFile,
  writeRoot,
} from './utils'

const PAGES_DIR = 'resources/js/pages'

export interface ControllerActionSource {
  name: string
  /** Comment lines above the method, without the `//`. A line terminator inside one is written as a space. */
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

// ECMAScript's line terminators, each of which ends a `//` comment: one inside a line from a plan string would continue as code.
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/gu

/** The controller `make:controller` and `make:feature` write, and `plan:scaffold` with the plan's actions as stubs. */
export function buildControllerSource(options: ControllerSourceOptions): string {
  const imports = [coreImportLine(['Controller', ...(options.coreImports ?? [])]), ...(options.imports ?? [])].join('\n')
  const declarations = (options.declarations ?? []).map((declaration) => `${declaration}\n\n`).join('')
  const classComment = options.classComment ? docComment(options.classComment) : ''
  const actions = options.actions.map((action) => {
    const comment = (action.comment ?? []).map((line) => `  // ${line.replace(LINE_TERMINATORS, ' ')}\n`).join('')
    return `${comment}  async ${action.name}(): Promise<Response> {\n${action.body}\n  }`
  })
  return `${imports}

${declarations}${classComment}export default class ${options.className} extends Controller {
${actions.join('\n\n')}
}
`
}

/**
 * The directories of the page the scaffolded `index()` renders, under the pages
 * root. A key of `.guren/pages.gen.ts` is the directory name as written, so
 * these are the accessor's keys (`userProfile`, below the module's name).
 */
function controllerPageDirs(className: string, moduleName: string | undefined): string[] {
  const resourcePath = kebabCase(className.replace(/Controller$/u, ''))
  const pageVar = resourcePath.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return moduleName ? [moduleName, pageVar] : [pageVar]
}

function inertiaControllerTemplate(className: string, moduleName: string | undefined): string {
  return buildControllerSource({
    className,
    imports: [`import { pages } from '@/.guren/pages.gen'`],
    actions: [
      {
        name: 'index',
        body: `    return this.inertia(${pagesAccessor(...controllerPageDirs(className, moduleName))}.Index, {}, {
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
      return inertiaControllerTemplate(normalizedName, moduleName)
    },
  }, { ...options, cwd: appRoot })
}

/**
 * What `make:controller` leaves to do: the page its `index()` renders, while no
 * file provides it. The app does not typecheck until one does, and the path is
 * not the one `make:view <name>/Index --module` writes, which ignores the module.
 */
export async function controllerNextStep(name: string, options: WriterOptions = {}): Promise<string | undefined> {
  const appRoot = writeRoot(options)
  if (await isConfirmedApiOnlyApp(appRoot)) return undefined
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const dirs = controllerPageDirs(ensureSuffix(resourceName(name).className, 'Controller'), moduleName)
  const view = [...dirs, 'Index'].join('/')
  for (const extension of PAGE_COMPONENT_EXTENSIONS) {
    if (await pathExists(resolve(appRoot, PAGES_DIR, `${view}${extension}`))) return undefined
  }
  return (
    `Its index() renders ${pagesAccessor(...dirs)}.Index, which no page provides yet, so the app does not `
    + `typecheck until one does: bunx guren make:view ${view}`
  )
}
