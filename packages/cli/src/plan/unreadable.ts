/** A section a reader could not read, and the guard for it: a leaf so `app-state.ts` and its readers share one without a cycle. */

/** A section the scanners could not read, carrying why. */
export interface PlanAppUnreadable {
  unreadable: string
}

export function isUnreadable<T>(section: readonly T[] | PlanAppUnreadable): section is PlanAppUnreadable {
  return !Array.isArray(section)
}
