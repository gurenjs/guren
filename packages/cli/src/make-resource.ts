import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const RESOURCES_DIR = 'app/Http/Resources'

function resourceTemplate(className: string, modelName: string): string {
  return `import { Resource } from '@guren/server'

export default class ${className} extends Resource<${modelName}> {
  toArray() {
    return {
      id: this.resource.id,
      // Add your resource fields here
      createdAt: this.resource.createdAt?.toISOString(),
      updatedAt: this.resource.updatedAt?.toISOString(),
    }
  }
}
`
}

export interface MakeResourceOptions extends WriterOptions {
  model?: string
}

export async function makeResource(name: string, options: MakeResourceOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: RESOURCES_DIR,
    suffix: 'Resource',
    template: ({ normalizedName }) => {
      const modelName = options.model ?? normalizedName.replace(/Resource$/, '')
      return resourceTemplate(normalizedName, modelName)
    },
  }, options)
}
