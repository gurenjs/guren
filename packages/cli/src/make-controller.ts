import { isConfirmedApiOnlyApp } from './app-surface'
import type { WriterOptions } from './utils'
import { kebabCase, pagesAccessor, safeModuleName, scaffoldFile, writeRoot } from './utils'

const CONTROLLERS_DIR = 'app/Http/Controllers'

function inertiaControllerTemplate(className: string, resourcePath: string, moduleName: string | undefined): string {
  const pageVar = resourcePath.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class ${className} extends Controller {
  async index(): Promise<Response> {
    return this.inertia(${pagesAccessor(moduleName, pageVar)}.Index, {
      title: '${className.replace(/Controller$/u, '')}',
    })
  }
}
`
}

/** The dialect for an app `isConfirmedApiOnlyApp` recognizes. */
function jsonControllerTemplate(className: string): string {
  return `import { Controller } from '@guren/core'

export default class ${className} extends Controller {
  async index(): Promise<Response> {
    return this.json({
      data: [],
    })
  }
}
`
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
