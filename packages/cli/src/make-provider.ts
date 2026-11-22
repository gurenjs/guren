import { PROVIDERS_DIR } from './discovery'
import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

export function providerTemplate(className: string): string {
  // A provider named after its base class would shadow the import it extends.
  const base = className === 'ServiceProvider' ? 'BaseServiceProvider' : 'ServiceProvider'
  const imported = base === 'ServiceProvider' ? 'ServiceProvider' : `ServiceProvider as ${base}`
  return `import { ${imported} } from '@guren/core'

export default class ${className} extends ${base} {
  register(): void {
  }

  boot(): void {
  }
}
`
}

export async function makeProvider(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: PROVIDERS_DIR,
    suffix: 'Provider',
    template: ({ normalizedName }) => providerTemplate(normalizedName),
  }, options)
}
