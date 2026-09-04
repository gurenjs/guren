import type { CommandClass } from '../console/types'
import type { Router } from '../mvc/Router'
import type { ServiceProviderConstructor } from './ServiceProvider'

/**
 * A self-contained `modules/<name>/` directory registering routes and
 * providers (RFC 0002). Unlike `definePlugin()` it has no config stage and no
 * register/boot lifecycle: `Application` folds the descriptor into its own
 * provider list and route mounting.
 */
export interface ModuleDefinition {
  /** Diagnostic name; also the expected directory name under `modules/`. */
  name: string
  /**
   * URL prefix applied to all module routes via `router.group(prefix, ...)`.
   * Declarative so tooling can read the URL surface without running the registrar.
   */
  prefix?: string
  /** Route registrar, invoked after `options.routes` during boot. */
  routes?: (router: Router) => void | Promise<void>
  /** Providers appended to the application's provider list. */
  providers?: ServiceProviderConstructor[]
  /**
   * Console commands the module owns, for the project's console entrypoint to
   * register (`kernel.registerMany(billingModule.commands)`). Nothing registers
   * them automatically: `Application` never builds a `ConsoleKernel`, and
   * explicit registration keeps a bundled deployment resolving the same set.
   */
  commands?: CommandClass[]
}

/**
 * A module as `Application` consumes it: `providers` and `commands` normalized
 * to arrays, so a console entrypoint reading `commands` cannot hit `undefined`.
 */
export interface GurenModule {
  name: string
  prefix?: string
  routes?: (router: Router) => void | Promise<void>
  providers: ServiceProviderConstructor[]
  commands: CommandClass[]
}

/** Define a Guren application module without boilerplate. */
export function defineModule(definition: ModuleDefinition): GurenModule {
  return {
    name: definition.name,
    prefix: definition.prefix,
    routes: definition.routes,
    providers: definition.providers ?? [],
    commands: definition.commands ?? [],
  }
}

/**
 * Runs a module's route registrar, applying its `prefix` via `router.group()`.
 * Shared by `Application.mountRoutes()` and the CLI's route loader, so both see
 * the same route set. `router.group()`'s callback is synchronous (prefix
 * pushed, callback run, prefix popped), so route calls made after an `await`
 * inside an async prefixed registrar run with the prefix already popped.
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
