/**
 * The process `introspectApp()` spawns (RFC 0026 §4), run with the app root as
 * cwd and `GUREN_INTROSPECT=1` set before the entry evaluates. The result goes
 * to the file named in argv, never stdout: the app's own modules print there.
 * It exits explicitly, since an app may hold open handles (timers, a Redis client).
 */
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppManifest, AttachmentsDescription } from '@guren/server'

import { classNameFromPath, discoverControllerFiles, toPosixRelative } from './discovery'
import { controllerImportWarning, pickDeclaringFile } from './introspect-controller-file'
import type { Introspection, IntrospectionFailure } from './introspect'
import { bootstrapApplication, resolveMainEntry } from './runtime'

/** `IntrospectionListenError.code` in `@guren/server`, spelled here: the app may resolve a server older than this CLI's. */
const LISTEN_REFUSED = 'GUREN_INTROSPECT_LISTEN'

const LISTEN_GUIDANCE =
  'The entry calls listen() while it is imported, which GUREN_INTROSPECT=1 refuses: introspection never serves. '
  + 'Export the app from src/main.ts (`export default app`, with `export const ready = bootstrap()` if it boots) '
  + 'and call listen() from bin/serve.ts, as the scaffold does.'

interface IntrospectableApp {
  introspect?: () => Promise<AppManifest>
  router?: {
    registeredHandlers?: () => ReadonlyArray<{ index: number; controller?: unknown }>
    hasRoute?: (name: string) => boolean
  }
}

/** What the child needs of the `@guren/core` / `@guren/server` the app resolves. */
interface FrameworkModule {
  Application?: { prototype?: IntrospectableApp & { listen?: (...args: unknown[]) => unknown } }
  describeActiveAttachmentEngine?: () => AttachmentsDescription
}

const outFile = process.argv[2]
/** The controller file being imported, beside the result, so the parent can name where a timeout struck. */
const scanFile = `${outFile}.scanning`
/** True until the controller scan: only the entry's `listen()` refusal fails the run. */
let loadingApp = true
/** Where each `listen()` call happened, recorded when it is made rather than when its rejection lands. */
const listenCalls: Array<'app' | 'scan'> = []

/**
 * Records the phase of every `listen()` on the framework's `Application`, the
 * same class object the entry's app is built from. The refusal it then throws
 * is judged here, whenever its unhandled rejection is delivered.
 */
function watchListen(framework: FrameworkModule): void {
  const prototype = framework.Application?.prototype
  const listen = prototype?.listen
  if (!prototype || typeof listen !== 'function') return
  prototype.listen = function (this: unknown, ...args: unknown[]) {
    listenCalls.push(loadingApp ? 'app' : 'scan')
    return listen.apply(this, args)
  }
}

/** One macrotask: pending microtasks, and the `unhandledRejection` events they raise, run before it. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The refusal itself or anywhere in its `cause` chain: `bootstrapApplication()` wraps a rejected `ready`. */
function isListenRefusal(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    if ((current as { code?: unknown }).code === LISTEN_REFUSED) return true
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(reason: IntrospectionFailure, message: string): Introspection {
  return { status: 'failed', reason, message }
}

/**
 * The framework modules the entry resolves, loaded before the entry is imported:
 * a scaffolded `src/main.ts` boots at import, and a server without `introspect()`
 * would run the real boot. Resolved as the entry's own imports are (Bun, ESM
 * conditions); a module that will not resolve or load is a failure, not a pass.
 */
async function loadFramework(entry: string): Promise<{ framework: FrameworkModule } | Introspection> {
  for (const specifier of ['@guren/core', '@guren/server']) {
    let resolved: string
    try {
      resolved = Bun.resolveSync(specifier, dirname(entry))
    } catch {
      continue
    }
    let framework: FrameworkModule
    try {
      framework = (await import(pathToFileURL(resolved).href)) as FrameworkModule
    } catch (error) {
      return failed('crashed', `${specifier} resolved from the entry but did not load: ${messageOf(error)}`)
    }
    if (typeof framework.Application?.prototype?.introspect !== 'function') {
      return failed('old-server', 'The app resolves a @guren/server without Application.introspect(). Upgrade @guren/core to a release with RFC 0026 introspection.')
    }
    return { framework }
  }
  return failed('crashed', 'Neither @guren/core nor @guren/server resolves from the entry, so the app cannot be introspected.')
}

/**
 * Upgrades each `name-only` controller reference to the file that exports the
 * very class the router holds (RFC 0026 §3). A framework class (core's delivery
 * controller) keeps `name-only`. App files are found by the CLI's one discovery
 * rule, those named after a routed class first (a module-cache hit); the rest
 * are imported only while an app class is still unmatched.
 */
async function resolveControllers(
  manifest: AppManifest,
  app: IntrospectableApp,
  root: string,
  framework: FrameworkModule,
): Promise<void> {
  // Core re-exports server, so one module holds every framework class a route can name.
  const frameworkExports = new Set<unknown>(Object.values(framework))
  const handlers = app.router?.registeredHandlers?.() ?? []
  const wanted = new Set<unknown>(handlers
    .map((handler) => handler.controller)
    .filter((controller) => controller !== undefined && !frameworkExports.has(controller)))
  if (wanted.size === 0) return

  const routedNames = new Set(handlers.map((handler) => manifest.routes[handler.index]?.controller?.name))
  const files = await discoverControllerFiles(root)
  const named = files.filter((file) => routedNames.has(classNameFromPath(file)))
  const exportsOf = new Map<unknown, Array<{ file: string; exportName: string }>>()

  const scan = async (batch: string[]): Promise<void> => {
    for (const file of batch) {
      writeFileSync(scanFile, toPosixRelative(root, file))
      let mod: Record<string, unknown>
      try {
        mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
      } catch (error) {
        manifest.warnings.push(controllerImportWarning(toPosixRelative(root, file), messageOf(error)))
        continue
      }
      for (const [exportName, value] of Object.entries(mod)) {
        if (wanted.has(value)) exportsOf.set(value, [...(exportsOf.get(value) ?? []), { file, exportName }])
      }
    }
  }

  await scan(named)
  if ([...wanted].some((controller) => !exportsOf.has(controller))) {
    await scan(files.filter((file) => !named.includes(file)))
  }

  for (const handler of handlers) {
    const route = manifest.routes[handler.index]
    const candidates = exportsOf.get(handler.controller)
    if (!route?.controller || !candidates) continue
    const declared = pickDeclaringFile(candidates, route.controller.name)
    if (!declared) continue
    route.controller = {
      ...route.controller,
      file: toPosixRelative(root, declared.file),
      exportName: declared.exportName,
      resolved: 'identity',
    }
  }
}

async function introspect(root: string): Promise<Introspection> {
  let entry: string
  try {
    entry = await resolveMainEntry(root)
  } catch (error) {
    return failed('no-entry', messageOf(error))
  }

  const loaded = await loadFramework(entry)
  if ('status' in loaded) return loaded
  watchListen(loaded.framework)

  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  } catch (error) {
    if (isListenRefusal(error)) return failed('crashed', LISTEN_GUIDANCE)
    return failed('import', `Could not load ${toPosixRelative(root, entry)}: ${messageOf(error)}`)
  }

  // Past the import, a throw is a failure to register: `main()` reports it as `crashed`.
  const app = (await bootstrapApplication(mod)) as IntrospectableApp
  if (typeof app.introspect !== 'function') {
    return failed('old-server', 'The application has no introspect() method: its @guren/server predates RFC 0026, and its boot() may already have run.')
  }

  const manifest = await app.introspect()
  manifest.entry.file = toPosixRelative(root, entry)
  describeUnboundAttachments(manifest, app, loaded.framework)
  loadingApp = false
  await resolveControllers(manifest, app, root, loaded.framework)
  return { status: 'ok', manifest }
}

/**
 * The documented fallback when no provider binds the engine: the one
 * `configureAttachments()` built last, which only core can read, so the server's
 * manifest cannot (RFC 0026 §1, amended).
 */
function describeUnboundAttachments(manifest: AppManifest, app: IntrospectableApp, framework: FrameworkModule): void {
  // A section the server warned about is bound somewhere it could not read; the fallback would contradict it.
  const warned = manifest.warnings.some((warning) => warning.code.startsWith('section-') && warning.message.startsWith('"attachments"'))
  if (manifest.attachments || warned) return
  const description = framework.describeActiveAttachmentEngine?.()
  if (!description?.configured) return
  const { delivery, ...rest } = description
  manifest.attachments = delivery
    ? { ...rest, delivery: { ...delivery, mounted: app.router?.hasRoute?.(delivery.routeName) ?? false } }
    : rest
}

/** The CLI holds this pipe open for the run; its end means the CLI is gone, however it died. */
function dieWithParent(): void {
  process.stdin.on('end', () => {
    try {
      process.kill(-process.pid, 'SIGKILL')
    } catch {
      process.exit(1)
    }
  })
  process.stdin.resume()
}

async function main(): Promise<void> {
  if (!outFile) {
    console.error('usage: introspect-child <result-file>')
    process.exit(2)
  }

  dieWithParent()
  const otherRejections: string[] = []
  // A module-scope `app.listen()` with no await rejects outside any frame we hold;
  // `listenCalls` already says where it was made.
  process.on('unhandledRejection', (reason) => {
    if (!isListenRefusal(reason)) otherRejections.push(messageOf(reason))
  })

  let result: Introspection
  try {
    result = await introspect(process.cwd())
  } catch (error) {
    result = isListenRefusal(error) ? failed('crashed', LISTEN_GUIDANCE) : failed('crashed', messageOf(error))
  }
  // Let a rejection raised during the last await reach the handler above.
  await tick()
  if (listenCalls.includes('app')) result = failed('crashed', LISTEN_GUIDANCE)
  // `bun run dev` would have died on these; a manifest must not read clean past them.
  if (result.status === 'ok') {
    if (listenCalls.includes('scan')) {
      otherRejections.push('A controller file called listen() while it was imported, which introspection refuses.')
    }
    for (const message of otherRejections) result.manifest.warnings.push({ code: 'unhandled-rejection', message })
  }

  await writeFile(outFile, JSON.stringify(result))
  process.exit(0)
}

await main()
