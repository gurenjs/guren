/**
 * Memoizes an async factory so concurrent callers share one in-flight promise:
 * a resolved result stays memoized until `reset()`, a rejection does not, so
 * the next caller retries. Error shaping stays in the factory — wrapping a
 * migration failure needs per-attempt state (the endpoint resolved partway
 * through), and a mapper out here would read the *latest* attempt's.
 */
export interface SingleFlight<T> {
  /** Runs the factory, or returns the promise an earlier call memoized. */
  get(): Promise<T>
  /** Drops the memoized promise so the next `get()` runs the factory again. */
  reset(): void
}

export function singleFlight<T>(factory: () => Promise<T>): SingleFlight<T> {
  // Closure state, not instance fields: call sites hand these methods out by
  // reference (`migrateDatabase: migrations.get`), losing a `this` binding.
  let inFlight: Promise<T> | undefined

  function get(): Promise<T> {
    if (inFlight) {
      return inFlight
    }

    const attempt = factory().catch((error) => {
      // A late rejection from an attempt `reset()` already superseded must
      // not evict the newer one.
      if (inFlight === attempt) {
        inFlight = undefined
      }
      throw error
    })

    inFlight = attempt
    return attempt
  }

  function reset(): void {
    inFlight = undefined
  }

  return { get, reset }
}
