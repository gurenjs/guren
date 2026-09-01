import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as core from '../src/index'
import { ATTACHMENT_OBJECT_PREFIX } from '../src/attachments/engine'
import { blankComments } from './source-scan'

/**
 * The object-key prefix is a cross-package contract, not an engine detail.
 * `guren check`'s attachments rules judge, from another package, whether
 * uploaded bytes land somewhere the app serves statically, and the ones that
 * reach the objects themselves have to name `<disk root>/attachments` to do
 * it. A restated copy of the prefix over there does not fail loudly when the
 * layout moves (a shard level, a rename) — it stops matching, answers "not
 * reachable", and reports an exposed app as safe. A build-failing security
 * rule failing *open*, with nothing going red anywhere.
 *
 * These two tests are what make the single source structural: the engine may
 * not re-hardcode the prefix, and the constant must stay reachable as
 * `@guren/core` so a rule over there can import it rather than restate it.
 */
describe('attachment object key prefix', () => {
  it('is reachable from the @guren/core surface', () => {
    // Core's barrel is an allowlist for these names, not `export *`, so a
    // name missing from it is unreachable however it is exported below.
    // The CLI's attachments check already imports AttachmentDeliveryController
    // through this same channel.
    expect(core.ATTACHMENT_OBJECT_PREFIX).toBe(ATTACHMENT_OBJECT_PREFIX)
  })

  it('is the only spelling of the prefix in the engine', async () => {
    const path = fileURLToPath(new URL('../src/attachments/engine.ts', import.meta.url))
    // Comments first: the surrounding prose names `attachments/` repeatedly
    // without building a key, and a scan that reads it would fail on itself.
    const code = blankComments(await readFile(path, 'utf8'))

    // Nothing at runtime distinguishes a key built from the constant from one
    // built from a re-typed literal — same reason the MCP endpoint gate pins
    // the source form of `process.env.NODE_ENV`. So the form is what is
    // pinned: the key templates, and the bare argument `directories()` takes.
    expect(code).not.toContain(`\`${ATTACHMENT_OBJECT_PREFIX}/`)

    const declaration = `export const ATTACHMENT_OBJECT_PREFIX = '${ATTACHMENT_OBJECT_PREFIX}'`
    expect(code).toContain(declaration)
    // `'attachments.show'` and `'/attachments'` are different strings and stay
    // out of this deliberately: they are a route name and a URL prefix.
    for (const quote of ["'", '"']) {
      expect(code.replace(declaration, '')).not.toContain(
        `${quote}${ATTACHMENT_OBJECT_PREFIX}${quote}`,
      )
    }
  })
})
