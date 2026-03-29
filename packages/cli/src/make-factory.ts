import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const FACTORIES_DIR = 'db/factories'

function factoryTemplate(className: string, modelName: string): string {
  return `import { Factory } from '@guren/core'

export default class ${className} extends Factory<typeof ${modelName}> {
  definition() {
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
    dir: FACTORIES_DIR,
    suffix: 'Factory',
    template: ({ normalizedName }) => {
      const modelName = options.model ?? normalizedName.replace(/Factory$/, '')
      return factoryTemplate(normalizedName, modelName)
    },
  }, options)
}
