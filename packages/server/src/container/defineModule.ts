import type { Router } from '../mvc/Router'
import type { ServiceProviderConstructor } from './ServiceProvider'

/**
 * Declarative definition of an application module — a self-contained
 * `modules/<name>/` directory that can register routes and providers, per
 * RFC 0002. Unlike `definePlugin()`, a module has no config stage and no
 * register/boot lifecycle of its own: it's a plain descriptor bundling
 * providers and a route registrar that `Application` folds into its own
 * provider list and route mounting.
 */
export interface ModuleDefinition {
  /** Diagnostic name; also the expected directory name under `modules/`. */
  name: string
  /**
   * URL prefix applied to all module routes via `router.group(prefix, ...)`.
   * Declarative on purpose — tooling can read a module's URL surface
   * statically without executing the registrar.
   */
  prefix?: string
  /** Route registrar, invoked after `options.routes` during boot. */
  routes?: (router: Router) => void | Promise<void>
  /** Providers appended to the application's provider list. */
  providers?: ServiceProviderConstructor[]
}

/**
 * A module as `Application` consumes it — `providers` normalized to always
 * be an array so callers don't repeat the `?? []` fallback.
 */
export interface GurenModule {
  name: string
  prefix?: string
  routes?: (router: Router) => void | Promise<void>
  providers: ServiceProviderConstructor[]
}

/**
 * Define a Guren application module without boilerplate.
 *
 * @example
 * ```typescript
 * // modules/billing/index.ts
 * export const billingModule = defineModule({
 *   name: 'billing',
 *   prefix: '/billing',
 *   routes: registerBillingRoutes,
 *   providers: [BillingServiceProvider],
 * })
 *
 * // src/app.ts
 * createApp({ routes, providers, modules: [billingModule] })
 * ```
 */
export function defineModule(definition: ModuleDefinition): GurenModule {
  return {
    name: definition.name,
    prefix: definition.prefix,
    routes: definition.routes,
    providers: definition.providers ?? [],
  }
}

/**
 * Runs a module's route registrar against `router`, applying its `prefix`
 * via `router.group()` when set. Shared by `Application.mountRoutes()` (at
 * boot) and the CLI's route loader (for `guren codegen`/`audit`/`routes`/
 * `openapi:generate`, which need the same route set without booting a real
 * app) so both stay in sync — a bugfix to one path fixes the other.
 *
 * `router.group(prefix, callback)`'s callback is synchronous — it pushes
 * the prefix, invokes the callback, then pops it, with no support for
 * awaiting inside. Capturing the registrar's return value and awaiting it
 * after `group()` returns preserves prefixing for the common case (a
 * synchronous registrar, or an async one that calls `router.get`/`post`/
 * etc. before its first `await`); route calls after an `await` inside an
 * async, prefixed module registrar would run with the prefix already
 * popped. Registrars with no prefix don't go through group() and have no
 * such limitation.
 */
export async function mountModuleRoutes(router: Router, gurenModule: GurenModule): Promise<void> {
  const registrar = gurenModule.routes
  if (!registrar) return

  if (!gurenModule.prefix) {
    await registrar(router)
    return
  }

  let pending: void | Promise<void> = undefined
  router.group(gurenModule.prefix, (grouped) => {
    pending = registrar(grouped)
  })
  await pending
}
