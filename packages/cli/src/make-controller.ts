import type { WriterOptions } from './utils'
import { kebabCase, scaffoldFile } from './utils'

const CONTROLLERS_DIR = 'app/Http/Controllers'

function controllerTemplate(className: string, resourcePath: string): string {
  const pageVar = resourcePath.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return `import { Controller } from '@guren/core'
import { pages } from '../../../.guren/pages.gen.js'

export default class ${className} extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.${pageVar}.Index, {
      title: '${className.replace(/Controller$/u, '')}',
    })
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
