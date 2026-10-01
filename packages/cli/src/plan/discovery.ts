import { FileDiscoveryError, toPosixRelative } from '../discovery'
import type { PlanAppUnreadable } from './unreadable'

/** A missing section is empty; an unreadable one cannot settle a plan reference. */
export async function discoverSectionFiles<T>(
  cwd: string,
  discover: (root: string) => Promise<T>,
): Promise<T | PlanAppUnreadable> {
  try {
    return await discover(cwd)
  } catch (error) {
    if (!(error instanceof FileDiscoveryError)) throw error
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    return { unreadable: `${toPosixRelative(cwd, error.directory)} would not open (${cause})` }
  }
}
