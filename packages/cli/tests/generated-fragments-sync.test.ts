import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PATH_PARAM_RUNTIME_HELPERS,
  PATH_PARAM_TYPE_HELPERS,
  RUNTIME_ROUTE_FUNCTION,
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
 * once kept the pre-fix substitution for a full release cycle: it has no
 * `.guren.gitignore` (examples/blog does — see its `.gitignore`), so it is
 * tracked and in scope here.
 *
 * The inertia-client hand-mirror itself is pinned by
 * routes-types-fragments.test.ts, in the same package as the fragments it
 * mirrors; this file only covers the artifacts that pin isn't positioned to
 * see.
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

    expect(source).toContain(PATH_PARAM_TYPE_HELPERS)
    expect(source).toContain(PATH_PARAM_RUNTIME_HELPERS)
  })
})
