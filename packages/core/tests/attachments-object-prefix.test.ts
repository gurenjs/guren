import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as core from '../src/index'
import { ATTACHMENT_OBJECT_PREFIX, ATTACHMENTS_SERVICE_KEY } from '../src/attachments/engine'
import { blankComments } from './source-scan'

/**
 * The object-key prefix is a cross-package contract: `guren check`'s attachments
 * rules name `<disk root>/attachments` from another package to judge whether
 * uploaded bytes land somewhere the app serves statically. A restated copy there
 * would stop matching when the layout moves and report an exposed app as safe,
 * a security rule failing *open*. These tests make the single source structural.
 */
describe('attachment object key prefix', () => {
  it('is reachable from the @guren/core surface', () => {
    // Core's barrel is an allowlist, not `export *`, so a name missing from it
    // is unreachable however it is exported below.
    expect(core.ATTACHMENT_OBJECT_PREFIX).toBe(ATTACHMENT_OBJECT_PREFIX)
  })

  it('is the only spelling of the prefix in the engine', async () => {
    const path = fileURLToPath(new URL('../src/attachments/engine.ts', import.meta.url))
    // Comments first: engine.ts's own prose names `attachments/` without
    // building a key, and a scan that read it would fail on itself.
    const code = blankComments(await readFile(path, 'utf8'))

    // Nothing at runtime distinguishes a key built from the constant from one
    // built from a re-typed literal, so the source form is what is pinned.
    expect(code).not.toContain(`\`${ATTACHMENT_OBJECT_PREFIX}/`)

    const declaration = `export const ATTACHMENT_OBJECT_PREFIX = '${ATTACHMENT_OBJECT_PREFIX}'`
    // The container key spells the same word for an unrelated contract, so it
    // has its own constant and is stripped alongside the prefix's.
    const serviceKey = `export const ATTACHMENTS_SERVICE_KEY = '${ATTACHMENTS_SERVICE_KEY}'`
    expect(code).toContain(declaration)
    expect(code).toContain(serviceKey)
    // `'attachments.show'` and `'/attachments'` stay out: a route name and a URL
    // prefix, not object keys.
    const rest = code.replace(declaration, '').replace(serviceKey, '')
    for (const quote of ["'", '"']) {
      expect(rest).not.toContain(`${quote}${ATTACHMENT_OBJECT_PREFIX}${quote}`)
    }
  })
})
