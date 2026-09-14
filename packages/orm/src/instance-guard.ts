/**
 * Detects multiple loaded copies of @guren/orm in one process. Model and
 * DrizzleAdapter keep module-level state, so `configureOrm()` configures one
 * copy while models imported through the other fail with "database has not
 * been configured". The runtime cannot merge them, only make it non-silent.
 */
import { isHotReloadRuntime } from './hot-reload-runtime'

const INSTANCE_KEY = Symbol.for('guren.orm.loaded')

interface InstanceMarker {
  count: number
  warned: boolean
  /** Absent only when an older copy wrote the marker, which is itself the duplicate. */
  identities?: Set<string>
}

type GlobalWithMarker = typeof globalThis & {
  [INSTANCE_KEY]?: InstanceMarker
}

const globalScope = globalThis as GlobalWithMarker

/** Empty where a bundler shims `import.meta.url` away, which no copy can be told apart by. */
function moduleIdentity(): string | undefined {
  return import.meta.url || undefined
}

/**
 * Counts this evaluation as a copy unless the same module URL already
 * registered under `bun --hot`, which re-evaluates a file against a surviving
 * `globalThis`. A bundle inlines both copies at one URL, so outside `--hot` a
 * repeat is a duplicate rather than a reload. Any other in-process
 * re-evaluator (a Vite SSR runner, `vi.resetModules()`) still counts.
 */
export function registerOrmInstance(identity: string | undefined): void {
  const marker = (globalScope[INSTANCE_KEY] ??= { count: 0, warned: false, identities: new Set<string>() })
  const identities = (marker.identities ??= new Set<string>())

  if (identity !== undefined) {
    if (identities.has(identity) && isHotReloadRuntime()) {
      return
    }
    identities.add(identity)
  }

  marker.count += 1

  const quiet = typeof process !== 'undefined' && process.env.GUREN_QUIET_DUPLICATE_ORM === '1'
  if (marker.count > 1 && !marker.warned && !quiet) {
    marker.warned = true
    console.warn(
      `[guren/orm] ${marker.count} copies of @guren/orm are loaded in this process. ` +
        'Adapter configuration and model state are NOT shared between copies, so database access will fail ' +
        'with "database has not been configured" for models imported through the extra copy.\n' +
        '[guren/orm] This usually means mixed @guren/* versions (check `bun pm ls | grep @guren`). ' +
        'Fix it by aligning all @guren/* packages to the same release, e.g. `bunx guren upgrade` or ' +
        'updating every @guren/* entry in package.json together, then reinstalling. ' +
        'Set GUREN_QUIET_DUPLICATE_ORM=1 to silence this warning (e.g. monorepo dev where src and dist copies coexist by design).',
    )
  }
}

registerOrmInstance(moduleIdentity())
