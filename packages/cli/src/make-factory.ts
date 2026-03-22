import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const FACTORIES_DIR = 'db/factories'

function factoryTemplate(className: string, modelName: string): string {
  return `import { Factory } from '@guren/core'
// import { ${modelName} } from 'db/schema'

export default class ${className} extends Factory<typeof ${modelName}> {
  definition() {
    return {
      // Add your factory definition here
      // name: this.faker.person.fullName(),
      // email: this.faker.internet.email(),
    }
  }

  // Optional: Add states for variations
  // admin() {
  //   return this.state({
  //     role: 'admin',
  //   })
  // }
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
