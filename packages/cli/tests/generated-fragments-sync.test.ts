import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RUNTIME_ROUTE_FUNCTION,
  RUNTIME_SUBSTITUTE_PARAMS_FUNCTION,
  RUNTIME_TYPE_DEFINITIONS,
  RUNTIME_UTILITY_FUNCTIONS,
} from '../src/routes-types-fragments'

const repoRoot = join(import.meta.dir, '../../..')

/**
 * Tracked generated artifacts must carry the current generator's fragments.
 *
 * Nothing else guards this: the starter smokes typecheck the shipped stubs
 * without regenerating them, so a fragment edit that skips the committed
 * `.guren` trees ships starters whose runtime differs from what
 * `guren codegen` produces — and CI stays green. This is how examples/api
 * once kept the pre-fix substitution for a full release cycle.
 */
const TRACKED_ROUTE_MODULES = [
  'packages/create-app/templates/default/.guren/routes.gen.ts',
  'packages/create-app/templates/blog/.guren/routes.gen.ts',
  'examples/api/.guren/routes.gen.ts',
]

const TRACKED_API_CLIENTS = [
  'packages/create-app/templates/default/.guren/api-client.gen.ts',
  'packages/create-app/templates/blog/.guren/api-client.gen.ts',
  'examples/api/.guren/api-client.gen.ts',
]

describe('tracked generated artifacts carry the current fragments', () => {
  it.each(TRACKED_ROUTE_MODULES)('%s', async (relativePath) => {
    const source = await readFile(join(repoRoot, relativePath), 'utf8')

    for (const fragment of [RUNTIME_TYPE_DEFINITIONS, RUNTIME_ROUTE_FUNCTION, RUNTIME_UTILITY_FUNCTIONS]) {
      expect(source).toContain(fragment)
    }
  })

  it.each(TRACKED_API_CLIENTS)('%s', async (relativePath) => {
    const source = await readFile(join(repoRoot, relativePath), 'utf8')

    expect(source).toContain(RUNTIME_SUBSTITUTE_PARAMS_FUNCTION)
  })
})

/**
 * `@guren/inertia-client` has no guren dependencies, so its components
 * hand-mirror two fragment blocks. The mirrors must match character for
 * character — a modifier fix that lands in one and not the other makes the
 * type keys and the emitted `href` disagree across packages.
 */
describe('@guren/inertia-client hand-mirrors match the fragments', () => {
  const componentsPath = join(repoRoot, 'packages/inertia-client/src/components.tsx')

  it('mirrors the param-key types', async () => {
    const source = await readFile(componentsPath, 'utf8')

    const start = RUNTIME_TYPE_DEFINITIONS.indexOf('// Mirrors Hono')
    const end = RUNTIME_TYPE_DEFINITIONS.indexOf('\n\nexport type RouteParams')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    expect(source).toContain(RUNTIME_TYPE_DEFINITIONS.slice(start, end))
  })

  it('mirrors substituteParams', async () => {
    const source = await readFile(componentsPath, 'utf8')

    expect(source).toContain(RUNTIME_SUBSTITUTE_PARAMS_FUNCTION)
  })
})
