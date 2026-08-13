import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PATH_PARAM_TYPE_HELPERS } from '../src/routes-types-fragments'

describe('PATH_PARAM_TYPE_HELPERS', () => {
  // @guren/inertia-client ships as a library, so it cannot embed the emitted
  // fragment — it carries a hand-written mirror instead. Nothing at compile
  // time can see the two drift apart (each side type-checks on its own), so
  // the mirror is pinned to the fragment's exact text: a change to the rule
  // fails here until both spellings move together.
  it('is mirrored verbatim by @guren/inertia-client components.tsx', async () => {
    const componentsSource = await readFile(
      join(import.meta.dir, '../../inertia-client/src/components.tsx'),
      'utf8',
    )

    expect(componentsSource).toContain(PATH_PARAM_TYPE_HELPERS)
  })
})
