import type { WriterOptions } from './utils'
import { kebabCase, resourceName, writeFileSafe } from './utils'

const CONTROLLERS_DIR = 'app/Http/Controllers'

function controllerTemplate(className: string, resourcePath: string): string {
  return `import { Controller } from '@guren/server'

export default class ${className} extends Controller {
  async index() {
    // TODO: Replace with real implementation
    return this.inertia('${resourcePath}/Index', { message: '${className} index' })
  }
}
`
}

export async function makeController(name: string, options: WriterOptions = {}): Promise<string> {
  const { className } = resourceName(name)
  const normalizedName = className.endsWith('Controller') ? className : `${className}Controller`
  const resourcePath = kebabCase(normalizedName.replace(/Controller$/u, ''))
  const filePath = `${CONTROLLERS_DIR}/${normalizedName}.ts`
  const contents = controllerTemplate(normalizedName, resourcePath)
  return writeFileSafe(filePath, contents, options)
}
