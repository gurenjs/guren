/**
 * Unset a per-process global manager. The setters take a manager, so clearing
 * one is a cast; every test file in the process shares these globals, so a case
 * that asserts the unset state has to clear rather than assume no other file
 * booted a provider.
 */
export function clearGlobalManager<T>(set: (manager: T) => void): void {
  set(undefined as unknown as T)
}
