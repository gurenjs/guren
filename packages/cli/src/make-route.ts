import type { WriterOptions } from './utils'
import { kebabCase, resourceName, writeFileSafe } from './utils'

const ROUTES_DIR = 'routes'

function routeTemplate(prefix: string, controller: string): string {
  return `import { Route } from '@guren/server'
import ${controller} from '../app/Http/Controllers/${controller}.js'

export default Route.group('${prefix}', () => {
  Route.get('/', [${controller}, 'index'])
})
`
}

export async function makeRoute(name: string, options: WriterOptions = {}): Promise<string> {
  const { className, fileName } = resourceName(name)
  const controller = className.endsWith('Controller') ? className : `${className}Controller`
  const prefix = `/${kebabCase(name)}`
  const filePath = `${ROUTES_DIR}/${fileName}.ts`
  return writeFileSafe(filePath, routeTemplate(prefix, controller), options)
}
