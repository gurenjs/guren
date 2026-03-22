import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const PROVIDERS_DIR = 'app/Providers'

function providerTemplate(className: string): string {
  return `import { ServiceProvider, type Container } from '@guren/core'

export default class ${className} extends ServiceProvider {
  /**
   * Register any application services.
   * This method is called before all providers are booted.
   */
  register(): void {
    // Bind services to the container
    // this.container.singleton('myService', () => new MyService())
    // this.container.bind('helper', (c) => new Helper(c.make('config')))
  }

  /**
   * Bootstrap any application services.
   * This method is called after all providers have been registered.
   */
  boot(): void {
    // Perform any bootstrapping after all services are registered
    // const config = this.container.make('config')
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
