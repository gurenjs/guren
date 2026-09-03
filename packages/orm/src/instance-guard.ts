/**
 * Detects multiple loaded copies of @guren/orm in one process. Model and
 * DrizzleAdapter keep module-level state, so `configureOrm()` configures one
 * copy while models imported through the other fail with "database has not
 * been configured". The runtime cannot merge them, only make it non-silent.
 */
const INSTANCE_KEY = Symbol.for('guren.orm.loaded')

type GlobalWithMarker = typeof globalThis & {
  [INSTANCE_KEY]?: { count: number; warned: boolean }
}

const globalScope = globalThis as GlobalWithMarker

const marker = globalScope[INSTANCE_KEY]

if (!marker) {
  globalScope[INSTANCE_KEY] = { count: 1, warned: false }
} else {
  marker.count += 1
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

export {}
