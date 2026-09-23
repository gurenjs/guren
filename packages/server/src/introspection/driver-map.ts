import type { DriverMapEntry } from './types'

/** `DriverMapEntry` from a manager's entries, each with the driver it was configured with or null. */
export function describeDriverMap(defaultName: string, drivers: Iterable<[string, string | null]>): DriverMapEntry {
  const entries: DriverMapEntry['entries'] = {}
  for (const [name, driver] of drivers) entries[name] = { driver }
  return { default: defaultName, entries }
}
