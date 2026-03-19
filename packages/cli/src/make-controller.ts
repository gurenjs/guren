import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'

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
  return scaffoldFile(name, {
    dir: CONTROLLERS_DIR,
    suffix: 'Controller',
    template: ({ normalizedName }) => {
      const resourcePath = kebabCase(normalizedName.replace(/Controller$/u, ''))
      return controllerTemplate(normalizedName, resourcePath)
    },
  }, options)
}
