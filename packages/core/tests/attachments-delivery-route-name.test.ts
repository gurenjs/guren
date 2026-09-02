import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as core from '../src/index'
import { DEFAULT_DELIVERY_ROUTE_NAME } from '../src/attachments/engine'
import { blankComments } from './source-scan'

/**
 * The delivery route's default name is a cross-package contract, not an engine
 * detail. `guren check`'s attachments rules judge, from @guren/cli, whether
 * the name the delivery route registers under collides with an app route —
 * `Router.name()` silently overwrites duplicates, so a collision resolves
 * route() lookups and typed links to whichever registered last. To ask that
 * question the rule has to name the same route name the engine applies.
 *
 * A restated copy over there does not fail loudly when the default moves: it
 * stops matching the route that was actually registered, finds one claim
 * instead of two, and reports a genuine collision as fine. A warning failing
 * *open*, with nothing going red anywhere.
 *
 * These two tests are what make the single source structural: the constant
 * must stay reachable as `@guren/core` so a rule over there can import it
 * rather than restate it, and the engine may not re-hardcode it.
 *
 * `DEFAULT_DELIVERY_PREFIX` is deliberately not exported alongside it. It is
 * the other value `resolveDeliveryRoute()` defaults, but no rule outside this
 * package names a delivery URL today, and a name in core's allowlist is a
 * semver commitment — it goes out when something over there needs it.
 */
describe('attachment delivery route name default', () => {
  it('is reachable from the @guren/core surface', () => {
    // Core's barrel is an allowlist for these names, not `export *`, so a
    // name missing from it is unreachable however it is exported below.
    // The CLI's attachments check already imports AttachmentDeliveryController
    // through this same channel.
    expect(core.DEFAULT_DELIVERY_ROUTE_NAME).toBe(DEFAULT_DELIVERY_ROUTE_NAME)
  })

  it('is the only spelling of the route name in the engine', async () => {
    const path = fileURLToPath(new URL('../src/attachments/engine.ts', import.meta.url))
    // Comments first: the surrounding prose quotes `'attachments.show'` while
    // documenting the default, and a scan that read it would fail on itself.
    const code = blankComments(await readFile(path, 'utf8'))

    // Nothing at runtime distinguishes a name read from the constant from one
    // re-typed as a literal — same reason the MCP endpoint gate pins the
    // source form of `process.env.NODE_ENV`. So the form is what is pinned.
    const declaration = `export const DEFAULT_DELIVERY_ROUTE_NAME = '${DEFAULT_DELIVERY_ROUTE_NAME}'`
    expect(code).toContain(declaration)
    for (const quote of ["'", '"']) {
      expect(code.replace(declaration, '')).not.toContain(
        `${quote}${DEFAULT_DELIVERY_ROUTE_NAME}${quote}`,
      )
    }
  })
})
