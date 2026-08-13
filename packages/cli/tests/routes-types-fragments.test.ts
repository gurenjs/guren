import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATH_PARAM_RUNTIME_HELPERS, PATH_PARAM_TYPE_HELPERS } from '../src/routes-types-fragments'

describe('path-param fragments', () => {
  // The mirrors exist because a shipped library cannot embed an emitted
  // fragment (the PATH_PARAM_TYPE_HELPERS JSDoc has the full story). Each
  // side type-checks on its own, so only this exact-text pin sees drift: a
  // change to either rule fails here until both spellings move together.
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
