import { resolveInertiaPageFile } from './inertia-pages'

export interface PageSourceReading {
  id: string
  file: string | undefined
}

/** Retain duplicate IDs and extension priority; resolution failures propagate instead of implying absence. */
export function readPageSources(root: string, ids: readonly string[]): Promise<PageSourceReading[]> {
  return Promise.all(ids.map(async (id) => ({ id, file: await resolveInertiaPageFile(root, id) })))
}
