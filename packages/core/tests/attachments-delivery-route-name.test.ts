import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as core from '../src/index'
import { DEFAULT_DELIVERY_ROUTE_NAME } from '../src/attachments/engine'
import { blankComments } from './source-scan'

/**
 * The delivery route's default name is a cross-package contract: `guren check`
 * asks from @guren/cli whether it collides with an app route, and
 * `Router.name()` silently overwrites duplicates. A restated copy there would
 * stop matching when the default moves and report a real collision as fine.
 * These tests make the single source structural. `DEFAULT_DELIVERY_PREFIX` is
 * deliberately not exported alongside it: a name in core's allowlist is a
 * semver commitment, and nothing outside this package names a delivery URL.
 */
describe('attachment delivery route name default', () => {
  it('is reachable from the @guren/core surface', () => {
    // Core's barrel is an allowlist, not `export *`, so a name missing from it
    // is unreachable however it is exported below.
    expect(core.DEFAULT_DELIVERY_ROUTE_NAME).toBe(DEFAULT_DELIVERY_ROUTE_NAME)
  })

  it('is the only spelling of the route name in the engine', async () => {
    const path = fileURLToPath(new URL('../src/attachments/engine.ts', import.meta.url))
    // Comments first: engine.ts's own prose quotes `'attachments.show'` while
    // documenting the default, and a scan that read it would fail on itself.
    const code = blankComments(await readFile(path, 'utf8'))

    // Nothing at runtime distinguishes a name read from the constant from one
    // re-typed as a literal, so the source form is what is pinned.
    const declaration = `export const DEFAULT_DELIVERY_ROUTE_NAME = '${DEFAULT_DELIVERY_ROUTE_NAME}'`
    expect(code).toContain(declaration)
    for (const quote of ["'", '"']) {
      expect(code.replace(declaration, '')).not.toContain(
        `${quote}${DEFAULT_DELIVERY_ROUTE_NAME}${quote}`,
      )
    }
  })
})
