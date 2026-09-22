import { DB_ARTIFACT_DIRS } from './discovery'
import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

// `Factory<T>` is typed over the *record*: `definition()` returns its attributes.
function factoryTemplate(className: string, modelName: string): string {
  return `import { Factory } from '@guren/core'
import type { ${modelName}Record } from '../../app/Models/${modelName}.js'

export default class ${className} extends Factory<${modelName}Record> {
  definition(): Partial<${modelName}Record> {
    return {}
  }
}
`
}

export interface MakeFactoryOptions extends WriterOptions {
  model?: string
}

export async function makeFactory(name: string, options: MakeFactoryOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: DB_ARTIFACT_DIRS.Factory,
    suffix: 'Factory',
    template: ({ normalizedName }) => {
      const modelName = options.model ?? normalizedName.replace(/Factory$/, '')
      return factoryTemplate(normalizedName, modelName)
    },
  }, options)
}
