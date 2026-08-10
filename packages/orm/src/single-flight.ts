/**
 * Memoizes an async factory so concurrent callers share one in-flight promise.
 *
 * Internal to @guren/orm — every driver factory needs the same three
 * behaviours for its connection and migration handles:
 *
 * - concurrent callers await the same promise (one connection, one migration run)
 * - a resolved result stays memoized until it is explicitly invalidated
 * - a rejection is *not* memoized, so the next caller retries
 *
 * `reset()` covers the invalidation the drivers do from outside the failure
 * path: `closeDatabase()` drops the connection handle, `resetDatabase()` drops
 * the migration handle so migrations can be re-applied from scratch.
 *
 * Error shaping stays in the factory. The drivers that wrap a migration failure
 * need per-attempt state to do it (the endpoint resolved partway through), and
 * a mapper living out here would read whatever the *latest* attempt left behind.
 */
export interface SingleFlight<T> {
  /** Runs the factory, or returns the promise an earlier call memoized. */
  get(): Promise<T>
  /** Drops the memoized promise so the next `get()` runs the factory again. */
  reset(): void
}

export function singleFlight<T>(factory: () => Promise<T>): SingleFlight<T> {
  // Closure state rather than instance fields: call sites hand these methods
  // out by reference (`migrateDatabase: migrations.get`), which would lose a
  // `this` binding.
  let inFlight: Promise<T> | undefined

  function get(): Promise<T> {
    if (inFlight) {
      return inFlight
    }

    const attempt = factory().catch((error) => {
      // Only clear when the cell still holds *this* attempt. A late rejection
      // from an attempt that `reset()` already superseded must not evict the
      // newer one.
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
