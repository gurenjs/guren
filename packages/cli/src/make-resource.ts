import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'
import { RESOURCES_DIR } from './discovery'

export interface ResourceSourceOptions {
  /** Ends in `Resource`: `guren codegen` discovers a resource by that suffix, and reads `<Base>ResourceData` as its payload. */
  className: string
  modelName: string
  /** Members of the payload interface, unindented. */
  dataFields: readonly string[]
  /** Lines of the object `toArray()` returns, unindented. */
  toArrayFields: readonly string[]
  /** Top-level declarations between the imports and the interface. */
  declarations?: string
}

/** The resource source `make:resource`, `make:feature` and `plan:scaffold` write. */
export function buildResourceSource(options: ResourceSourceOptions): string {
  const { className, modelName } = options
  const lines = (entries: readonly string[], pad: string): string => entries.map((entry) => `${pad}${entry}\n`).join('')
  return `import { Resource } from '@guren/core'
import type { ${modelName}Record } from '../../Models/${modelName}.js'

${options.declarations ? `${options.declarations}\n` : ''}export interface ${className}Data extends Record<string, unknown> {
${lines(options.dataFields, '  ')}}

export class ${className} extends Resource<${modelName}Record, ${className}Data> {
  toArray(): ${className}Data {
    return {
${lines(options.toArrayFields, '      ')}    }
  }
}
`
}

function resourceTemplate(className: string, modelName: string): string {
  return buildResourceSource({
    className,
    modelName,
    dataFields: [`id: ${modelName}Record['id']`],
    toArrayFields: [
      'id: this.resource.id,',
      `// Map the remaining ${modelName}Record columns here. Only call`,
      '// .toISOString() on Date columns — text timestamps are already strings.',
    ],
  })
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
