import type { DriverMapEntry } from './types'

/** `DriverMapEntry` from a manager's entries, each with the driver it was configured with or null. */
export function describeDriverMap(
  defaultName: string,
  drivers: Iterable<[string, string | null]>,
  bindings: ReadonlyMap<string, string> = new Map(),
): DriverMapEntry {
  const entries: DriverMapEntry['entries'] = {}
  for (const [name, driver] of drivers) {
    const binding = bindings.get(name)
    entries[name] = binding === undefined ? { driver } : { driver, binding }
  }
  return { default: defaultName, entries }
}
