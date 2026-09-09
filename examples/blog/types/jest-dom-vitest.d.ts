import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// jest-dom's own `/vitest` entry augments `Assertion<T>`, which vitest 5 renamed
// to `Assertion<R, T>`; the merge then fails silently and every matcher vanishes
// from `expect(...)`. Vitest 5's extension point is `Matchers<R, T>` (R is the
// return type: void, or Promise<void> under .resolves/.rejects). Drop this file
// once testing-library/jest-dom#738 ships.
declare module 'vitest' {
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
