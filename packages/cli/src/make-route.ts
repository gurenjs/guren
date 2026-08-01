import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'
import { singularize } from './inflect'

const ROUTES_DIR = 'routes'

function routeTemplate(prefix: string, controller: string): string {
  return `import { Router } from '@guren/core'
import ${controller} from '../app/Http/Controllers/${controller}.js'

export function registerRoutes(router: Router): void {
  router.group('${prefix}', (group) => {
    group.get('/', [${controller}, 'index'])
  })
}
`
}

export async function makeRoute(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: ROUTES_DIR,
    fileName: ({ fileName }) => fileName,
    template: ({ className, rawName }) => {
      const baseName = singularize(className)
      const controller = baseName.endsWith('Controller') ? baseName : `${baseName}Controller`
      const prefix = `/${kebabCase(rawName)}`
      return routeTemplate(prefix, controller)
    },
  }, options)
}
