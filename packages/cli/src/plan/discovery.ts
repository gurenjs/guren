import { FileDiscoveryError, toPosixRelative } from '../discovery'
import type { PlanAppUnreadable } from './unreadable'

/** A missing section is empty; an unreadable one cannot settle a plan reference. */
export async function discoverPlanFiles(
  cwd: string,
  discover: (root: string) => Promise<string[]>,
): Promise<string[] | PlanAppUnreadable> {
  try {
    return await discover(cwd)
  } catch (error) {
    if (!(error instanceof FileDiscoveryError)) throw error
    return { unreadable: `${toPosixRelative(cwd, error.directory)} would not open (${error.message})` }
  }
}
