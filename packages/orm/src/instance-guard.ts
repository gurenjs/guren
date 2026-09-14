/**
 * Detects multiple loaded copies of @guren/orm in one process. Model and
 * DrizzleAdapter keep module-level state, so `configureOrm()` configures one
 * copy while models imported through the other fail with "database has not
 * been configured". The runtime cannot merge them, only make it non-silent.
 *
 * A copy is identified by the module URL it was evaluated from, because
 * `bun --hot` re-evaluates the same file against a surviving `globalThis` and a
 * count alone reads that as a second copy.
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

/**
 * A bundle inlines both copies at one URL, so a repeated identity there is a
 * duplicate rather than a reload — which is why the identity only excuses a
 * repeat under `--hot`, the one mode that re-evaluates a module at all.
 */
export function registerOrmInstance(identity: string | undefined): void {
  const globalScope = globalThis as GlobalWithMarker
  const marker = globalScope[INSTANCE_KEY]

  if (!marker) {
    globalScope[INSTANCE_KEY] = {
      count: 1,
      warned: false,
      identities: new Set(identity === undefined ? [] : [identity]),
    }
    return
  }

  const identities = (marker.identities ??= new Set<string>())

  if (identity !== undefined && identities.has(identity) && isHotReloadRuntime()) {
    return
  }

  marker.count += 1
  if (identity !== undefined) {
    identities.add(identity)
  }

  const quiet = typeof process !== 'undefined' && process.env.GUREN_QUIET_DUPLICATE_ORM === '1'
  if (!marker.warned && !quiet) {
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

registerOrmInstance(typeof import.meta.url === 'string' && import.meta.url !== '' ? import.meta.url : undefined)
