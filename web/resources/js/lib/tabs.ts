const ARROW_STEPS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** The tab an arrow key moves to, wrapping at both ends as the ARIA tabs pattern expects; undefined for other keys. */
export function tabAfterKey<T>(tabs: readonly T[], active: T, key: string): T | undefined {
  const step = ARROW_STEPS[key]
  if (!step) return undefined
  return tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]
}
