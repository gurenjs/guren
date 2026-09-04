import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATH_PARAM_RUNTIME_HELPERS, PATH_PARAM_TYPE_HELPERS } from '../src/routes-types-fragments'

describe('path-param fragments', () => {
  // A shipped library cannot embed an emitted fragment (see the
  // PATH_PARAM_TYPE_HELPERS JSDoc). Each side type-checks on its own, so only
  // this exact-text pin sees drift.
  for (const [name, fragment] of [
    ['PATH_PARAM_TYPE_HELPERS', PATH_PARAM_TYPE_HELPERS],
    ['PATH_PARAM_RUNTIME_HELPERS', PATH_PARAM_RUNTIME_HELPERS],
  ] as const) {
    it(`${name} is mirrored verbatim by @guren/inertia-client components.tsx`, async () => {
      const componentsSource = await readFile(
        join(import.meta.dir, '../../inertia-client/src/components.tsx'),
        'utf8',
      )

      expect(componentsSource).toContain(fragment)
    })
  }
})
