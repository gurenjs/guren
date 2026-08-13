import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATH_PARAM_TYPE_HELPERS } from '../src/routes-types-fragments'

describe('PATH_PARAM_TYPE_HELPERS', () => {
  // The mirror exists because a shipped library cannot embed an emitted
  // fragment (the PATH_PARAM_TYPE_HELPERS JSDoc has the full story). Each
  // side type-checks on its own, so only this exact-text pin sees drift: a
  // change to the rule fails here until both spellings move together.
  it('is mirrored verbatim by @guren/inertia-client components.tsx', async () => {
    const componentsSource = await readFile(
      join(import.meta.dir, '../../inertia-client/src/components.tsx'),
      'utf8',
    )

    expect(componentsSource).toContain(PATH_PARAM_TYPE_HELPERS)
  })
})
