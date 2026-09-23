import type { DriverMapEntry } from './types'

/** `DriverMapEntry` from a manager's entry names, with the driver each was configured with where known. */
export function describeDriverMap(
  defaultName: string,
  names: Iterable<string>,
  driverOf: (name: string) => string | null | undefined = () => null,
): DriverMapEntry {
  const entries: DriverMapEntry['entries'] = {}
  for (const name of names) entries[name] = { driver: driverOf(name) ?? null }
  return { default: defaultName, entries }
}
