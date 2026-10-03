import { classNameFromPath, excludeBarrelFiles, moduleNameFor, toPosixRelative } from './discovery'

export interface SourceClassIdentity {
  className: string
  module: string | null
  /** POSIX path relative to the application root. */
  file: string
}

/**
 * Filename-based identities for Policy, Resource and other convention-named sections.
 * Discovery errors propagate; parse support and partial-read policy belong to callers.
 * Preserve discovery order and source twins: approval facts must not silently change.
 */
export async function readSourceClassIdentities(
  cwd: string,
  discover: (appRoot: string) => Promise<string[]>,
): Promise<SourceClassIdentity[]> {
  return sourceClassIdentities(cwd, await discover(cwd))
}

export function sourceClassIdentities(cwd: string, files: string[]): SourceClassIdentity[] {
  return excludeBarrelFiles(files).map((file) => ({
    className: classNameFromPath(file), module: moduleNameFor(cwd, file), file: toPosixRelative(cwd, file),
  }))
}
