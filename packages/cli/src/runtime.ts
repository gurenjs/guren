import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'

const MAIN_ENTRY_CANDIDATES = [
  'src/main.ts',
  'src/main.mts',
  'src/main.js',
  'src/main.mjs',
  'dist/main.js',
]

export type MaybeApplication = {
  listen?: (options?: { port?: number; hostname?: string }) => unknown
}

export async function resolveMainEntry(): Promise<string> {
  const cwd = process.cwd()

  for (const candidate of MAIN_ENTRY_CANDIDATES) {
    const absolute = resolve(cwd, candidate)
    try {
      await access(absolute)
      return absolute
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }
  }

  throw new Error('Could not locate an application entry point (expected one of src/main.{ts,js} or dist/main.js).')
}

export async function bootstrapApplication(mod: Record<string, unknown>): Promise<MaybeApplication> {
  const results: Array<unknown> = []

  const ready = mod.ready
  if (ready && typeof (ready as Promise<unknown>).then === 'function') {
    try {
      results.push(await ready)
    } catch (error) {
      throw new Error(`Application ready() promise rejected: ${String(error)}`)
    }
  }

  if (typeof mod.bootstrap === 'function') {
    results.push(await (mod.bootstrap as () => Promise<unknown>)())
  }

  const candidates = [
    ...results,
    mod.default,
    (mod as { app?: unknown }).app,
  ]

  for (const candidate of candidates) {
    if (candidate && typeof (candidate as MaybeApplication).listen === 'function') {
      return candidate as MaybeApplication
    }
  }

  throw new Error('Application entry must export a default or ready/bootstrap that yields an object with a listen() method.')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

function moduleHandlesBoot(moduleExports: Record<string, unknown>): boolean {
  const ready = moduleExports.ready
  if (isPromiseLike(ready)) {
    return true
  }

  const bootstrap = moduleExports.bootstrap
  return typeof bootstrap === 'function'
}

export async function ensureApplicationBooted(app: MaybeApplication, moduleExports: Record<string, unknown>): Promise<void> {
  if (moduleHandlesBoot(moduleExports)) {
    return
  }

  const maybeBoot = (app as { boot?: () => Promise<void> }).boot
  if (typeof maybeBoot !== 'function') {
    return
  }

  try {
    await maybeBoot.call(app)
  } catch (error) {
    consola.warn('Application boot() rejected:', error)
  }
}

export async function importFirstAvailableApplicationModule(paths: string[]): Promise<{ module: Record<string, unknown>; path: string } | undefined> {
  const cwd = process.cwd()

  for (const relative of paths) {
    const absolute = resolve(cwd, relative)

    try {
      await access(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }

    try {
      const module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
      return { module, path: absolute }
    } catch (error) {
      consola.warn(`Failed to import ${relative}:`, error)
    }
  }

  return undefined
}
