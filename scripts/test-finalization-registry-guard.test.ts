import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { InertFinalizationRegistry, needsInertRegistry } from './test-finalization-registry-guard.ts'

describe('test-finalization-registry-guard', () => {
  describe('needsInertRegistry', () => {
    it('leaves Bun 1.3.14 alone', () => {
      expect(needsInertRegistry('1.3.14')).toBe(false)
    })

    it('covers the 1.4.x line the two upstream faces were reported on', () => {
      expect(needsInertRegistry('1.4.0')).toBe(true)
      expect(needsInertRegistry('1.4.2')).toBe(true)
    })

    // The crash face (oven-sh/bun#39994) is open upstream, so a release after
    // 1.4.2 is not evidence of a fix; the floor is lifted by hand, not by version.
    it('stays on for releases after 1.4.2 until the file is deleted', () => {
      expect(needsInertRegistry('1.4.3')).toBe(true)
      expect(needsInertRegistry('1.5.0')).toBe(true)
    })
  })

  describe('InertFinalizationRegistry', () => {
    it('accepts the native register and unregister calls and holds nothing', () => {
      const registry = new InertFinalizationRegistry<number>(() => {})
      const token = {}
      expect(registry.register({}, 1, token)).toBeUndefined()
      expect(registry.unregister(token)).toBe(false)
      expect(Object.prototype.toString.call(registry)).toBe('[object FinalizationRegistry]')
    })

    it('rejects a non-callable cleanup, as the native constructor does', () => {
      expect(() => new InertFinalizationRegistry(1 as never)).toThrow(TypeError)
    })
  })

  it('is the first preload test:bun passes, so no earlier preload can create a native registry', () => {
    const runner = readFileSync(new URL('./test-packages.ts', import.meta.url), 'utf8')
    expect(runner).toContain("join(import.meta.dir, 'test-finalization-registry-guard.ts')")
    const preloads = [...runner.matchAll(/'--preload',\s*\n\s*(\w+),/g)].map((match) => match[1])
    expect(preloads[0]).toBe('finalizationRegistryGuard')
  })

  it('installs the inert registry on this Bun exactly when the predicate says so', () => {
    // Importing the module above ran its install step in this file's global.
    expect(globalThis.FinalizationRegistry === (InertFinalizationRegistry as unknown)).toBe(
      needsInertRegistry(Bun.version),
    )
  })
})
