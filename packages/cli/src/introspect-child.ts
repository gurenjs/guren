/**
 * The process `introspectApp()` spawns (RFC 0026 §4), run with the app root as
 * cwd and `GUREN_INTROSPECT=1` set before the entry evaluates. The result goes
 * to the file named in argv, never stdout: the app's own modules print there.
 * It exits explicitly, since an app may hold open handles (timers, a Redis client).
 */
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppManifest } from '@guren/server'

import { discoverControllerFiles } from './discovery'
import type { Introspection, IntrospectionFailure } from './introspect'
import { bootstrapApplication, resolveMainEntry } from './runtime'

/** `IntrospectionListenError.code` in `@guren/server`, spelled here: the app may resolve a server older than this CLI's. */
const LISTEN_REFUSED = 'GUREN_INTROSPECT_LISTEN'

const LISTEN_GUIDANCE =
  'The entry calls listen() while it is imported, and introspection never serves. Export the app from src/main.ts '
  + '(`export default app`, with `export const ready = bootstrap()` if it boots) and call listen() from bin/serve.ts, '
  + 'as the scaffold does.'

interface IntrospectableApp {
  introspect?: () => Promise<AppManifest>
  router?: { registeredHandlers?: () => ReadonlyArray<{ index: number; controller?: unknown }> }
}

let listenRefusal: unknown

function isListenRefusal(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LISTEN_REFUSED
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(reason: IntrospectionFailure, message: string): Introspection {
  return { status: 'failed', reason, message }
}

function crashedByListen(error: unknown): Introspection {
  return failed('crashed', `${messageOf(error)} ${LISTEN_GUIDANCE}`)
}

/**
 * Whether the server the app resolves predates `introspect()`, asked before the
 * entry is imported: a scaffolded `src/main.ts` boots at import, and an old
 * server ignores the flag and would run the real boot (migrations, connections).
 */
async function resolvesOldServer(entry: string): Promise<boolean | undefined> {
  const require = createRequire(entry)
  for (const specifier of ['@guren/core', '@guren/server']) {
    let resolved: string
    try {
      resolved = require.resolve(specifier)
    } catch {
      continue
    }
    try {
      const mod = (await import(pathToFileURL(resolved).href)) as { Application?: { prototype?: IntrospectableApp } }
      return typeof mod.Application?.prototype?.introspect !== 'function'
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Upgrades each `name-only` controller reference to the file that exports the
 * very class the router holds (RFC 0026 §3). Files are found by the CLI's one
 * discovery rule; importing them is a module-cache hit after the routes import.
 */
async function resolveControllers(manifest: AppManifest, app: IntrospectableApp, root: string): Promise<void> {
  const handlers = app.router?.registeredHandlers?.() ?? []
  const wanted = new Set<unknown>(handlers.map((handler) => handler.controller).filter((controller) => controller !== undefined))
  if (wanted.size === 0) return

  const exportsOf = new Map<unknown, Array<{ file: string; exportName: string }>>()
  for (const file of await discoverControllerFiles(root)) {
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    } catch (error) {
      manifest.warnings.push({ code: 'controller-import', message: `${relative(root, file)} could not be imported: ${messageOf(error)}` })
      continue
    }
    for (const [exportName, value] of Object.entries(mod)) {
      if (wanted.has(value)) exportsOf.set(value, [...(exportsOf.get(value) ?? []), { file, exportName }])
    }
  }

  for (const handler of handlers) {
    const route = manifest.routes[handler.index]
    const candidates = exportsOf.get(handler.controller)
    if (!route?.controller || !candidates) continue
    // A barrel re-exports the class too; the file named after it declares it.
    const declared = candidates.find(({ file }) => file.replace(/\.[^./\\]+$/u, '').endsWith(route.controller!.name)) ?? candidates[0]!
    route.controller = {
      ...route.controller,
      file: relative(root, declared.file).split('\\').join('/'),
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

  if ((await resolvesOldServer(entry)) === true) {
    return failed('old-server', 'The app resolves a @guren/server without Application.introspect(). Upgrade @guren/core to a release with RFC 0026 introspection.')
  }

  let app: IntrospectableApp
  try {
    app = (await bootstrapApplication(
      (await import(pathToFileURL(entry).href)) as Record<string, unknown>,
    )) as IntrospectableApp
  } catch (error) {
    if (isListenRefusal(error)) return crashedByListen(error)
    const cause = (error as { cause?: unknown } | null)?.cause
    if (isListenRefusal(cause)) return crashedByListen(cause)
    return failed('import', `Could not load ${relative(root, entry)}: ${messageOf(error)}`)
  }

  if (typeof app.introspect !== 'function') {
    return failed('old-server', 'The application has no introspect() method: its @guren/server predates RFC 0026.')
  }

  let manifest: AppManifest
  try {
    manifest = await app.introspect()
  } catch (error) {
    return failed('crashed', messageOf(error))
  }

  manifest.entry.file = relative(root, entry).split('\\').join('/')
  await resolveControllers(manifest, app, root)
  return { status: 'ok', manifest }
}

async function main(): Promise<void> {
  const outFile = process.argv[2]
  if (!outFile) {
    console.error('usage: introspect-child <result-file>')
    process.exit(2)
  }

  // A module-scope `app.listen()` with no await rejects outside any frame we hold.
  process.on('unhandledRejection', (reason) => {
    if (isListenRefusal(reason)) listenRefusal ??= reason
    else console.error('[guren] Unhandled rejection during introspection:', reason)
  })

  let result: Introspection
  try {
    result = await introspect(process.cwd())
  } catch (error) {
    result = failed('crashed', messageOf(error))
  }
  // Let a rejection raised during the last await reach the handler above.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (listenRefusal !== undefined) result = crashedByListen(listenRefusal)

  await writeFile(outFile, JSON.stringify(result))
  process.exit(0)
}

await main()
