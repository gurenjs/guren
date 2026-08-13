import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { RESOURCES_DIR } from './discovery'

function resourceTemplate(className: string, modelName: string): string {
  return `import { Resource } from '@guren/core'
import type { ${modelName}Record } from '../../Models/${modelName}.js'

export interface ${className}Data extends Record<string, unknown> {
  id: ${modelName}Record['id']
}

export class ${className} extends Resource<${modelName}Record> {
  toArray(): ${className}Data {
    return {
      id: this.resource.id,
      // Map the remaining ${modelName}Record columns here. Only call
      // .toISOString() on Date columns — text timestamps are already strings.
    }
  }

  override toJSON(): ${className}Data {
    return super.toJSON() as ${className}Data
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
