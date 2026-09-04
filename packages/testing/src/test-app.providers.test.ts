import { describe, expect, it } from 'vitest'
import type { Container, ServiceProviderConstructor } from '@guren/server'
import type { TestAppOptions } from './test-app'

/**
 * Mirrors a scaffolded `app/Providers/DatabaseProvider.ts`, whose inherited
 * constructor takes a concrete `Container`: constructor parameters are
 * contravariant, so an option typed `new (...args: unknown[]) => ...` rejects it.
 * Written structurally so the check is pure `tsc`, with no built `@guren/server`.
 */
class DatabaseProvider {
  constructor(protected container: Container) {}

  register(): void {}

  async boot(): Promise<void> {}
}

describe('TestAppOptions.providers', () => {
  it('accepts an ordinary ServiceProvider subclass', () => {
    // The assignability *is* the assertion: this file fails `tsc --noEmit`
    // if `providers` narrows back to a constructor taking `unknown` args.
    const options: TestAppOptions = { providers: [DatabaseProvider] }

    expect(options.providers).toEqual([DatabaseProvider])
  })

  it('accepts the constructor type the framework hands around', () => {
    // Every plugin factory returns this type (`definePlugin`), so it has to
    // fit the option too, not just hand-written subclasses.
    const providers: TestAppOptions['providers'] = [] as ServiceProviderConstructor[]

    expect(providers).toEqual([])
  })
})
