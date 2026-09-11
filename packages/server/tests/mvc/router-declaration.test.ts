import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the built declaration', () => {
  // `in M` is what rejects a router missing an alias a registrar reads. The
  // source fixture cannot see it lost in emit, and an app only ever reads the
  // built .d.ts, so a bundler dropping the annotation would go unnoticed.
  test('should carry the contravariance annotation on Router and RouteBuilder', () => {
    const declaration = join(import.meta.dir, '../../dist/mvc/Router.d.ts')
    if (!existsSync(declaration)) {
      throw new Error(`Expected ${declaration}; run \`bun run build server\` before this test.`)
    }

    const source = readFileSync(declaration, 'utf8')
    expect(source).toMatch(/declare class Router<in M extends string = never>/)
    expect(source).toMatch(/interface RouteBuilder<in M extends string = never>/)
  })
})
