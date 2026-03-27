import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const PROVIDERS_DIR = 'app/Providers'

function providerTemplate(className: string): string {
  return `import { ServiceProvider } from '@guren/core'

export default class ${className} extends ServiceProvider {
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
