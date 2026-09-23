// Preloaded first into `bun test --isolate` (scripts/test-packages.ts): on Bun
// 1.4.x the global FinalizationRegistry becomes one that registers nothing, so
// no cleanup ticket is ever queued. JSC hands a cleanup to Bun as a
// DeferredWorkTimer ticket and 1.4.0-1.4.2 run it after the file that made the
// registry is retired: "Unhandled error between tests" (oven-sh/bun#42110), or a
// freed registry once its global is collected, SIGSEGV at 0x70 (oven-sh/bun#39994,
// oven-sh/WebKit#487; gurenjs/guren#969). Bun's builtins resolve the name through
// the global (measured on 1.4.2). Delete once CI's Bun floor carries both fixes.

/** Bun 1.3.14 did not hit either face across the same suite; only 1.4.x gets the stub. */
export function needsInertRegistry(version: string): boolean {
  return Bun.semver.satisfies(version, '>=1.4.0')
}

/**
 * The FinalizationRegistry surface without the native registry behind it. A
 * cleanup callback only ever released memory (wasm-bindgen frees, Bun's own
 * FileHandle fds), which a test process gives back at exit anyway.
 */
export class InertFinalizationRegistry<T = unknown> {
  constructor(cleanup: (heldValue: T) => void) {
    if (typeof cleanup !== 'function') {
      throw new TypeError('FinalizationRegistry: cleanup must be callable')
    }
  }

  register(_target: WeakKey, _heldValue: T, _unregisterToken?: WeakKey): void {}

  unregister(_unregisterToken: WeakKey): boolean {
    return false
  }

  get [Symbol.toStringTag](): string {
    return 'FinalizationRegistry'
  }
}

if (needsInertRegistry(Bun.version)) {
  Object.defineProperty(globalThis, 'FinalizationRegistry', {
    value: InertFinalizationRegistry,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}
